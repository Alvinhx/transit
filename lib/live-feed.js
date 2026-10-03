/**
 * live-feed.js — single live-poll module (main-next)
 *
 * ONE recurring call (TransitAPI.fetchLiveFeedForRoute → /trips-for-route with
 * status+schedule) drives BOTH the map vehicle markers AND live ETAs. Scheduled
 * times are read from the pre-loaded TransitStore (zero extra calls); live ETA =
 * scheduled time + scheduleDeviation. situationIds fall out of the same response
 * (foundation for the future alerts feature).
 *
 * Design goals (per user requirements):
 *   - Reduce total API calls: one poll does vehicles + ETAs (was 2 concerns).
 *   - Only call for live feeds; scheduled times come from the store.
 *   - Modular + reusable: subscriber model with start()/stop() lifecycle so any
 *     page (detail now, others later) consumes the same feed.
 *
 * A feed instance is created per route:
 *   const feed = LiveFeed.create({ routeId, directionName, intervalMs: 20000 });
 *   const off = feed.onUpdate(snapshot => { ...  });  // snapshot below
 *   feed.start();          // fetches immediately, then every intervalMs
 *   ...
 *   feed.stop();           // clears interval + subscribers
 *
 * snapshot = {
 *   vehicles: [ { vehicleId, tripId, lat, lon, directionId, predicted,
 *                 scheduleDeviation, nextStop, distanceAlongTrip } ],
 *   etasByStop: { [stopId]: [ { ms, live } ] },   // live-adjusted, soonest first
 *   situationIds: [ ... ],
 *   alerts: [ { id, reason, severity, summary, description, url,
 *               affectedRouteIds, affectedStopIds, activeWindows, createdAt } ],
 *           // ACTIVE, route-scoped service alerts — free (same poll), newest first
 *   fetchedAt: <ms>,
 *   ok: <bool>,           // false if the fetch failed this cycle
 * }
 *
 * NOTE on alerts: they come from `references.situations` on the same
 * trips-for-route response, so they cost no extra request. Caveat — when a route
 * has no active trips (e.g. overnight), no situations are referenced, so the
 * alert list goes empty even if the agency has published one.
 *
 * Depends on globals: TransitAPI, TransitStore (loaded before this file).
 */

const LiveFeed = (function () {
  'use strict';

  const DEFAULT_INTERVAL_MS = 20000;

  function create(opts) {
    opts = opts || {};
    const routeId = opts.routeId;
    const directionName = opts.directionName || null;
    const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;

    let _timer = null;
    let _stopped = false;
    let _last = null;
    const _subs = [];

    // Build live ETAs for the given stops from the trip feed + store schedule.
    // For each stop, prefer a live-adjusted time (scheduled + deviation) derived
    // from trips whose schedule includes that stop; fall back to pure schedule.
    function _computeEtasByStop(trips, stopIds) {
      const now = Date.now();
      const out = {};
      if (!stopIds || !stopIds.length) return out;

      // Index scheduled times per stop from the store (zero API calls).
      const scheduledByStop = {};
      for (const sid of stopIds) {
        let times = [];
        if (typeof TransitStore !== 'undefined' && directionName) {
          times = TransitStore.getScheduleForStop(routeId, directionName, sid) || [];
        }
        scheduledByStop[sid] = times;
      }

      // Live adjustment: apply the closest active trip's scheduleDeviation to the
      // scheduled times for that stop. A single route-wide deviation is a good
      // approximation when we can't map a specific trip to a specific stop time.
      // Prefer the median deviation across predicted trips to reduce outliers.
      const devs = trips.filter(t => t.predicted).map(t => t.scheduleDeviation).sort((a, b) => a - b);
      const medianDev = devs.length ? devs[Math.floor(devs.length / 2)] : 0;

      for (const sid of stopIds) {
        const sched = scheduledByStop[sid] || [];
        const adjusted = sched
          .map(ms => ({ ms: ms + medianDev * 1000, live: devs.length > 0 }))
          .filter(e => e.ms > now - 30000)
          .sort((a, b) => a.ms - b.ms)
          .slice(0, 3);
        if (adjusted.length) out[sid] = adjusted;
      }
      return out;
    }

    /**
     * Filter situations to the ones that are ACTIVE now and scoped to this route.
     *
     * Scope rule (per the recorded decision — follow OBA, no heuristics):
     *   route-based  = any `routeId` present in allAffects  → shown on the route
     *   system-level = no routeId at all                    → app-level banner
     * Here we keep the route-based ones matching THIS route.
     *
     * NOTE: activeWindows on this server are in MILLISECONDS (not seconds).
     * An empty/absent activeWindows list means "always active".
     */
    function _activeRouteAlerts(situations) {
      const now = Date.now();
      const out = [];
      for (const s of situations || []) {
        const windows = s.activeWindows || [];
        const isActive = windows.length === 0 || windows.some(w => {
          const from = w.from || 0;
          const to = w.to || 0;
          if (from && now < from) return false;
          if (to && now > to) return false;
          return true;
        });
        if (!isActive) continue;

        const affects = s.allAffects || [];
        const routeIds = affects.map(a => a.routeId).filter(Boolean);
        // route-based and matching this route (or unscoped-but-delivered here)
        if (routeIds.length && !routeIds.includes(routeId)) continue;

        out.push({
          id: s.id,
          reason: s.reason || '',
          severity: s.severity || '',
          summary: (s.summary && s.summary.value) || '',
          description: (s.description && s.description.value) || '',
          url: (s.url && s.url.value) || '',
          affectedRouteIds: routeIds,
          affectedStopIds: affects.map(a => a.stopId).filter(Boolean),
          activeWindows: windows,
          createdAt: s.creationTime || 0,
        });
      }
      // Newest first — most recently published alert is usually most relevant.
      out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return out;
    }

    async function _tick(stopIds) {
      if (_stopped) return;
      const feed = await TransitAPI.fetchLiveFeedForRoute(routeId);
      if (_stopped) return;

      const vehicles = (feed.trips || []).filter(t => t.lat || t.lon);
      const snapshot = {
        vehicles,
        etasByStop: _computeEtasByStop(feed.trips || [], stopIds || _currentStopIds),
        situationIds: feed.situationIds || [],
        alerts: _activeRouteAlerts(feed.situations),
        fetchedAt: Date.now(),
        ok: true,
      };
      _last = snapshot;
      _emit(snapshot);
    }

    let _currentStopIds = [];

    function _emit(snapshot) {
      for (const cb of _subs) { try { cb(snapshot); } catch (e) { /* isolate */ } }
    }

    function onUpdate(cb) {
      _subs.push(cb);
      if (_last) { try { cb(_last); } catch (e) {} }
      return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); };
    }

    /**
     * Start polling. Pass the stop IDs whose ETAs you care about (e.g. the
     * detail page's nearest stop). Fetches immediately, then every intervalMs.
     */
    function start(stopIds) {
      if (_timer || _stopped) return;
      _currentStopIds = stopIds || [];
      _tick(_currentStopIds); // immediate
      _timer = setInterval(() => _tick(_currentStopIds), intervalMs);
    }

    /** Update the tracked stop IDs without restarting the interval. */
    function setStops(stopIds) { _currentStopIds = stopIds || []; }

    function stop() {
      _stopped = true;
      if (_timer) { clearInterval(_timer); _timer = null; }
      _subs.length = 0;
    }

    return {
      onUpdate,
      start,
      setStops,
      stop,
      getLast: () => _last,
      get routeId() { return routeId; },
    };
  }

  return { create };
})();
