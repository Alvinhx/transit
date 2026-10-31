/**
 * transit-store.js — Data layer for NextUp Transit
 *
 * Two stores:
 *
 * 1. TransitStore — static route data (shape, stops, per-stop schedule for all day types).
 *    Persisted to localStorage. Loaded once per route, never re-fetched unless
 *    a service alert invalidates it or schedule is stale (>90 days).
 *    Keyed by routeId.
 *
 *    Structure per route:
 *    {
 *      fetchedAt: <timestamp>,
 *      scheduleFetchedAt: { weekday: <ts>, saturday: <ts>, sunday: <ts> },
 *      directions: [
 *        {
 *          name: "Seattle Center",
 *          stopIds: ["1_11180", ...],
 *          stops: { "1_11180": { name, lat, lon }, ... },
 *          polyline: "encoded...",
 *          schedule: {
 *            weekday:  { "1_11180": [ms, ms, ...], ... },
 *            saturday: { "1_11180": [ms, ...], ... },
 *            sunday:   { "1_11180": [ms, ...], ... }
 *          }
 *        },
 *        { name: "Mt Baker", ... }
 *      ]
 *    }
 *
 * 2. LiveCache — in-memory ETA data for the current session.
 *    Wraps home.js's routeCache with a clean read API.
 *
 * Depends on: transit-logic.js (getDayType)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSIT STORE — static route data
// ═══════════════════════════════════════════════════════════════════════════════

const TransitStore = (function () {
  'use strict';

  const STORE_KEY = 'nextup_transit_store';
  // Schedule expires after 90 days — a backstop for gradual drift.
  const SCHEDULE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  /**
   * SERVICE CHANGE CUTOFFS (main-next addition)
   *
   * The 90-day TTL alone is NOT enough. Agencies change timetables on known
   * dates ("service changes"), and a schedule cached the day before a change
   * stays "fresh" for up to 90 more days — serving the OLD timetable. This list
   * makes any schedule cached BEFORE a cutoff count as stale, so it re-fetches
   * on the first use after the change takes effect.
   *
   * Add a new entry each time an agency publishes a service change date.
   * Dates are local-time ISO strings; keep newest last.
   *   - 2026-08-29: Sound Transit / KCM / CT fall service change.
   */
  const SERVICE_CHANGE_DATES = [
    '2026-08-29T00:00:00',
  ];

  // Most recent cutoff that has already taken effect (ms), or 0 if none yet.
  function _lastEffectiveServiceChange(now) {
    const t = (now === undefined) ? Date.now() : now;
    let latest = 0;
    for (const iso of SERVICE_CHANGE_DATES) {
      const ms = new Date(iso).getTime();
      if (!isNaN(ms) && ms <= t && ms > latest) latest = ms;
    }
    return latest;
  }

  /**
   * STORE SCHEMA VERSION (ported from v6's STORE_VERSION gate)
   *
   * Bump this string whenever the SHAPE of the cached store changes
   * incompatibly (fields renamed/restructured, routes-data.json format change).
   * On the next load, any user whose stored version differs gets the cached
   * store wiped once and re-seeded fresh. This covers what the other guards
   * can't: old data that is still valid JSON and still "fresh" by TTL, but
   * structurally outdated. (pruneStaleSchedules only handles timetable age;
   * the parse try/catch only handles corrupt JSON.)
   *
   * Shares v6's storage key. v6 used 'v4'; v7 starts at 'v5', so v6 → v7 users
   * get one clean re-seed (cheap: shapes come from routes-data.json, schedules
   * re-warm lazily).
   */
  const STORE_VERSION = 'v5';
  const STORE_VERSION_KEY = 'nextup_transit_store_version';

  function _enforceStoreVersion() {
    try {
      if (localStorage.getItem(STORE_VERSION_KEY) !== STORE_VERSION) {
        localStorage.removeItem(STORE_KEY);
        localStorage.setItem(STORE_VERSION_KEY, STORE_VERSION);
      }
    } catch (e) { /* storage unavailable — store runs in-memory only */ }
  }

  // In-memory cache — avoids repeated localStorage parses within a session
  let _mem = null;

  function _load() {
    if (_mem !== null) return _mem;
    _enforceStoreVersion();   // wipe an incompatible-schema store BEFORE reading it
    try {
      const raw = localStorage.getItem(STORE_KEY);
      _mem = raw ? JSON.parse(raw) : {};
    } catch (e) {
      _mem = {};
    }
    return _mem;
  }

  function _save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(_mem));
    } catch (e) {
      // localStorage full — clear old entries and retry
      try {
        localStorage.removeItem(STORE_KEY);
        localStorage.setItem(STORE_KEY, JSON.stringify(_mem));
      } catch (e2) {}
    }
  }

  // ─── Shape ──────────────────────────────────────────────────────────────────

  /**
   * Get stored route data. Returns null if not found.
   */
  function getRoute(routeId) {
    const store = _load();
    return store[routeId] || null;
  }

  /**
   * Save route shape + stop data (both directions).
   * Does NOT overwrite existing schedule data.
   * @param {string} routeId
   * @param {Object} data  — { directions: [{ name, stopIds, stops, polyline }] }
   */
  function saveRoute(routeId, data) {
    const store = _load();
    const existing = store[routeId];
    // Preserve existing schedule data when updating shape
    const directions = (data.directions || []).map(newDir => {
      const existingDir = existing?.directions?.find(d => d.name === newDir.name);
      return {
        ...newDir,
        schedule: existingDir?.schedule || { weekday: {}, saturday: {}, sunday: {} },
      };
    });
    store[routeId] = {
      ...(existing || {}),
      directions,
      fetchedAt: Date.now(),
    };
    _stopIdx = null;   // stop index is derived from the store — rebuild lazily
    _save();
  }

  /**
   * Invalidate (delete) a route's cached data.
   * Called when a service alert affects the route shape.
   */
  function invalidateRoute(routeId) {
    const store = _load();
    if (store[routeId]) {
      delete store[routeId];
      _stopIdx = null;
      _save();
    }
  }

  /**
   * Check whether a route has valid cached shape data.
   */
  function hasRoute(routeId) {
    const store = _load();
    const entry = store[routeId];
    if (!entry || !entry.directions || !entry.directions.length) return false;
    return entry.directions.some(d =>
      d.stops && Object.values(d.stops).some(s => s.lat !== 0 || s.lon !== 0)
    );
  }

  // ─── Direction ──────────────────────────────────────────────────────────────

  /**
   * Get the direction entry that best matches a headsign.
   * Falls back to first direction if no match.
   */
  function getDirection(routeId, headsign) {
    const entry = getRoute(routeId);
    if (!entry || !entry.directions || !entry.directions.length) return null;
    if (entry.directions.length === 1) return entry.directions[0];

    if (headsign) {
      const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const cardWords = headsign.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      let bestScore = 0, bestDir = entry.directions[0];
      for (const dir of entry.directions) {
        const name = normalize(dir.name || '');
        const score = cardWords.filter(w => name.includes(normalize(w))).length;
        if (score > bestScore) { bestScore = score; bestDir = dir; }
      }
      return bestDir;
    }

    return entry.directions[0];
  }

  /**
   * Find the nearest stop to (lat, lon) across ALL directions of a route.
   * Returns { stopId, directionName } or null.
   * Used by the detail panel to determine which direction the user is on.
   */
  function findNearestStopAcrossDirections(routeId, lat, lon) {
    const entry = getRoute(routeId);
    if (!entry || !entry.directions) return null;

    let nearest = null, minDist = Infinity;
    for (const dir of entry.directions) {
      for (const [stopId, stop] of Object.entries(dir.stops || {})) {
        if (!stop.lat && !stop.lon) continue;
        const d = Math.hypot(stop.lat - lat, stop.lon - lon);
        if (d < minDist) {
          minDist = d;
          nearest = { stopId, directionName: dir.name };
        }
      }
    }
    return nearest;
  }

  // ─── Schedule ───────────────────────────────────────────────────────────────

  /**
   * Check whether schedule data exists and is fresh for a given day type.
   *
   * Fresh means BOTH:
   *   1. cached less than SCHEDULE_TTL_MS ago (gradual-drift backstop), AND
   *   2. cached AFTER the most recent service change that has taken effect —
   *      otherwise we'd keep serving the previous timetable for up to 90 days.
   *
   * @param {string} routeId
   * @param {string} dayType  — 'weekday' | 'saturday' | 'sunday'
   * @returns {boolean}
   */
  function hasSchedule(routeId, dayType) {
    const entry = getRoute(routeId);
    if (!entry) return false;
    const fetchedAt = entry.scheduleFetchedAt?.[dayType];
    if (!fetchedAt) return false;
    if (Date.now() - fetchedAt > SCHEDULE_TTL_MS) return false;
    // Stale if it predates the latest in-effect service change.
    if (fetchedAt < _lastEffectiveServiceChange()) return false;
    // Check at least one direction has schedule data for this day type
    return entry.directions.some(d =>
      d.schedule?.[dayType] && Object.keys(d.schedule[dayType]).length > 0
    );
  }

  /**
   * Get scheduled departure times for a specific stop, direction, and day type.
   * @param {string} routeId
   * @param {string} directionName
   * @param {string} stopId
   * @param {string} [dayType]  — defaults to today's day type
   * @returns {number[]}  — array of ms timestamps, or []
   */
  /**
   * RE-BASE stored times onto a calendar day.
   *
   * `schedule-for-stop` returns each departure as an absolute epoch-ms for the
   * service date it was FETCHED on (verified against the live API: a Friday
   * fetch returns Friday timestamps). The store keeps one set per DAY TYPE for
   * up to 90 days, so on any later weekday every stored time was in the past —
   * `t > now` matched nothing and the schedule layer silently went empty the
   * day after it was warmed. Re-basing keeps each time's wall-clock hh:mm:ss
   * and moves it onto `refMs`'s calendar day, which is what a timetable means.
   * Built with the Date(y,m,d,h,mi,s) constructor (wall-clock), so DST days
   * stay correct. Returns a NEW sorted array; the stored data is untouched.
   */
  function _rebase(times, refMs) {
    if (!times || !times.length) return [];
    const ref = new Date(refMs === undefined ? Date.now() : refMs);
    const y = ref.getFullYear(), m = ref.getMonth(), d = ref.getDate();
    const out = new Array(times.length);
    for (let i = 0; i < times.length; i++) {
      const t = new Date(times[i]);
      out[i] = new Date(y, m, d, t.getHours(), t.getMinutes(), t.getSeconds()).getTime();
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function _dayTypeFor(ms) {
    const day = new Date(ms).getDay();
    return day === 0 ? 'sunday' : day === 6 ? 'saturday' : 'weekday';
  }

  /** Scheduled times (ms) for a stop on a direction, re-based onto `refMs`'s day (default: today). */
  function getScheduleForStop(routeId, directionName, stopId, dayType, refMs) {
    const dt = dayType || (typeof getDayType === 'function' ? getDayType() : 'weekday');
    const entry = getRoute(routeId);
    if (!entry) return [];
    const dir = entry.directions.find(d => d.name === directionName);
    if (!dir || !dir.schedule) return [];
    return _rebase(dir.schedule[dt]?.[stopId], refMs);
  }

  /**
   * First scheduled departure TOMORROW for a stop+direction (ms), or 0.
   * Uses tomorrow's own day type when it's stored (Fri → Sat), else falls back to
   * today's day type shifted a day — the same approximation v6's
   * applyNextDayFromSchedule used.
   */
  function getNextDayFirst(routeId, directionName, stopId) {
    const entry = getRoute(routeId);
    if (!entry) return 0;
    const dir = entry.directions.find(d => d.name === directionName);
    if (!dir || !dir.schedule) return 0;
    const t = new Date(); t.setDate(t.getDate() + 1);
    const tomorrow = t.getTime();
    const own = dir.schedule[_dayTypeFor(tomorrow)]?.[stopId];
    const today = dir.schedule[_dayTypeFor(Date.now())]?.[stopId];
    const times = _rebase((own && own.length) ? own : today, tomorrow);
    return times.length ? times[0] : 0;
  }

  // ─── Stop index (built lazily; lets the home board find nearby stops from the
  //     store alone — no network, no GPS-scoped API call) ───────────────────────
  let _stopIdx = null;       // Map stopId -> { stopId, name, lat, lon, routes:[{routeId, directionName}] }
  let _routeMeta = {};       // routeId -> { shortName, longName, type, agencyId, color, textColor } (from routes-data.json, every boot)

  function _buildStopIndex() {
    const idx = new Map();
    const store = _load();
    for (const routeId of Object.keys(store)) {
      for (const dir of (store[routeId].directions || [])) {
        for (const stopId of Object.keys(dir.stops || {})) {
          const s = dir.stops[stopId];
          if (!s || (!s.lat && !s.lon)) continue;
          let e = idx.get(stopId);
          if (!e) { e = { stopId, name: s.name || '', lat: s.lat, lon: s.lon, routes: [] }; idx.set(stopId, e); }
          e.routes.push({ routeId, directionName: dir.name });
        }
      }
    }
    return idx;
  }
  function _stopIndex() { return _stopIdx || (_stopIdx = _buildStopIndex()); }

  function _meters(aLat, aLon, bLat, bLon) {
    const R = 6371000, r = x => x * Math.PI / 180;
    const dLat = r(bLat - aLat), dLon = r(bLon - aLon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /** Stops within `radiusM` of a point, nearest first: [{ stopId, name, lat, lon, distance }]. */
  function getStopsNear(lat, lon, radiusM) {
    const out = [];
    for (const e of _stopIndex().values()) {
      // cheap box reject before haversine (1° lat ≈ 111 km)
      if (Math.abs(e.lat - lat) * 111000 > radiusM) continue;
      const d = _meters(lat, lon, e.lat, e.lon);
      if (d <= radiusM) out.push({ stopId: e.stopId, name: e.name, lat: e.lat, lon: e.lon, distance: d });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  /** Route+direction pairs the store knows serve a stop: [{ routeId, directionName }]. */
  function getRoutesAtStop(stopId) {
    const e = _stopIndex().get(stopId);
    return e ? e.routes : [];
  }

  /** Route display metadata (shortName/longName/type/agencyId/color/textColor), or null. */
  function getRouteMeta(routeId) { return _routeMeta[routeId] || null; }

  /**
   * (main-next addition) Drop every cached schedule that was fetched BEFORE the
   * most recent in-effect service change.
   *
   * Why this is needed on top of hasSchedule(): saveSchedule() MERGES via
   * Object.assign, so simply re-fetching would leave behind stop times for stops
   * that no longer exist after the change. Pruning first guarantees a clean
   * re-fetch. Call once at boot.
   *
   * Route shape/stop data is left intact — only schedules are cleared.
   * @returns {number} how many route/dayType schedule sets were cleared
   */
  function pruneStaleSchedules() {
    const cutoff = _lastEffectiveServiceChange();
    if (!cutoff) return 0;

    const store = _load();
    let cleared = 0;
    for (const routeId in store) {
      const entry = store[routeId];
      if (!entry || !entry.scheduleFetchedAt) continue;
      for (const dayType of Object.keys(entry.scheduleFetchedAt)) {
        const fetchedAt = entry.scheduleFetchedAt[dayType];
        if (!fetchedAt || fetchedAt >= cutoff) continue;
        for (const dir of (entry.directions || [])) {
          if (dir.schedule && dir.schedule[dayType]) dir.schedule[dayType] = {};
        }
        delete entry.scheduleFetchedAt[dayType];
        cleared++;
      }
    }
    if (cleared) {
      _save();
      console.log(`[store] pruned ${cleared} stale schedule set(s) predating service change ${new Date(cutoff).toDateString()}`);
    }
    return cleared;
  }

  /**
   * Save schedule data for all stops in all directions for a given day type.
   * @param {string} routeId
   * @param {string} dayType  — 'weekday' | 'saturday' | 'sunday'
   * @param {Object} scheduleByDirection  — { directionName: { stopId: [ms, ...] } }
   */
  function saveSchedule(routeId, dayType, scheduleByDirection) {
    const store = _load();
    const entry = store[routeId];
    if (!entry) return;

    for (const dir of entry.directions) {
      const stopTimes = scheduleByDirection[dir.name] || {};
      if (!dir.schedule) dir.schedule = {};
      if (!dir.schedule[dayType]) dir.schedule[dayType] = {};
      Object.assign(dir.schedule[dayType], stopTimes);
    }

    if (!entry.scheduleFetchedAt) entry.scheduleFetchedAt = {};
    entry.scheduleFetchedAt[dayType] = Date.now();
    _save();
  }

  /**
   * Get all upcoming scheduled times for a stop across all directions.
   * Useful for the home page to show ETAs without knowing the direction.
   * @param {string} routeId
   * @param {string} stopId
   * @param {string} [dayType]
   * @returns {number[]}  — sorted ascending, filtered to future times
   */
  function getUpcomingTimesForStop(routeId, stopId, dayType) {
    const dt = dayType || (typeof getDayType === 'function' ? getDayType() : 'weekday');
    const entry = getRoute(routeId);
    if (!entry) return [];
    const now = Date.now();
    const times = [];
    for (const dir of entry.directions) {
      // re-based onto today (see _rebase) — raw stored times are only valid on their fetch date
      _rebase(dir.schedule?.[dt]?.[stopId], now).forEach(t => { if (t > now) times.push(t); });
    }
    return times.sort((a, b) => a - b);
  }

  /**
   * Load pre-built route data from a static JSON file.
   * Called once at boot — populates the entire store instantly.
   * @param {string} url — path to routes-data.json
   */
  async function loadFromStaticFile(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) { console.warn('[TransitStore] Failed to load static routes:', r.status); return; }
      const data = await r.json();
      const store = _load();

      let loaded = 0;
      _routeMeta = {};
      for (const [routeId, route] of Object.entries(data.routes || {})) {
        // Display metadata for schedule-built cards (not persisted — refreshed from
        // the static file every boot, so it can never go stale or change the store shape).
        _routeMeta[routeId] = {
          shortName: route.shortName, longName: route.longName, type: route.type,
          agencyId: route.agencyId, color: route.color, textColor: route.textColor,
        };
        // Only load if not already in store (preserve any user-fetched schedule data)
        if (!store[routeId]) {
          store[routeId] = {
            fetchedAt: Date.now(),
            directions: (route.directions || []).map(dir => ({
              name: dir.name,
              stopIds: dir.stopIds,
              stops: dir.stops,
              polyline: dir.polyline,
              schedule: { weekday: {}, saturday: {}, sunday: {} },
            })),
          };
          loaded++;
        }
      }

      _stopIdx = null;
      _save();
      console.log(`[TransitStore] Loaded ${loaded} routes from static file (${data.routeCount} total available)`);
    } catch (e) {
      console.warn('[TransitStore] Error loading static routes:', e.message);
    }
  }

  /**
   * Clear all stored data (for debugging / reset).
   */
  function clearAll() {
    _mem = {};
    _stopIdx = null;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  return {
    // Shape
    getRoute,
    saveRoute,
    invalidateRoute,
    hasRoute,
    // Direction
    getDirection,
    findNearestStopAcrossDirections,
    // Schedule
    hasSchedule,
    getScheduleForStop,
    saveSchedule,
    pruneStaleSchedules,
    getUpcomingTimesForStop,
    getNextDayFirst,
    // Stop index + route metadata (schedule-first home board)
    getStopsNear,
    getRoutesAtStop,
    getRouteMeta,
    // Static data loading
    loadFromStaticFile,
    // Util
    clearAll,
    // Freshness rules, exposed so other caches (schedule-cache) can apply the
    // SAME staleness test instead of duplicating the service-change dates.
    scheduleTtlMs: () => SCHEDULE_TTL_MS,
    lastEffectiveServiceChange: _lastEffectiveServiceChange,
  };

})();


// ═══════════════════════════════════════════════════════════════════════════════
// LIVE CACHE — in-memory ETA data for the current session
// ═══════════════════════════════════════════════════════════════════════════════

const LiveCache = (function () {
  'use strict';

  let _cache = null;

  function init(cacheRef) {
    _cache = cacheRef;
  }

  /**
   * Get ETAs for a route+headsign combination from the live feed cache.
   */
  function getETAs(routeId, headsign) {
    if (!_cache) return [];
    const results = [];
    for (const key in _cache) {
      const entry = _cache[key];
      if (entry.routeId !== routeId) continue;
      if (headsign && entry.headsign) {
        const norm = s => (s || '').toLowerCase().split(/\s+/)[0];
        if (norm(entry.headsign) !== norm(headsign)) continue;
      }
      if (entry.etas && entry.etas.length) {
        entry.etas.forEach(e => results.push(e));
      }
    }
    return results.sort((a, b) => a.ms - b.ms).slice(0, 3);
  }

  function getHeadsign(routeId) {
    if (!_cache) return '';
    for (const key in _cache) {
      const entry = _cache[key];
      if (entry.routeId === routeId && entry.headsign) return entry.headsign;
    }
    return '';
  }

  function getAll() {
    if (!_cache) return [];
    return Object.values(_cache);
  }

  return { init, getETAs, getHeadsign, getAll };

})();
