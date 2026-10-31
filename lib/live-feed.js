/**
 * live-feed.js — single live-poll module (main-next)
 *
 * ONE recurring call (TransitAPI.fetchLiveFeedForRoute → /trips-for-route with
 * status) drives the map VEHICLE markers and the route's service ALERTS. It does
 * NOT compute arrival times: the ETA pills come from the per-stop real-time
 * arrivals request (detail.js _refreshStopEtas), merged with the stored timetable.
 * (An earlier version also derived ETAs here — timetable + one median
 * scheduleDeviation — but nothing read them after the pills were put back on
 * arrivals-for-stop on 2026-09-02; removed 2026-10-30.)
 *
 * Design goals (per user requirements):
 *   - Reduce total API calls: one poll does vehicles + alerts.
 *   - Modular + reusable: subscriber model with start()/stop() lifecycle so any
 *     page (detail now, others later) consumes the same feed.
 *
 * A feed instance is created per route:
 *   const feed = LiveFeed.create({ routeId, intervalMs: 20000 });
 *   const off = feed.onUpdate(snapshot => { ...  });  // snapshot below
 *   feed.start();          // fetches immediately, then every intervalMs
 *   ...
 *   feed.stop();           // clears interval + subscribers
 *
 * snapshot = {
 *   vehicles: [ { vehicleId, tripId, lat, lon, tripHeadsign, directionId,
 *                 lastUpdateTime, ageSec, nextStop, closestStop, distanceAlongTrip } ],
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
 * Depends on globals: TransitAPI (loaded before this file).
 */

const LiveFeed = (function () {
  'use strict';

  const DEFAULT_INTERVAL_MS = 20000;
  const STALE_VEHICLE_SEC = 300;   // hide vehicles silent for more than 5 minutes

  function create(opts) {
    opts = opts || {};
    const routeId = opts.routeId;
    const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;

    let _timer = null;
    let _stopped = false;
    let _last = null;
    const _subs = [];

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

    async function _tick() {
      if (_stopped) return;
      const feed = await TransitAPI.fetchLiveFeedForRoute(routeId);
      if (_stopped) return;

      // Drop vehicles that have a position but haven't reported for >5 min — a
      // coasting prediction, not a bus you can rely on. (No update time = keep.)
      const vehicles = (feed.trips || []).filter(t =>
        (t.lat || t.lon) && !(t.ageSec != null && t.ageSec > STALE_VEHICLE_SEC));
      const snapshot = {
        vehicles,
        situationIds: feed.situationIds || [],
        alerts: _activeRouteAlerts(feed.situations),
        fetchedAt: Date.now(),
        ok: true,
      };
      _last = snapshot;
      _emit(snapshot);
    }

    function _emit(snapshot) {
      for (const cb of _subs) { try { cb(snapshot); } catch (e) { /* isolate */ } }
    }

    function onUpdate(cb) {
      _subs.push(cb);
      if (_last) { try { cb(_last); } catch (e) {} }
      return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); };
    }

    /** Start polling: fetches immediately, then every intervalMs. */
    function start() {
      if (_timer || _stopped) return;
      _tick(); // immediate
      _timer = setInterval(_tick, intervalMs);
    }

    function stop() {
      _stopped = true;
      if (_timer) { clearInterval(_timer); _timer = null; }
      _subs.length = 0;
    }

    /** Force an immediate poll (e.g. pull-to-refresh). */
    function refresh() { return _tick(); }

    return {
      onUpdate,
      start,
      stop,
      refresh,
      getLast: () => _last,
      get routeId() { return routeId; },
    };
  }

  return { create };
})();
