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
 * ── SCHEDULE FIRST, LIVE FILLED IN (the v6 model; restored 2026-10-30) ────────
 * The stored full-day timetable (TransitStore, built in the background by
 * ScheduleCache.warmAround) is the BASE of the board; live data is layered on:
 *   1. start() paints the board from the timetable immediately — synchronously,
 *      no network. paintFromSchedule(lat, lon) does the same WITHOUT polling, so
 *      the home page can open on the PREVIOUS location before any GPS fix.
 *   2. The live call fills in over it. A live card keeps its OBA arrivals first;
 *      stored times that come >=3 min AFTER the last live ETA fill its remaining
 *      slots. A route+direction the timetable serves nearby but live returned
 *      nothing for gets a schedule-only card (scheduled times, or tomorrow's
 *      first departure as `nextDayTimes` when nothing is left today).
 *   3. If the live call fails the board degrades to the timetable alone.
 *   4. setLocation(): a move > 100 m repaints from the timetable for the new
 *      place right away and refreshes live; smaller moves (GPS jitter) don't.
 * Still ONE live request per 20 s; the timetable layer adds no per-cycle calls.
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
 *              etas: [{ms, live}], stopId, stopName, distance,
 *              scheduled?: true,       // built from the timetable alone (no live behind it)
 *              nextDayTimes?: [ms] } ],// nothing left today → tomorrow's first departure
 *   situations: [ raw situation objects ],
 *   stopIds: [...],
 *   fetchedAt: <ms>,
 *   ok: <bool>,
 *   usedFallback: <bool>,             // live call failed → board is timetable-only
 *   source: 'live' | 'schedule',      // what this board was built from
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
  const RELOCATE_M = 100;   // moving farther than this repaints + refreshes immediately
  const WARM_MOVE_M = 250;  // moving farther than this re-aims background timetable building

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

  const MERGE_GAP_MS = 3 * 60000;

  /**
   * THE rule for combining live ETAs with the stored timetable (shared: the
   * Nearby / Station boards use it per card, the route detail page uses it for its
   * pills, so they cannot drift apart): live ETAs first; stored times that come
   * strictly later than the last live ETA (+3 min) fill the remaining slots,
   * marked live:false. With no live ETA the upcoming stored times fill all slots.
   * Capped at MAX_ETAS_PER_CARD. `schedTimes` must be ascending epoch-ms.
   */
  function mergeEtas(liveEtas, schedTimes) {
    const now = Date.now();
    const out = (liveEtas || []).slice();
    if (out.length < MAX_ETAS_PER_CARD && schedTimes && schedTimes.length) {
      const after = out.length ? out[out.length - 1].ms + MERGE_GAP_MS : now - 60000;
      for (const t of schedTimes) {            // ascending
        if (out.length >= MAX_ETAS_PER_CARD) break;
        if (t > after) out.push({ ms: t, live: false });
      }
    }
    return out.slice(0, MAX_ETAS_PER_CARD);
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
    let _lastRaw = null;     // last good live response, so a timetable update can recompose the board with no network
    let _tickSeq = 0;        // newest tick wins; older in-flight responses are dropped
    let _progTimer = null;   // debounce for background-warm recomposes
    let _schedLat = null, _schedLon = null;   // where the last schedule-only paint was made
    const _headsigns = {};   // key -> headsign last seen on a LIVE card (so schedule-built cards read the same)
    const _subs = [];

    /** Group raw LIVE arrivals into route+direction cards; each carries ALL of its owning stop's ETAs (capped later, in _compose). */
    function _liveCards(feed) {
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
        // Dedupe identical times, soonest first. NOT capped here: _compose()
        // merges the stored schedule in behind these, then caps at 3.
        const seen = new Set();
        c.etas = own
          .filter(e => { const k = e.ms + '|' + e.live; if (seen.has(k)) return false; seen.add(k); return true; })
          .sort((x, y) => x.ms - y.ms);
        _headsigns[c.key] = c.headsign;   // remembered so a schedule-built card reads the same as the live one
      }
      return cards;
    }

    // ── SCHEDULE-FIRST composition (the v6 model) ───────────────────────────────
    // A card is built from the STORED full-day timetable; live data is filled in
    // over it. So the board is never empty / thinner than the schedule just
    // because the live call is slow, failed, or has nothing in its 90-min window:
    //   • live card  → its OBA arrivals first, then stored times that come LATER
    //                  (≥3 min after the last live ETA) fill the remaining slots;
    //   • no live card for a route+direction that has a stored timetable near
    //     here → a schedule-only card (scheduled times, or tomorrow's first
    //     departure when nothing is left today).
    // The single `arrivals-and-departures-for-location` call is unchanged (still
    // 1 request / 20 s); the timetable layer costs no extra per-cycle requests.

    function _hex(c, fallback) {
      if (!c) return fallback;
      return String(c).charAt(0) === '#' ? String(c) : '#' + c;
    }

    /**
     * Every route+direction the STORE can serve near the point, keyed
     * `routeId|directionName`. The nearest stop that has a stored timetable for
     * that pair owns it. In station mode only the station's own stops count.
     */
    function _scheduleIndex() {
      const out = new Map();
      if (_lat == null || typeof TransitStore === 'undefined' || !TransitStore.getStopsNear) return out;
      for (const s of TransitStore.getStopsNear(_lat, _lon, radius)) {   // nearest first
        if (stopFilter && !stopFilter.has(s.stopId)) continue;
        for (const r of TransitStore.getRoutesAtStop(s.stopId)) {
          const key = r.routeId + '|' + r.directionName;
          if (out.has(key)) continue;
          const times = TransitStore.getScheduleForStop(r.routeId, r.directionName, s.stopId);
          if (!times.length) continue;   // no timetable stored here yet (not warmed) → not a candidate
          out.set(key, {
            routeId: r.routeId, directionName: r.directionName, stopId: s.stopId,
            stopName: s.name || '', lat: s.lat, lon: s.lon, distance: Math.round(s.distance), times,
          });
        }
      }
      return out;
    }

    /** A card built purely from the stored timetable, or null if there's nothing to show. */
    function _scheduleOnlyCard(cand, now) {
      const meta = TransitStore.getRouteMeta && TransitStore.getRouteMeta(cand.routeId);
      if (!meta) return null;
      const upcoming = cand.times.filter(t => t > now - 60000);
      let etas = [], nextDayTimes = null;
      if (upcoming.length) {
        etas = upcoming.slice(0, MAX_ETAS_PER_CARD).map(ms => ({ ms, live: false }));
      } else {
        // Nothing left today → tomorrow's first departure (v6's applyNextDayFromSchedule).
        const nd = TransitStore.getNextDayFirst(cand.routeId, cand.directionName, cand.stopId);
        if (!nd) return null;
        nextDayTimes = [nd];
      }
      const rawName = meta.shortName || meta.longName || '?';
      const shortName = (typeof CardRender !== 'undefined')
        ? CardRender.parseRoute(rawName)
        : String(rawName).replace(/\s*Line$/i, '').replace(/\s*Streetcar$/i, '').trim();
      const cls = classify(meta.type, meta.agencyId, rawName);
      const key = cand.routeId + '|' + cand.directionName;
      const card = {
        key,
        routeId: cand.routeId,
        route: shortName,
        headsign: _headsigns[key] || cand.directionName,
        mode: cls.mode, tag: cls.tag, badge: cls.badge, isSwift: !!cls.isSwift,
        color: _overrideColor(_hex(meta.color, '#666')),
        textColor: _hex(meta.textColor, '#fff'),
        etas,
        directionName: cand.directionName,
        stopId: cand.stopId, stopName: cand.stopName,
        stopLat: cand.lat, stopLon: cand.lon,
        distance: cand.distance,
        scheduled: true,   // built from the timetable, no live data behind it
      };
      if (nextDayTimes) card.nextDayTimes = nextDayTimes;
      return card;
    }

    /** live cards (may be []) + the stored timetable → the final, sorted board. */
    function _compose(liveCards) {
      const now = Date.now();
      const cards = liveCards;
      const haveLive = new Set(cards.map(c => c.key));
      // 1) Fill each live card's remaining slots from the timetable at ITS stop.
      for (const c of cards) {
        let etas = c.etas;
        if (etas.length < MAX_ETAS_PER_CARD && c.directionName && typeof TransitStore !== 'undefined') {
          etas = mergeEtas(etas, TransitStore.getScheduleForStop(c.routeId, c.directionName, c.stopId));
        }
        c.etas = etas.slice(0, MAX_ETAS_PER_CARD);
      }
      // 2) Cards for route+directions the timetable serves nearby but live didn't return.
      for (const [key, cand] of _scheduleIndex()) {
        if (haveLive.has(key)) continue;
        const card = _scheduleOnlyCard(cand, now);
        if (card) cards.push(card);
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
          // Cards with no upcoming ETA (incl. "tomorrow" cards) sink to the bottom.
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

    /** Board from a live response, with the stored timetable merged in. */
    function _buildCards(feed) { return _compose(_liveCards(feed)); }

    /** Board from the stored timetable alone (no network): the first paint, and the degrade path. */
    function _scheduleCards() { return _compose([]); }

    /**
     * Build the local timetable store in the background, nearest stops first, a
     * little at a time (ScheduleCache.warmAround). When a batch lands, recompose
     * the board from what we already have so new timetable data shows up without
     * waiting for the next tick or making any request.
     */
    function _warm() {
      if (typeof ScheduleCache === 'undefined' || !ScheduleCache.warmAround || _lat == null) return;
      try {
        ScheduleCache.warmAround(_lat, _lon, {
          stopIds: stopFilter ? Array.from(stopFilter) : null,
          onProgress: _onWarmProgress,
        });
      } catch (e) { /* warming is best-effort */ }
    }
    function _onWarmProgress() {
      if (_stopped) return;
      clearTimeout(_progTimer);
      _progTimer = setTimeout(() => {
        if (_stopped || _lat == null) return;
        if (_lastRaw) _publish(_buildCards(_lastRaw), { feed: _lastRaw, source: 'live' });
        else _paintScheduleNow();
      }, 800);
    }

    /** Resolve the store's direction name for a route + headsign (best match). */
    function _directionNameFor(routeId, headsign) {
      if (typeof TransitStore === 'undefined') return '';
      try {
        const dir = TransitStore.getDirection(routeId, headsign);
        return (dir && dir.name) ? dir.name : '';
      } catch (e) { return ''; }
    }

    function _publish(cards, opts) {
      opts = opts || {};
      const feed = opts.feed || null;
      const snapshot = {
        cards,
        situations: feed ? (feed.situations || []) : ((_last && _last.situations) || []),
        stopIds: feed ? (feed.stopIds || []) : ((_last && _last.stopIds) || []),
        fetchedAt: Date.now(),
        ok: opts.ok !== false,
        usedFallback: !!opts.usedFallback,
        // 'live'     — built from a live response (stored timetable merged in)
        // 'schedule' — built from the stored timetable alone (first paint / live call failed)
        source: opts.source || 'live',
      };
      _last = snapshot;
      _emit(snapshot);
      return snapshot;
    }

    /** Paint the board from the stored timetable alone — instant, no network. Returns the card count. */
    function _paintScheduleNow() {
      if (_lat == null) return 0;
      const cards = _scheduleCards();
      _schedLat = _lat; _schedLon = _lon;
      if (!cards.length) return 0;
      _publish(cards, { feed: null, ok: true, source: 'schedule' });
      return cards.length;
    }

    async function _tick() {
      if (_stopped || _lat == null) return;
      const seq = ++_tickSeq;
      const feed = await TransitAPI.fetchArrivalsForLocation(_lat, _lon, radius);
      // Stopped meanwhile, or a newer tick (e.g. after the user moved) superseded
      // this response — don't let a stale one overwrite a fresher board.
      if (_stopped || seq !== _tickSeq) return;

      if (feed.ok !== false) {
        _lastRaw = feed;
        _publish(_buildCards(feed), { feed, ok: true, source: 'live' });
      } else {
        // Live call failed → degrade to the stored timetable (v6: degrade-to-schedule),
        // so the board still shows departures instead of going blank.
        const cards = _scheduleCards();
        _publish(cards, { feed: null, ok: false, usedFallback: cards.length > 0, source: 'schedule' });
      }
    }

    function _emit(snapshot) {
      for (const cb of _subs) { try { cb(snapshot); } catch (e) { /* isolate */ } }
    }

    function onUpdate(cb) {
      _subs.push(cb);
      if (_last) { try { cb(_last); } catch (e) {} }
      return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); };
    }

    /**
     * Start polling around a location. Order matters (schedule-first):
     *   1. paint the board from the stored timetable immediately (no network),
     *   2. kick off background timetable building around here,
     *   3. fetch live data and fill it in over the schedule; then every intervalMs.
     */
    function start(lat, lon) {
      if (_timer || _stopped) return;
      _lat = lat; _lon = lon;
      // Paint now unless we already hold a board for (about) this place — a seeded
      // snapshot, or a schedule paint from the remembered location that this fix
      // hasn't moved away from.
      if (!_last || (_schedLat != null && _haversine(_schedLat, _schedLon, lat, lon) > RELOCATE_M)) {
        _paintScheduleNow();
      }
      _warm();
      _tick();
      _timer = setInterval(_tick, intervalMs);
    }

    /**
     * Schedule-only first paint WITHOUT starting to poll — used to open the home
     * board on the PREVIOUS location before the first GPS fix arrives. The first
     * real fix then calls setLocation()/start(), which repaints if it differs and
     * fetches live. Returns the number of cards painted.
     */
    function paintFromSchedule(lat, lon) {
      if (_stopped) return 0;
      _lat = lat; _lon = lon;
      const n = _paintScheduleNow();
      _warm();
      return n;
    }

    /** Give a fresh feed the board the page was already showing, so a resume doesn't flash schedule-only. */
    function seed(snapshot) { if (!_last && snapshot && snapshot.cards) _last = snapshot; }

    /**
     * Move the centre point. The first call starts the feed. After that, a move of
     * more than RELOCATE_M repaints the board for the new place from the timetable
     * right away and refreshes live data, instead of waiting for the next tick.
     */
    function setLocation(lat, lon) {
      if (_stopped) return;
      if (!_timer) { start(lat, lon); return; }
      const moved = (_lat == null) ? Infinity : _haversine(_lat, _lon, lat, lon);
      _lat = lat; _lon = lon;
      if (moved > RELOCATE_M) {
        _paintScheduleNow();
        if (moved > WARM_MOVE_M) _warm();
        _tick();
      }
    }

    /** Force an immediate refresh (e.g. pull-to-refresh). */
    function refresh() { return _tick(); }

    function stop() {
      _stopped = true;
      _tickSeq++;
      clearTimeout(_progTimer);
      if (_timer) { clearInterval(_timer); _timer = null; }
      _subs.length = 0;
    }

    return { onUpdate, start, paintFromSchedule, seed, setLocation, refresh, stop, getLast: () => _last };
  }

  return { create, mergeEtas };
})();
