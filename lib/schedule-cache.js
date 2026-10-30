/**
 * schedule-cache.js — shared full-day schedule warming (main-next)
 *
 * WHY THIS EXISTS
 * Timetables are effectively static: agencies publish one schedule per DAY TYPE
 * (Monday–Friday / Saturday / Sunday) and it stays valid for months — e.g. KCM's
 * current book is "Effective 8/29/2026 through 3/26/2027". So fetch a full-day
 * schedule ONCE per day type, store it, and reuse it for the rest of the period.
 * That gives every page a real scheduled-time fallback for when the live API
 * fails, rate-limits, or returns nothing (e.g. overnight).
 *
 * TWO WARMING SHAPES — pick by what the page actually needs
 *
 *   ensureStops(stopIds)  ← stop-centric. USE THIS FOR THE HOME PAGE.
 *     One `schedule-for-stop` call returns the full day for EVERY route serving
 *     that stop (measured: 1 call at stop 1_2672 = 6 routes, 285 times). Home
 *     only needs the handful of nearby stops, so ~15 calls covers every nearby
 *     route.
 *
 *   ensure(routeId)       ← route-centric. USE THIS FOR THE DETAIL PAGE.
 *     Needs the whole line end-to-end, so it costs one call per stop on the
 *     route (median 54 stops => 54 calls, staggered). Only worth it for the one
 *     route the user actually opened.
 *
 *   Why the split matters: warming 16 nearby routes route-centrically measured
 *   ~864 calls / ~12 min of staggered fetching. Stop-centric does the same job
 *   for home in ~15 calls. Do not use ensure() to warm a nearby list.
 *
 * FRESHNESS is owned by TransitStore: keyed per route per dayType with
 * `scheduleFetchedAt`, stale past the 90-day TTL or if fetched before the most
 * recent service change (SERVICE_CHANGE_DATES). See transit-store.js.
 *
 * NOTE on the full-warm registry: TransitStore.saveSchedule() stamps
 * scheduleFetchedAt for the whole route even when we only wrote a few stops.
 * So stop-centric warming would otherwise make hasSchedule() report "warm" and
 * cause the detail page to skip its full-route fetch and render a mostly-empty
 * timetable. To prevent that, full-route warms are recorded separately here and
 * ensure() checks that registry — stop-centric writes never satisfy it.
 *
 * Depends on globals: TransitAPI, TransitStore, getDayType() (transit-logic).
 */

const ScheduleCache = (function () {
  'use strict';

  // Route-centric warming issues one request per stop, so keep it narrow.
  const MAX_CONCURRENT_ROUTES = 2;
  // Stop-centric warming is one request per stop. Measured: 4-way parallelism
  // got a stop dropped by the API, so stay at 2 with a small stagger.
  const MAX_CONCURRENT_STOPS = 2;
  const STOP_STAGGER_MS = 150;
  // A dropped request is usually transient (rate limiting), so allow one retry
  // before giving up on a stop for the session.
  const MAX_STOP_ATTEMPTS = 2;

  const WARM_KEY = 'mn.schedule.warm.v1';   // { "full:routeId|dayType": ts, "stop:stopId|dayType": ts }

  // In-flight promises, so concurrent callers share one fetch.
  const _inflightRoute = new Map();   // routeId|dayType -> Promise
  const _inflightStop = new Map();    // stopId|dayType  -> Promise
  // Failures this session — don't hammer something that keeps failing.
  const _failed = new Set();
  const _attempts = new Map();        // stopId|dayType -> tries

  function _dayType() {
    return (typeof getDayType === 'function') ? getDayType() : 'weekday';
  }

  // ---- warm registry (see NOTE in the header) ------------------------------
  // Persisted so warming survives reloads — otherwise every page load would
  // re-fetch every nearby stop, defeating "fetch once per day type".

  function _loadWarm() {
    try { return JSON.parse(localStorage.getItem(WARM_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function _mark(kind, id, dayType) {
    try {
      const m = _loadWarm();
      m[kind + ':' + id + '|' + dayType] = Date.now();
      localStorage.setItem(WARM_KEY, JSON.stringify(m));
    } catch (e) { /* non-fatal */ }
  }
  /** Same staleness rule the store uses: within TTL and after the last service change. */
  function _isWarm(kind, id, dayType) {
    const ts = _loadWarm()[kind + ':' + id + '|' + dayType];
    if (!ts) return false;
    try {
      if (Date.now() - ts > TransitStore.scheduleTtlMs()) return false;
      if (ts < TransitStore.lastEffectiveServiceChange()) return false;
    } catch (e) { /* older store without these helpers — fall through */ }
    return true;
  }
  function _isFullWarm(routeId, dayType) {
    // Defer to the store too, so a cleared store forces a refetch.
    return hasStored(routeId, dayType) && _isWarm('full', routeId, dayType);
  }

  /** Does the store hold *any* fresh schedule for this route + day type? */
  function hasStored(routeId, dayType) {
    if (typeof TransitStore === 'undefined') return false;
    try { return TransitStore.hasSchedule(routeId, dayType || _dayType()); }
    catch (e) { return false; }
  }

  /** Has the FULL route been warmed (what the detail page needs)? */
  function has(routeId, dayType) {
    return _isFullWarm(routeId, dayType || _dayType());
  }

  // ---- route-centric (detail page) -----------------------------------------

  /**
   * Ensure this route's ENTIRE schedule is cached for the current day type.
   * Costs ~one API call per stop on the route — only call this for a route the
   * user has actually opened. No-ops when already warm.
   * @returns {Promise<boolean>} true if a full schedule is available afterwards
   */
  function ensure(routeId) {
    if (!routeId || typeof TransitStore === 'undefined') return Promise.resolve(false);
    const dayType = _dayType();
    const key = routeId + '|' + dayType;

    if (_isFullWarm(routeId, dayType)) return Promise.resolve(true);
    if (_failed.has('r:' + key)) return Promise.resolve(false);
    if (_inflightRoute.has(key)) return _inflightRoute.get(key);

    const p = (async () => {
      try {
        const entry = TransitStore.getRoute(routeId);
        if (!entry || !entry.directions || !entry.directions.length) return false;

        // { directionName: { stopId: [ms, ...] } }, matched to store dir names.
        const byDir = await TransitAPI.fetchRouteSchedule(entry.directions);
        const any = byDir && Object.keys(byDir).some(
          d => byDir[d] && Object.keys(byDir[d]).length > 0
        );
        if (!any) { _failed.add('r:' + key); return false; }

        TransitStore.saveSchedule(routeId, dayType, byDir);
        _mark('full', routeId, dayType);
        return true;
      } catch (e) {
        _failed.add('r:' + key);
        return false;
      } finally {
        _inflightRoute.delete(key);
      }
    })();

    _inflightRoute.set(key, p);
    return p;
  }

  /** Warm several ENTIRE routes (bounded concurrency). Rarely what you want —
   *  prefer ensureStops() for a nearby list. */
  async function ensureMany(routeIds) {
    const ids = [...new Set((routeIds || []).filter(Boolean))];
    const dayType = _dayType();
    const todo = ids.filter(id => !_isFullWarm(id, dayType) && !_failed.has('r:' + id + '|' + dayType));
    const skipped = ids.length - todo.length;
    let warmed = 0, failed = 0, cursor = 0;

    async function worker() {
      while (cursor < todo.length) {
        const ok = await ensure(todo[cursor++]);
        if (ok) warmed++; else failed++;
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(MAX_CONCURRENT_ROUTES, todo.length) }, worker
    ));
    return { warmed, skipped, failed };
  }

  // ---- stop-centric (home page) -------------------------------------------

  /**
   * Warm one stop: fetches its full-day schedule and stores times for EVERY
   * route serving it. Cheap and high-yield — this is the home-page path.
   * @returns {Promise<number>} number of routes written
   */
  function ensureStop(stopId) {
    if (!stopId || typeof TransitStore === 'undefined') return Promise.resolve(0);
    const dayType = _dayType();
    const key = stopId + '|' + dayType;

    // Already warmed this stop for this day type (persisted across reloads).
    if (_isWarm('stop', stopId, dayType)) return Promise.resolve(0);
    if (_failed.has('s:' + key)) return Promise.resolve(0);
    if (_inflightStop.has(key)) return _inflightStop.get(key);

    const p = (async () => {
      const tries = (_attempts.get(key) || 0) + 1;
      _attempts.set(key, tries);
      try {
        const j = await TransitAPI.fetchScheduleForStop(stopId);
        const entry = (j && j.data && j.data.entry) || {};
        const schedules = entry.stopRouteSchedules || [];
        if (!schedules.length) {
          // Empty can be transient (rate limit) — only give up after a retry.
          if (tries >= MAX_STOP_ATTEMPTS) _failed.add('s:' + key);
          return 0;
        }

        let written = 0;
        for (const sr of schedules) {
          const routeId = sr.routeId;
          // Only store routes we actually know about (present in routes-data).
          if (!routeId || !TransitStore.getRoute(routeId)) continue;

          // Merge all of this route's direction schedules AT THIS STOP, bucketed
          // by the store's own direction name so lookups line up later.
          const byDir = {};
          for (const dir of (sr.stopRouteDirectionSchedules || [])) {
            const times = (dir.scheduleStopTimes || [])
              .map(t => t.arrivalTime || t.departureTime)
              .filter(Boolean);
            if (!times.length) continue;

            const dirName = _storeDirName(routeId, dir.tripHeadsign);
            if (!dirName) continue;
            if (!byDir[dirName]) byDir[dirName] = {};
            const prev = byDir[dirName][stopId] || [];
            byDir[dirName][stopId] = [...new Set(prev.concat(times))].sort((a, b) => a - b);
          }
          if (Object.keys(byDir).length) {
            // saveSchedule merges per direction, so repeated per-stop calls
            // accumulate instead of overwriting.
            TransitStore.saveSchedule(routeId, dayType, byDir);
            written++;
          }
        }
        // Only record the stop as warm once it actually produced data.
        if (written) _mark('stop', stopId, dayType);
        return written;
      } catch (e) {
        if (tries >= MAX_STOP_ATTEMPTS) _failed.add('s:' + key);
        return 0;
      } finally {
        _inflightStop.delete(key);
      }
    })();

    _inflightStop.set(key, p);
    return p;
  }

  /**
   * Warm a set of stops (the nearby ones). This is what the home page should
   * call — ~one request per stop, covering every route at those stops.
   * @returns {Promise<{stops:number, routesWritten:number}>}
   */
  async function ensureStops(stopIds) {
    const ids = [...new Set((stopIds || []).filter(Boolean))];
    const dayType = _dayType();
    const todo = ids.filter(id =>
      !_isWarm('stop', id, dayType) && !_failed.has('s:' + id + '|' + dayType)
    );
    const skipped = ids.length - todo.length;
    let cursor = 0;

    // Each worker keeps its OWN tally and we sum at the end — `x += await ...`
    // across concurrent workers loses updates (read-modify-write race).
    async function worker(slot) {
      let written = 0;
      // Stagger worker starts so we don't fire simultaneous requests.
      if (slot) await new Promise(r => setTimeout(r, slot * STOP_STAGGER_MS));
      while (cursor < todo.length) {
        written += await ensureStop(todo[cursor++]);
      }
      return written;
    }
    const n = Math.min(MAX_CONCURRENT_STOPS, todo.length);
    const tallies = await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));
    const routesWritten = tallies.reduce((a, b) => a + b, 0);

    // One retry pass for stops that came back empty but aren't permanently
    // failed — covers transient rate limiting.
    const retry = todo.filter(id =>
      !_isWarm('stop', id, dayType) && !_failed.has('s:' + id + '|' + dayType)
    );
    let retried = 0;
    for (const id of retry) {
      await new Promise(r => setTimeout(r, STOP_STAGGER_MS));
      retried += await ensureStop(id);
    }

    return { stops: todo.length, skipped, routesWritten: routesWritten + retried };
  }

  /** Map an API tripHeadsign onto the store's direction name for that route. */
  function _storeDirName(routeId, headsign) {
    try {
      const dir = TransitStore.getDirection(routeId, headsign);
      return (dir && dir.name) ? dir.name : '';
    } catch (e) { return ''; }
  }

  // ---- reads ---------------------------------------------------------------

  /** Cached scheduled times (ms) for a stop on a given direction. */
  function getStopTimes(routeId, directionName, stopId, dayType) {
    if (typeof TransitStore === 'undefined') return [];
    try {
      return TransitStore.getScheduleForStop(
        routeId, directionName, stopId, dayType || _dayType()
      ) || [];
    } catch (e) { return []; }
  }

  /** Upcoming cached times for a stop across all directions of a route. */
  function getUpcomingForStop(routeId, stopId, limit) {
    if (typeof TransitStore === 'undefined') return [];
    try {
      const times = TransitStore.getUpcomingTimesForStop(routeId, stopId, _dayType()) || [];
      return times.slice(0, limit || 3);
    } catch (e) { return []; }
  }

  return {
    // route-centric (detail)
    ensure, ensureMany, has,
    // stop-centric (home)
    ensureStop, ensureStops,
    // reads / misc
    hasStored, getStopTimes, getUpcomingForStop, dayType: _dayType,
  };
})();
