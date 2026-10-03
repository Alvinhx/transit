/**
 * stop-feed.js — nearby-transit feed (main-next)
 *
 * Stop-centric sibling to the route-centric live-feed.js. Powers the HOME page:
 * "what transit is near me right now".
 *
 * EFFICIENCY: ONE request per refresh. `arrivals-and-departures-for-location`
 * returns arrivals for EVERY stop around a point (~32 stops in testing) plus the
 * route/stop references AND `references.situations`. Main/ polled each stop
 * individually (~7 calls per cycle, staggered to dodge rate limits) — this is a
 * single call covering more ground.
 *
 * Bonus: because situations ride this response, nearby alerts are available even
 * when no vehicles are running (the overnight gap that the route-centric
 * trips-for-route feed has).
 *
 * Arrivals are grouped into CARDS keyed by route + direction (headsign), each
 * carrying up to 3 upcoming ETAs — matching the home board's card model.
 *
 * ── TWO MODES, one implementation ────────────────────────────────────────────
 *
 * NEARBY (home): centre follows the GPS fix, no stop filter, sorted by distance.
 *   const feed = StopFeed.create({ radius: 400, intervalMs: 20000 });
 *   feed.start(lat, lon);
 *   feed.setLocation(lat, lon);   // user moved
 *
 * STATION (station board): centre is the station's FIXED centroid, restricted to
 * that station's curated stop ids, sorted by soonest departure.
 *   const feed = StopFeed.create({
 *     radius: 300, sortBy: 'eta', stopIds: station.stopIds,
 *   });
 *   feed.start(centroid.lat, centroid.lon);   // and never setLocation()
 *
 *   const off = feed.onUpdate(snap => { ... });
 *   feed.stop();
 *
 * WHY STATION MODE STILL USES THE LOCATION ENDPOINT (measured, 2026-08-30):
 * v1 polled each station stop individually — 7 calls at Capitol Hill, 20 at
 * Lynnwood, staggered 1s apart, so a Lynnwood cycle took ~20s, longer than its
 * own 15s refresh. One location call at the centroid covers the whole curated
 * set instead: 7/7 Capitol Hill, 7/7 Denny & Westlake, 18/20 Lynnwood (the 2
 * misses are commuter stops with no overnight service, not a coverage gap).
 *
 * Radius must stay SMALL. The endpoint caps at 250 arrivals, and past ~500m that
 * cap truncates the response and starts dropping the very stops you wanted —
 * Capitol Hill fell to 1/7 at radius 1500. Bigger is worse, not safer.
 *
 * NOTE on `distance` in station mode: it's measured from the station centroid,
 * not from the user, so it's not meaningful there. That's why station mode sorts
 * by ETA and doesn't display distance.
 *
 * snapshot = {
 *   cards: [ { key, routeId, route, headsign, mode, tag, badge, color, textColor,
 *              etas: [{ms, live}], stopId, stopName, distance } ],  // soonest first
 *   situations: [ raw situation objects ],
 *   stopIds: [...],
 *   fetchedAt: <ms>,
 *   ok: <bool>,
 * }
 *
 * Depends on globals: TransitAPI. Optionally uses a classify function + color
 * overrides supplied by the caller (so city rules stay outside this module).
 */

const StopFeed = (function () {
  'use strict';

  const DEFAULT_INTERVAL_MS = 20000;
  const DEFAULT_RADIUS_M = 400;
  const MAX_ETAS_PER_CARD = 3;

  // Fallback classification if the caller doesn't supply one (Seattle rules).
  function _defaultClassify(type, agencyId, shortName) {
    const sn = shortName || '';
    if (type === 0 && agencyId === '40') return { mode: 'rail', tag: 'Light Rail', badge: 'round' };
    // Streetcar: the API shortName is already e.g. "First Hill Streetcar", so use
    // a generic tag and let the route name carry the specifics (avoids the
    // "First Hill Streetcar / First Hill Streetcar" duplication on the card).
    if (type === 0) return { mode: 'streetcar', tag: 'Streetcar', badge: 'square' };
    if (type === 2 && agencyId === '96') return { mode: 'monorail', tag: 'Monorail', badge: 'square' };
    if (type === 3 && agencyId === '40') return { mode: 'express', tag: 'ST Express', badge: 'square' };
    if (type === 3 && /^Swift/i.test(sn)) return { mode: 'swift', tag: sn, badge: 'square', isSwift: true };
    if (type === 3 && /Line$/i.test(sn)) return { mode: 'rapid', tag: 'RapidRide', badge: 'square' };
    if (agencyId === '29') return { mode: 'bus', tag: 'Community Transit', badge: 'square' };
    if (type === 3 && sn && !/^\d+$/.test(sn.trim())) return { mode: 'shuttle', tag: 'KC Shuttle', badge: 'square' };
    return { mode: 'bus', tag: 'KC Bus', badge: 'square' };
  }

  // OBA sometimes returns outdated GTFS route colors — align with brand colors.
  const COLOR_OVERRIDES = {
    '#28813F': '#3DAE2B', // 1 Line
    '#007CAD': '#00A0DF', // 2 Line
  };
  function _overrideColor(c) { return COLOR_OVERRIDES[c] || c; }

  function _haversine(aLat, aLon, bLat, bLon) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function create(opts) {
    opts = opts || {};
    const radius = opts.radius || DEFAULT_RADIUS_M;
    const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    const classify = typeof opts.classify === 'function' ? opts.classify : _defaultClassify;
    const sortBy = opts.sortBy === 'eta' ? 'eta' : 'distance';
    // STATION mode: restrict to a curated stop set. The location call still
    // returns every stop in the radius (we can't ask it for specific stops), so
    // we drop the extras here. One request either way — see the header note.
    const stopFilter = (Array.isArray(opts.stopIds) && opts.stopIds.length)
      ? new Set(opts.stopIds) : null;

    let _timer = null;
    let _stopped = false;
    let _last = null;
    let _lat = null, _lon = null;
    let _warmed = false;   // schedule warming is a once-per-session job
    const _subs = [];

    /** Group raw arrivals into route+direction cards with up to 3 ETAs each. */
    function _buildCards(feed) {
      const now = Date.now();
      const byKey = {};

      for (const a of feed.arrivals || []) {
        if (stopFilter && !stopFilter.has(a.stopId)) continue; // not one of this station's stops
        const ms = a.predictedDepartureTime || a.scheduledDepartureTime ||
                   a.predictedArrivalTime || a.scheduledArrivalTime || 0;
        if (!ms || ms < now - 60000) continue; // drop already-departed

        const rt = feed.routes[a.routeId] || {};
        const stop = feed.stops[a.stopId] || {};
        const rawName = rt.shortName || rt.longName || '?';
        // Badge shows the bare number/name ("2", not "2 Line") — same as Main.
        const shortName = (typeof CardRender !== 'undefined')
          ? CardRender.parseRoute(rawName)
          : String(rawName).replace(/\s*Line$/i, '').replace(/\s*Streetcar$/i, '').trim();
        const cls = classify(rt.type, rt.agencyId, rawName);
        const headsign = a.tripHeadsign || rt.longName || '';
        // Group by the route's CANONICAL DIRECTION, not the raw OBA headsign.
        // Two nearby stops on the same route+direction often carry slightly
        // different tripHeadsign text ("Seattle Center" vs "Seattle Center via
        // …" / casing / whitespace), which used to split them into DUPLICATE
        // cards on the nearby board. TransitStore.getDirection() normalises any
        // of those spellings to one stable direction name (same reason PinStore
        // keys on routeId|directionName). Fall back to the raw headsign only if
        // the route isn't in the store.
        const directionName = _directionNameFor(a.routeId, headsign);
        const key = directionName ? `${a.routeId}|${directionName}` : `${a.routeId}|hs:${headsign}`;
        const dist = (_lat != null && stop.lat != null)
          ? Math.round(_haversine(_lat, _lon, stop.lat, stop.lon)) : null;

        if (!byKey[key]) {
          byKey[key] = {
            key,
            routeId: a.routeId,
            route: shortName,
            headsign,
            mode: cls.mode,
            tag: cls.tag,
            badge: cls.badge,
            isSwift: !!cls.isSwift,
            color: _overrideColor(rt.color ? `#${rt.color}` : '#666'),
            textColor: rt.textColor ? `#${rt.textColor}` : '#fff',
            etas: [],
            // ETAs collected per boarding stop. After the loop we keep ONLY the
            // card's owning (nearest) stop's times — see the finalize loop — so a
            // nearby card matches the single-stop detail page instead of merging
            // soonest departures across several physical stops.
            etasByStop: {},
            // Store's direction name — lets the schedule fallback look up cached
            // times on the correct direction.
            directionName,
            stopId: a.stopId,
            stopName: stop.name || '',
            stopLat: (stop.lat != null ? stop.lat : null),
            stopLon: (stop.lon != null ? stop.lon : null),
            distance: dist,
          };
        } else if (dist != null && (byKey[key].distance == null || dist < byKey[key].distance)) {
          // Same direction, seen at a CLOSER stop — represent the merged card by
          // the nearest boarding stop (drives distance-sort + the schedule
          // fallback), and show that stop's headsign text.
          const c = byKey[key];
          c.distance = dist;
          c.stopId = a.stopId;
          c.stopName = stop.name || '';
          c.stopLat = (stop.lat != null ? stop.lat : null);
          c.stopLon = (stop.lon != null ? stop.lon : null);
          c.headsign = headsign;
        }
        // Collect each arrival under ITS boarding stop. The card ultimately
        // shows only the owning (nearest) stop's times (see the finalize loop),
        // so the nearby card matches the single-stop detail page rather than
        // blending soonest departures across multiple physical stops.
        (byKey[key].etasByStop[a.stopId] || (byKey[key].etasByStop[a.stopId] = []))
          .push({ ms, live: !!a.predictedDepartureTime });
      }

      const cards = Object.values(byKey);
      for (const c of cards) {
        // Keep ONLY the owning (nearest) stop's ETAs — the same single stop the
        // detail page anchors on — so the board and detail stay consistent.
        // (Arrivals aren't ordered by distance, so we resolve the owner after
        // the full pass rather than while iterating.)
        const own = c.etasByStop[c.stopId] || [];
        delete c.etasByStop;
        // Dedupe identical times, soonest first, cap at 3.
        const seen = new Set();
        c.etas = own
          .filter(e => { const k = e.ms + '|' + e.live; if (seen.has(k)) return false; seen.add(k); return true; })
          .sort((x, y) => x.ms - y.ms)
          .slice(0, MAX_ETAS_PER_CARD);
      }
      // Natural order depends on the mode (pages may re-sort on top of this,
      // e.g. to float pinned routes):
      //
      //  'distance' (NEARBY default) — nearest boarding stop first. Distance is
      //    stable, so the list keeps a steady order instead of re-shuffling every
      //    20s as departure times tick down.
      //  'eta' (STATION) — soonest departure first, like the v1 station board.
      //    Distance is meaningless there: every stop is within ~200m of the
      //    station centroid, so "what leaves next" is the only useful order.
      //
      // Both tie-break on route name (numeric-aware) so ordering is deterministic.
      const byName = (a, b) =>
        String(a.route).localeCompare(String(b.route), undefined, { numeric: true });

      if (sortBy === 'eta') {
        cards.sort((a, b) => {
          // Cards with no upcoming ETA sink to the bottom rather than the top.
          const ae = a.etas.length ? a.etas[0].ms : Infinity;
          const be = b.etas.length ? b.etas[0].ms : Infinity;
          if (ae !== be) return ae - be;
          return byName(a, b);
        });
      } else {
        cards.sort((a, b) => {
          const ad = (a.distance == null) ? Infinity : a.distance;
          const bd = (b.distance == null) ? Infinity : b.distance;
          if (ad !== bd) return ad - bd;
          return byName(a, b);
        });
      }
      return cards;
    }

    /**
     * Build fallback cards from the STORE when the live call fails.
     *
     * Uses the full-day schedules warmed by ScheduleCache: for each card seen on
     * a previous successful tick, re-derive its next departures from cached
     * scheduled times. All ETAs are marked live:false so pills render as
     * scheduled rather than real-time.
     */
    function _buildFallbackCards() {
      if (!_last || !_last.cards || !_last.cards.length) return [];
      if (typeof ScheduleCache === 'undefined') return [];
      const now = Date.now();
      return _last.cards.map(prev => {
        let times = [];
        if (prev.directionName) {
          times = ScheduleCache.getStopTimes(prev.routeId, prev.directionName, prev.stopId) || [];
        }
        if (!times.length) {
          times = ScheduleCache.getUpcomingForStop(prev.routeId, prev.stopId, MAX_ETAS_PER_CARD) || [];
        }
        const etas = times
          .filter(t => t > now - 60000)   // keep one just-departed slot, like Main
          .sort((a, b) => a - b)
          .slice(0, MAX_ETAS_PER_CARD)
          .map(ms => ({ ms, live: false }));
        // Keep the card even with no times — the renderer shows a placeholder.
        return Object.assign({}, prev, { etas });
      });
    }

    /**
     * Warm full-day schedules for the NEARBY STOPS, once per day type.
     *
     * Deliberately STOP-centric, not route-centric: one `schedule-for-stop` call
     * returns the whole day for every route serving that stop, so warming the
     * ~15 stops on the board covers every nearby route in ~15 calls. Warming the
     * same routes end-to-end instead measured ~864 calls.
     *
     * Fire-and-forget, and only once per session — the store persists across
     * reloads and ScheduleCache skips stops it has already done.
     */
    function _warmSchedules(cards) {
      if (typeof ScheduleCache === 'undefined') return;
      if (_warmed) return;
      const stopIds = [...new Set(cards.map(c => c.stopId).filter(Boolean))];
      if (!stopIds.length) return;
      _warmed = true;
      ScheduleCache.ensureStops(stopIds).catch(() => { _warmed = false; });
    }

    /** Resolve the store's direction name for a route + headsign (best match). */
    function _directionNameFor(routeId, headsign) {
      if (typeof TransitStore === 'undefined') return '';
      try {
        const dir = TransitStore.getDirection(routeId, headsign);
        return (dir && dir.name) ? dir.name : '';
      } catch (e) { return ''; }
    }

    async function _tick() {
      if (_stopped || _lat == null) return;
      const feed = await TransitAPI.fetchArrivalsForLocation(_lat, _lon, radius);
      if (_stopped) return;

      const live = feed.ok !== false;
      let cards = live ? _buildCards(feed) : [];
      let usedFallback = false;

      // Live call failed (or came back empty) — fall back to cached schedule so
      // the board still shows departures instead of going blank.
      if (!cards.length) {
        const fb = _buildFallbackCards();
        if (fb.length) { cards = fb; usedFallback = true; }
      }

      const snapshot = {
        cards,
        situations: live ? (feed.situations || []) : ((_last && _last.situations) || []),
        stopIds: live ? (feed.stopIds || []) : ((_last && _last.stopIds) || []),
        fetchedAt: Date.now(),
        ok: live,
        usedFallback,
      };
      _last = snapshot;
      _emit(snapshot);

      // After a good tick, make sure these routes have a full-day schedule
      // cached so the fallback above has real data to work with next time.
      if (live && cards.length) _warmSchedules(cards);
    }

    function _emit(snapshot) {
      for (const cb of _subs) { try { cb(snapshot); } catch (e) { /* isolate */ } }
    }

    function onUpdate(cb) {
      _subs.push(cb);
      if (_last) { try { cb(_last); } catch (e) {} }
      return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); };
    }

    /** Start polling around a location. Fetches immediately, then every intervalMs. */
    function start(lat, lon) {
      if (_timer || _stopped) return;
      _lat = lat; _lon = lon;
      _tick();
      _timer = setInterval(_tick, intervalMs);
    }

    /** Update the centre point without restarting the interval. */
    function setLocation(lat, lon) {
      _lat = lat; _lon = lon;
      if (!_timer && !_stopped) start(lat, lon);
    }

    /** Force an immediate refresh (e.g. pull-to-refresh). */
    function refresh() { return _tick(); }

    function stop() {
      _stopped = true;
      if (_timer) { clearInterval(_timer); _timer = null; }
      _subs.length = 0;
    }

    return { onUpdate, start, setLocation, refresh, stop, getLast: () => _last };
  }

  return { create };
})();
