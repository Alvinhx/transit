/**
 * detail.js — Route Detail page (main-next)
 *
 * Consumer of MapSheetTemplate + LiveFeed. Rebuild of Main's route-detail.js,
 * template-first, per the recorded v2.1 design:
 *   - Map is FIXED full-viewport, framed ONCE into the upper-2/3 focus region,
 *     then frozen. Sheet drag/scroll never touches the map.
 *   - ONE LiveFeed poll (20s) drives BOTH vehicle markers AND live ETAs.
 *   - Scheduled times come from TransitStore (zero extra calls).
 *   - Clean teardown on close: stop feed, offLocationUpdate, remove map.
 *
 * Depends on globals (loaded before this file):
 *   L (Leaflet), AppState, TransitAPI, TransitStore, TransitLogic helpers
 *   (decodePolyline, findNearestStop), MapSheetTemplate, LiveFeed.
 */

const DetailPage = (function () {
  'use strict';

  // Focus grid geometry for phase 3 is defined below (_QUAD + band insets).

  // Badge/tag tones now come from the shared RouteTones token module (full
  // 11-color palette) — the detail page's own 4-color TONES subset was removed
  // in the design-system refactor. (ROUTE_TONE_MAP below is a DIFFERENT thing:
  // the map polyline t80/t40 shades, not the badge surfaces — kept as-is.)

  // Route tone map (from Main): t80 = lighter "passed" segment, t40 = vivid "upcoming".
  const ROUTE_TONE_MAP = {
    '#3DAE2B': { t80: '#A8E09E', t40: '#328f23' },
    '#00A0DF': { t80: '#80D0EF', t40: '#0080b2' },
    '#E5007D': { t80: '#F280BE', t40: '#ca006e' },
    '#9C182F': { t80: '#CD8C97', t40: '#891428' },
    '#2B376E': { t80: '#959BB7', t40: '#263061' },
    '#FDB71A': { t80: '#FEDB8D', t40: '#dfa117' },
    '#F47836': { t80: '#FABC9B', t40: '#d1651d' },
    '#006CFF': { t80: '#80B6FF', t40: '#005fe0' },
    '#0070C0': { t80: '#80B8E0', t40: '#005fe0' },
    '#666672': { t80: '#B3B3B9', t40: '#5a5a65' },
  };
  function _routeColors() {
    const api = _routeColor();
    const t = ROUTE_TONE_MAP[api.toUpperCase()] || ROUTE_TONE_MAP[api] || null;
    return { upcoming: t ? t.t40 : api, base: t ? t.t80 : '#cccccc' };
  }

  let _state = null; // { page, map, routeId, direction, allStops, nearestStopId, feed, unsubFeed, locCb, vehicleMarkers, userMarker, baseLayer, upcomingLayer, stopMarkers }
  // History-based back (step A): detail pushes ONE history entry on open, so the
  // browser/OS back gesture (swipe) or Back button pops it → we close the detail
  // and stay in the app instead of navigating away from the site. The X button
  // routes through history.back() so the stack stays balanced. (Step B — making
  // station-mode back-to-home — will push its own entry underneath this one.)
  let _popHandler = null, _historyPushed = false, _closingViaPop = false;

  function _isLight() { return typeof AppState !== 'undefined' ? AppState.isLight : false; }
  function _tileUrl() { return typeof AppState !== 'undefined' ? AppState.getMapTileUrl() : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'; }
  // v6 recenter mechanism: hide the locate button while the map is centered on
  // the focus point; show it once the user drags away. Same as Main-v6's
  // _showLocateButton (route-detail.js) — toggles the `hidden` class.
  function _setLocateVisible(v) {
    const b = document.getElementById('dp-locate');
    if (b) b.classList.toggle('hidden', !v);
  }
  function _screenH() { return typeof AppState !== 'undefined' ? AppState.screenH : window.innerHeight; }

  function _routeColor() { return (_state && _state.cardData && _state.cardData.color) || '#FDB71A'; }
  function _upcomingColor() { return _routeColors().upcoming; }

  // ── Build the overlay chrome (badge + action buttons) ──────────────────────
  function _buildOverlay(g) {
    const theme = _isLight() ? 'light' : 'dark';
    const tones = RouteTones.for(g.color, theme);

    // Badge + company chip now come from the shared design-system atoms (detail
    // size), so the detail header and the card render through the SAME code.
    // RouteBadge picks the icon-vs-number variant itself; RouteTones supplies the
    // themed surfaces (full 11-color palette — the detail page used to carry a
    // 4-color subset, so unmapped colors now get their real tone here too).
    const badge = RouteBadge.html({
      route: g.route, mode: g.mode, badge: g.badge,
      color: g.color, textColor: g.textColor, size: 'detail',
    });
    const tag = RouteTag.html({ tag: g.tag, bg: tones.tagBg, color: tones.tagTxt, size: 'detail' });

    const wrap = document.createElement('div');
    wrap.className = 'dp-overlay-top';
    wrap.innerHTML = `
      <div class="dp-badge-card" style="background:${tones.card}">
        ${badge}
        <div class="dp-badge-info">
          ${tag}
          <div class="dp-badge-dir" style="color:${tones.tagTxt}">${g.headsign || ''}</div>
        </div>
      </div>
      <div class="dp-actions">
        <button class="dp-btn" id="dp-close" aria-label="Close"><span class="material-icons" style="font-size:20px">close</span></button>
        <button class="dp-btn dp-alert hidden" id="dp-alerts" aria-label="Service alerts"><span class="material-icons" style="font-size:20px">warning_amber</span><span class="dp-alert-count" id="dp-alert-count">0</span></button>
        <button class="dp-btn" id="dp-zin" aria-label="Zoom in" style="font-size:22px">+</button>
        <button class="dp-btn" id="dp-zout" aria-label="Zoom out" style="font-size:22px">−</button>
        <button class="dp-btn hidden" id="dp-locate" aria-label="My location"><span class="material-icons" style="font-size:20px">navigation</span></button>
      </div>`;
    return wrap;
  }

  function _buildSheetHeader() {
    const el = document.createElement('div');
    el.className = 'dp-etas-row';
    el.innerHTML = `
      <div class="dp-etas-info">
        <div class="dp-dir-label" id="dp-dir-label">Loading…</div>
        <div class="dp-stop-label" id="dp-stop-label"></div>
      </div>
      <div class="dp-etas-pills" id="dp-etas-pills"></div>`;
    return el;
  }

  function _buildSheetBody() {
    const el = document.createElement('div');
    el.innerHTML = `<div class="dp-divider"></div><div class="dp-stops-wrap" id="dp-stops"><div class="dp-loading">Loading stops…</div></div>`;
    return el;
  }

  // ── ETA rendering ───────────────────────────────────────────────────────────
  // Pure render: paint the direction/stop labels + up to 3 ETA pills from a list
  // of { ms, live }. No data fetching — callers supply the etas.
  function _renderEtaPills(etas) {
    if (!_state) return;
    const pills = document.getElementById('dp-etas-pills');
    const dirLabel = document.getElementById('dp-dir-label');
    const stopLabel = document.getElementById('dp-stop-label');
    if (!pills) return;
    const nearest = _state.allStops.find(s => s.stopId === _state.nearestStopId);
    const dirName = _state.direction ? _state.direction.name : (_state.cardData ? _state.cardData.headsign : '');
    if (dirLabel) dirLabel.textContent = dirName || 'Route';
    if (stopLabel && nearest) stopLabel.textContent = `Next from ${nearest.name || 'nearby stop'}`;
    _state.etaShown = !!(etas && etas.length);
    if (!etas || !etas.length) {
      const next = _nextDepartureText();
      pills.innerHTML = `<span style="color:var(--dim);font-size:13px">${next || 'No upcoming departures'}</span>`;
      return;
    }
    pills.innerHTML = etas.slice(0, 3).map((e, i) => EtaPill.html({ eta: e, idx: i, size: 'detail' })).join('');
  }
  // Instant seed so the readout is never blank on open: the card's ETAs (exactly
  // what the board showed) when present, else the store schedule as a placeholder.
  // _refreshStopEtas() then replaces this with fresh real-time data.
  function _seedEtas() {
    if (!_state) return;
    const c = _state.cardData;
    if (c && c.etas && c.etas.length) { _renderEtaPills(c.etas); return; }
    const etas = _composeDetailEtas();
    if (etas.length) _renderEtaPills(etas);
  }
  // Stored timetable for the anchored stop in THIS direction (ascending epoch-ms,
  // re-based onto today by TransitStore). [] when nothing is stored yet.
  function _scheduleTimes() {
    if (!_state || !_state.nearestStopId || !_state.direction || typeof TransitStore === 'undefined') return [];
    return TransitStore.getScheduleForStop(_state.routeId, _state.direction.name, _state.nearestStopId) || [];
  }
  // Schedule-first pills (same rule as the board): live ETAs first, then stored
  // times that come >3 min after the last live ETA fill the remaining slots.
  // Only times inside the 90-min card display window are used.
  function _composeDetailEtas() {
    const now = Date.now();
    const sched = _scheduleTimes().filter(t => t > now && t <= now + 90 * 60000);
    const live = (_state && _state.liveEtas) || [];
    if (typeof StopFeed !== 'undefined' && StopFeed.mergeEtas) return StopFeed.mergeEtas(live, sched);
    return live.length ? live : sched.slice(0, 3).map(ms => ({ ms, live: false }));
  }
  // Shown when no departure falls in the window: the next one (usually tomorrow).
  function _nextDepartureText() {
    if (!_state || !_state.direction || typeof TransitStore === 'undefined') return '';
    const now = Date.now();
    let t = _scheduleTimes().find(x => x > now);
    let tomorrow = false;
    if (!t && TransitStore.getNextDayFirst) { t = TransitStore.getNextDayFirst(_state.routeId, _state.direction.name, _state.nearestStopId); tomorrow = true; }
    if (!t || typeof TransitCard === 'undefined' || !TransitCard.formatTime) return '';
    return `Next departure ${TransitCard.formatTime(t)}${tomorrow ? ' (tomorrow)' : ''}`;
  }
  // Real-time ETAs for the anchored stop, from the SAME source the board uses —
  // arrivals-and-departures-for-stop (real per-stop predictions) filtered to this
  // route — so the detail page and the board always agree. This replaced the old
  // trips-for-route schedule+deviation approximation (a regression from the
  // "one poll drives vehicles + ETAs" rebuild). Runs on the live feed's 20s tick,
  // which fixes the original "ETAs never refresh" bug while keeping them accurate.
  // The card you tapped already fixed the direction (_state.direction), but this
  // request is per STOP, and a stop can serve both directions of a route (e.g. the
  // First Hill streetcar stop) — so keep only arrivals that belong to THIS direction.
  // Uses the same headsign → direction match the cards group by, so the pills agree
  // with the card. An arrival with no headsign, or one we can't classify, is kept.
  function _arrivalMatchesDirection(a) {
    const dir = _state && _state.direction;
    if (!dir || !a.tripHeadsign || typeof TransitStore === 'undefined') return true;
    const d = TransitStore.getDirection(_state.routeId, a.tripHeadsign);
    return !d || d === dir || d.name === dir.name;
  }
  async function _refreshStopEtas() {
    if (!_state) return;
    const stopId = _state.nearestStopId;
    if (!stopId || typeof stopId !== 'string' || !stopId.includes('_')) return;
    if (typeof TransitAPI === 'undefined' || !TransitAPI.fetchArrivalsForStop) return;
    // One cheap call (once per anchor stop) so the timetable fill works quickly
    // without waiting on the route-wide warm.
    if (_state._warmedStop !== stopId && typeof ScheduleCache !== 'undefined' && ScheduleCache.ensureStop) {
      _state._warmedStop = stopId;
      ScheduleCache.ensureStop(stopId).then(n => {
        if (n && _state && _state.nearestStopId === stopId) _renderEtaPills(_composeDetailEtas());
      }).catch(() => {});
    }
    let j;
    try { j = await TransitAPI.fetchArrivalsForStop(stopId); }
    catch (e) {
      // Live failed: timetable stands in, but never overwrite pills already shown.
      if (_state && _state.nearestStopId === stopId && !_state.etaShown) _renderEtaPills(_composeDetailEtas());
      return;
    }
    if (!_state || _state.nearestStopId !== stopId) return; // page closed or anchor changed while fetching
    const now = Date.now();
    const list = (j && j.data && j.data.entry && j.data.entry.arrivalsAndDepartures) || [];
    const etas = list
      .filter(a => a.routeId === _state.routeId && _arrivalMatchesDirection(a))
      .map(a => ({ ms: a.predictedDepartureTime || a.scheduledDepartureTime || 0, live: !!a.predictedDepartureTime }))
      .filter(a => a.ms > now - 30000)
      .sort((a, b) => a.ms - b.ms);
    _state.liveEtas = etas;
    _renderEtaPills(_composeDetailEtas());
  }

  // ── Vehicle markers from a LiveFeed snapshot ───────────────────────────────
  // Markers PERSIST across the 20s ticks (keyed by vehicleId/tripId) and glide to
  // each new position, instead of being destroyed + recreated every refresh —
  // which teleported the bus and flashed it off/on. A short grace tolerates a
  // single-poll OBA dropout so the bus doesn't blink out and back.
  const _VEHICLE_TWEEN_MS = 1500;      // glide duration to the newly reported spot
  const _VEHICLE_MISS_LIMIT = 2;       // remove only after absent this many consecutive polls

  // Smoothly move a marker to (toLat,toLon) over `duration` via rAF-interpolated
  // setLatLng. Using setLatLng (not a CSS transform transition) means panning /
  // zooming the map never makes the marker lag — each frame sets a real latlng.
  function _animateMarkerTo(marker, toLat, toLon, duration) {
    duration = duration || _VEHICLE_TWEEN_MS;
    if (marker._raf) { cancelAnimationFrame(marker._raf); marker._raf = null; }
    const start = marker.getLatLng();
    const fromLat = start.lat, fromLon = start.lng;
    if (Math.abs(fromLat - toLat) < 1e-7 && Math.abs(fromLon - toLon) < 1e-7) return; // no move
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    function step(now) {
      let p = (now - t0) / duration;
      if (p < 0) p = 0; else if (p > 1) p = 1;
      marker.setLatLng([fromLat + (toLat - fromLat) * p, fromLon + (toLon - fromLon) * p]);
      marker._raf = (p < 1) ? requestAnimationFrame(step) : null;
    }
    marker._raf = requestAnimationFrame(step);
  }

  function _vehicleKey(v) { return String(v.vehicleId || v.tripId || (v.lat + ',' + v.lon)); }

  // Does this vehicle belong to the direction being displayed?
  //  - Normal directions carry the OBA directionId → compare it.
  //  - BRANCH / LIMITED-SERVICE directions (e.g. Route 49 "3rd & Jackson", the
  //    Route 11 / Link 40_97 split directions) have NO directionId in
  //    routes-data.json, so the old check silently passed every bus in BOTH
  //    directions. For those, resolve the vehicle's headsign to a stored
  //    direction with the same word-match the cards use (TransitStore.getDirection)
  //    and require it to be THIS direction.
  function _vehicleMatchesDirection(v) {
    const dir = _state.direction;
    if (!dir) return true;
    const vDir = v.directionId;
    const vKnown = vDir !== undefined && vDir !== null && vDir !== '';
    if (dir.directionId != null) return !vKnown || String(vDir) === String(dir.directionId);
    if (!v.tripHeadsign || typeof TransitStore === 'undefined') return true;   // can't classify → keep
    const d = TransitStore.getDirection(_state.routeId, v.tripHeadsign);
    return !d || d === dir || d.name === dir.name;
  }

  function _renderVehicles(snapshot) {
    if (!_state || !_state.map) return;
    const markers = _state.vehicleMarkers; // { id -> L.marker }
    const mode = _state.cardData ? _state.cardData.mode : 'bus';
    // Shared mapping — the local copy this replaced rendered the MONORAIL as a
    // bus, since it only special-cased rail and streetcar.
    const iconName = (typeof CardRender !== 'undefined')
      ? CardRender.vehicleGlyph(mode)
      : (mode === 'rail' ? 'train' : mode === 'streetcar' ? 'tram' : 'directions_bus');
    const color = _upcomingColor();

    const seen = new Set();      // vehicles we are DISPLAYING this tick
    const present = new Set();   // every vehicle in the snapshot (shown or filtered)
    (snapshot.vehicles || []).forEach(v => {
      if (!v.lat && !v.lon) return;
      present.add(_vehicleKey(v));
      if (!_vehicleMatchesDirection(v)) return;
      const id = _vehicleKey(v);
      seen.add(id);
      const existing = markers[id];
      if (existing) {
        existing._miss = 0;
        _animateMarkerTo(existing, v.lat, v.lon);                      // glide to the new spot
        existing.setPopupContent(`<b>${v.tripHeadsign || 'In service'}</b>`);
      } else {
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:32px;height:32px;border-radius:50%;background:#fff;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.2)"><span class="material-icons" style="font-size:18px;color:${color}">${iconName}</span></div>`,
          iconSize: [32, 32], iconAnchor: [16, 16],
        });
        const marker = L.marker([v.lat, v.lon], { icon, zIndexOffset: 1000 }).addTo(_state.map);
        marker.bindPopup(`<b>${v.tripHeadsign || 'In service'}</b>`);
        marker._miss = 0;
        markers[id] = marker;                                          // created at position — no glide-in
      }
    });

    // Remove markers no longer shown. Two cases:
    //  - still in the snapshot but now FILTERED (direction flipped at a terminal,
    //    stale, wrong direction) → remove IMMEDIATELY, it's deliberately hidden;
    //  - absent from the snapshot entirely → keep through a short grace
    //    (a single-poll OBA dropout would otherwise blink the bus off then on).
    Object.keys(markers).forEach(id => {
      if (seen.has(id)) return;
      const m = markers[id];
      m._miss = present.has(id) ? _VEHICLE_MISS_LIMIT : (m._miss || 0) + 1;
      if (m._miss >= _VEHICLE_MISS_LIMIT) {
        if (m._raf) cancelAnimationFrame(m._raf);
        _state.map.removeLayer(m);
        delete markers[id];
      }
    });
  }

  // ── Alert badge — shown only when the route has ACTIVE alerts ──────────────
  // Alerts arrive on the same 20s LiveFeed snapshot (zero extra requests).
  function _renderAlertBadge(snapshot) {
    if (!_state) return;
    const btn = document.getElementById('dp-alerts');
    const countEl = document.getElementById('dp-alert-count');
    if (!btn || !countEl) return;

    const alerts = (snapshot && snapshot.alerts) || [];
    _state.alerts = alerts;

    if (!alerts.length) {
      btn.classList.add('hidden');
    } else {
      btn.classList.remove('hidden');
      countEl.textContent = String(alerts.length);
    }

    // Keep an open alert page in sync with the latest feed tick.
    if (typeof AlertsPage !== 'undefined' && AlertsPage.isOpen()) AlertsPage.update(alerts);
  }

  function _openAlerts() {
    if (!_state || typeof AlertsPage === 'undefined') return;
    const g = _state.cardData || {};
    const label = [g.route, g.headsign].filter(Boolean).join(' — ');
    AlertsPage.open({ routeLabel: label, alerts: _state.alerts || [] });
  }

  // ── Draw the route: base (passed, lighter) + upcoming overlay (vivid) + stop
  //    dots styled passed/current/upcoming. Ported from Main's _drawBaseLayer +
  //    _drawUpcomingOverlay. Called on first draw and again once nearest is known.
  function _drawRoute() {
    const dir = _state.direction;
    if (!dir || !_state.map) return;
    const { base: baseColor, upcoming: upcomingColor } = _routeColors();

    // Clear existing route layers + stop markers
    if (_state.baseLayer) { _state.map.removeLayer(_state.baseLayer); _state.baseLayer = null; }
    if (_state.upcomingLayer) { _state.map.removeLayer(_state.upcomingLayer); _state.upcomingLayer = null; }
    _state.stopMarkers.forEach(m => _state.map.removeLayer(m));
    _state.stopMarkers = [];

    const coords = (dir.polyline && typeof decodePolyline === 'function') ? decodePolyline(dir.polyline) : [];
    const stopCoords = _state.allStops.filter(s => s.lat || s.lon).map(s => [s.lat, s.lon]);

    // Base layer = full route in the lighter "passed" tone.
    if (coords.length > 1) {
      _state.baseLayer = L.polyline(coords, { color: baseColor, weight: 8, opacity: 1 }).addTo(_state.map);
    } else if (stopCoords.length > 1) {
      _state.baseLayer = L.polyline(stopCoords, { color: baseColor, weight: 8, opacity: 1 }).addTo(_state.map);
    }

    const nearestIdx = _state.nearestStopId != null
      ? _state.allStops.findIndex(s => s.stopId === _state.nearestStopId) : -1;

    // Upcoming overlay = nearest → end in the vivid tone (only once nearest known).
    if (nearestIdx >= 0) {
      const nearest = _state.allStops[nearestIdx];
      let upcomingCoords = null;
      if (coords.length > 1 && typeof findSplitIndex === 'function' && nearest) {
        const splitIdx = findSplitIndex(coords, nearest.lat, nearest.lon);
        const seg = coords.slice(splitIdx);
        if (seg.length > 1) upcomingCoords = seg;
      }
      if (!upcomingCoords) {
        const seg = _state.allStops.slice(nearestIdx).filter(s => s.lat || s.lon).map(s => [s.lat, s.lon]);
        if (seg.length > 1) upcomingCoords = seg;
      }
      if (upcomingCoords) {
        _state.upcomingLayer = L.polyline(upcomingCoords, { color: upcomingColor, weight: 8, opacity: 1 }).addTo(_state.map);
      }
    }

    // Stop dots — passed / current / upcoming distinction.
    _state.allStops.forEach((stop, idx) => {
      if (!stop.lat && !stop.lon) return;
      const isCurrent = stop.stopId === _state.nearestStopId;
      const isPassed = nearestIdx >= 0 && idx < nearestIdx;
      let fillColor = '#ffffff', strokeColor, radius, strokeWeight;
      if (isCurrent) { strokeColor = upcomingColor; radius = 6; strokeWeight = 3; }
      else if (isPassed) { strokeColor = baseColor; radius = 3; strokeWeight = 2; }
      else { strokeColor = upcomingColor; radius = 3; strokeWeight = 2; }
      const m = L.circleMarker([stop.lat, stop.lon], { radius, color: strokeColor, fillColor, fillOpacity: 1, weight: strokeWeight }).addTo(_state.map);
      m.bindPopup(`<b>${stop.name || stop.stopId}</b>`);
      _state.stopMarkers.push(m);
    });

    _drawUserConnector();
  }

  // ── Dashed connector from the GPS dot to the nearest stop (from Main) ───────
  function _drawUserConnector() {
    if (!_state || !_state.map) return;
    if (_state.userLine) { _state.map.removeLayer(_state.userLine); _state.userLine = null; }
    const sf = _stationFocus();
    if (sf && sf.gpsFar) return; // origin-focused view — don't draw a line to an off-screen GPS dot
    const lat = AppState.userLat, lon = AppState.userLon;
    const nearest = _state.allStops.find(s => s.stopId === _state.nearestStopId);
    if (lat == null || !nearest || !(nearest.lat || nearest.lon)) return;
    _state.userLine = L.polyline([[lat, lon], [nearest.lat, nearest.lon]], {
      color: '#3B82F6', weight: 2, opacity: 0.7, dashArray: '6,6',
    }).addTo(_state.map);
  }

  // ── User dot ───────────────────────────────────────────────────────────────
  function _updateUserDot() {
    if (!_state || !_state.map) return;
    const lat = AppState.userLat, lon = AppState.userLon;
    if (lat == null) return;
    if (_state.userMarker) { _state.userMarker.setLatLng([lat, lon]); }
    else { _state.userMarker = L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1 }).addTo(_state.map); }
    _drawUserConnector();
  }
  // ── Origin dot (station context) ────────────────────────────────────────────
  // When you opened this page from a STATION whose stop is far from where you
  // actually are, drop a distinct violet dot on that origin stop so it's obvious
  // the times are for THAT stop while the blue dot shows where YOU are. Skipped
  // when you're within ~250m (the current-stop highlight already covers it) or
  // outside station context.
  function _updateOriginDot() {
    if (!_state || !_state.map) return;
    if (_state.originMarker) { _state.map.removeLayer(_state.originMarker); _state.originMarker = null; }
    const sf = _stationFocus();
    if (!sf || !sf.gpsFar) return; // not station context, or you're basically at the stop
    const origin = sf.origin;
    _state.originMarker = L.circleMarker([origin.lat, origin.lon], {
      radius: 9, color: '#ffffff', weight: 3, fillColor: '#7C3AED', fillOpacity: 1,
    }).addTo(_state.map);
    _state.originMarker.bindPopup(`<b>${origin.name || 'Selected stop'}</b><br>Showing departures from this stop`);
  }

  // ══ Phase 3 framing (v2.1) — ported from Main's V2 quadrant logic, retargeted
  //    to the UPPER-2/3 focus box instead of the center-50% area. ══════════════
  //
  // v2.1 focus box = horizontally centered, width W/2 (x ∈ [W/4, 3W/4]), height
  // H/3 in the upper 2/3 (y ∈ [H/6, H/2]). Split into 4 quadrants (each W/4×H/6).
  // The box's bottom edge is at H/2 = the initial sheet top edge, so GPS+nearest
  // (placed inside the box) are never covered by the initial sheet.
  //
  // Position + Zoom rules are UNCHANGED from V2:
  //   - GPS + nearest must fit within ONE quadrant (drives zoom).
  //   - Far apart → zoom out; close → zoom in.
  //   - ≥4 context stops (5 past + 1 upcoming) stay visible.
  // Quadrant selection stays direction/flexible (nearest quadrant to the pair).

  // A quadrant of the focus grid = W/4 wide × H/6 tall (the 2×2 grid spans
  // x ∈ [W/4, 3W/4], y ∈ [H/6, H/2] — bottom edge at the initial sheet line).
  const _QUAD = { xW: 0.25, yH: 1 / 6 };
  const _TOP_INSET = 90;      // clear the badge / action buttons overlay
  const _SIDE_INSET = 30;
  const _UPPER_LIMIT = 0.5;   // content must stay above H/2 (initial sheet edge)

  function _contextStops() {
    const nearestIdx = _state.allStops.findIndex(s => s.stopId === _state.nearestStopId);
    if (nearestIdx >= 0) {
      return _state.allStops.slice(Math.max(0, nearestIdx - 5), nearestIdx + 2).filter(s => s.lat || s.lon);
    }
    return _state.allStops.slice(0, 6).filter(s => s.lat || s.lon);
  }

  // PHASE 3 ONLY. Phases 0–2 (map init, base layer, upcoming overlay, nearest
  // stop) are untouched — this runs after them and only adjusts the VIEW.
  //
  // Sequence (per the v2.1 method):
  //   Step 1 — start from the whole-route view left by phases 0–2.
  //   Step 2 — slowly zoom IN until GPS dot + nearest stop sit in ONE quadrant
  //            (and the focus dots still fit the upper-half band).
  //   Step 3 — move the map up/down so ALL focus dots (GPS + nearest + 5 past +
  //            1 upcoming) are in the UPPER 1/2 of the screen.
  function _frameToFocus() {
    if (!_state || !_state.map || _state.nearestStopId == null) return;
    // "me" = the focus point: GPS when near the reference, else the origin stop
    // (station context) — lets a far station frame its own area with the GPS dot
    // off-screen.
    const fp = _focusPoint();
    if (!fp) return; // nothing to anchor on yet (no GPS and no origin)
    const nearest = _state.allStops.find(s => s.stopId === _state.nearestStopId);
    if (!nearest) return;
    const contextStops = _contextStops();

    // Step 1: whole-route baseline. This is phase 3's own starting point — it
    // does not modify phase 1/2 drawing, it just establishes the zoomed-out view
    // we then zoom in from.
    const allPts = _state.allStops.filter(s => s.lat || s.lon).map(s => [s.lat, s.lon]);
    if (allPts.length > 1) {
      _state.map.fitBounds(L.latLngBounds(allPts), { padding: [30, 40], animate: false });
    }

    // Steps 2 + 3.
    _zoomToQuadrant(fp.lat, fp.lon, nearest, contextStops);
  }

  // STEP 2 — slowly zoom IN from the whole-route view. Two stop conditions:
  //   (a) GPS + nearest must still fit inside ONE quadrant (W/4 × H/6), and
  //   (b) all focus dots must still fit inside the UPPER-HALF band.
  // (b) is what makes step 3's pan always possible (and bounded) — it guarantees
  // the dots can physically fit above H/2 before we try to move them there.
  function _zoomToQuadrant(userLat, userLon, nearestStop, contextStops) {
    if (!_state || !_state.map) return;
    const map = _state.map;
    const size = map.getSize();
    const quadW = size.x * _QUAD.xW;
    const quadH = size.y * _QUAD.yH;
    const bandH = size.y * _UPPER_LIMIT - _TOP_INSET; // usable upper-half height
    const bandW = size.x - 2 * _SIDE_INSET;
    const toPx = (la, lo) => map.latLngToContainerPoint(L.latLng(la, lo));

    const focusPts = [[userLat, userLon], [nearestStop.lat, nearestStop.lon], ...contextStops.map(s => [s.lat, s.lon])];

    function pairFitsQuadrant() {
      const g = toPx(userLat, userLon), s = toPx(nearestStop.lat, nearestStop.lon);
      return Math.abs(g.x - s.x) <= quadW && Math.abs(g.y - s.y) <= quadH;
    }
    function focusBBox() {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [la, lo] of focusPts) {
        const p = toPx(la, lo);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
    }
    function focusFitsBand() {
      const b = focusBBox();
      return b.h <= bandH && b.w <= bandW;
    }

    const midLat = (userLat + nearestStop.lat) / 2, midLon = (userLon + nearestStop.lon) / 2;

    // 2a — zoom OUT while the focus dots are too spread to fit the upper-half
    // band (long routes like Link, where 5 past stops span many miles). Without
    // this, the past stops can never be lifted above the sheet.
    let guard = 0;
    while (!focusFitsBand() && map.getZoom() > 8 && guard++ < 8) {
      map.setView([midLat, midLon], map.getZoom() - 1, { animate: false });
    }

    // 2b — then zoom IN while BOTH hold: pair fits one quadrant, dots fit band.
    guard = 0;
    while (map.getZoom() < 17 && guard++ < 12) {
      const z = map.getZoom();
      map.setView([midLat, midLon], z + 1, { animate: false });
      if (!pairFitsQuadrant() || !focusFitsBand()) {
        map.setView([midLat, midLon], z, { animate: false }); // step back
        break;
      }
    }

    // STEP 3 — move the map so all focus dots sit in the upper 1/2.
    _panContentIntoUpperHalf(focusPts);
  }

  // STEP 3 — move the map up/down (and center horizontally) so ALL focus dots
  // (GPS + nearest + 5 past + 1 upcoming) sit in the UPPER 1/2 of the screen,
  // above the initial sheet edge at H/2. Step 2 guaranteed the dots fit the band,
  // so this shift is small; it is also clamped as a safety net.
  function _panContentIntoUpperHalf(focusPts) {
    if (!_state || !_state.map) return;
    const map = _state.map;
    const size = map.getSize();
    const toPx = (la, lo) => map.latLngToContainerPoint(L.latLng(la, lo));

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [la, lo] of focusPts) {
      const p = toPx(la, lo);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const bandTop = _TOP_INSET;
    const bandBottom = size.y * _UPPER_LIMIT;

    // Vertical: CENTER the dot span inside the upper-half band. Step 2's zoom
    // ended with the pair centered at the viewport middle (= the sheet line at
    // H/2), which read as "too low"; centering in the band lifts the whole set
    // into the visible upper half with even clearance top and bottom.
    // panBy(+y) moves content UP.
    let dy = (minY + maxY) / 2 - (bandTop + bandBottom) / 2;
    // Horizontal: center the dot span.
    let dx = (minX + maxX) / 2 - size.x / 2;

    // Safety clamp — a pan should never exceed one viewport.
    dy = Math.max(-size.y, Math.min(size.y, dy));
    dx = Math.max(-size.x, Math.min(size.x, dx));

    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) map.panBy([dx, dy], { animate: false });
  }

  // ── Data load (phases 1–3) ─────────────────────────────────────────────────
  async function _load() {
    const routeId = _state.routeId;
    // Phase 1 — shape from store (fetch if missing)
    if (!TransitStore.hasRoute(routeId)) {
      try {
        const [stopsJson, shapeJson] = await Promise.allSettled([
          TransitAPI.fetchStopsForRoute(routeId),
          TransitAPI.fetchShapeForRoute(routeId),
        ]);
        if (stopsJson.status === 'fulfilled' && typeof parseRouteDirections === 'function') {
          const shapePoints = shapeJson.status === 'fulfilled' ? (shapeJson.value.data?.entry?.points || null) : null;
          const directions = parseRouteDirections(stopsJson.value, shapePoints);
          TransitStore.saveRoute(routeId, { directions });
        }
      } catch (e) { /* fall through — show what we can */ }
    }
    _state.direction = TransitStore.getDirection(routeId, _state.cardData.headsign);
    if (!_state.direction) { _renderStopsError('No route data found.'); return; }
    _state.allStops = Object.entries(_state.direction.stops || {}).map(([id, s]) => ({ stopId: id, ...s }));

    _drawRoute();
    _renderStopList();

    // Ensure schedule is in the store so live ETAs (schedule + deviation) work
    // independent of the home board. Fetch once if missing (cached 90d).
    _ensureSchedule(routeId); // warm the schedule cache (placeholder + other pages)

    // Phase 2/3 — resolve the anchor stop + framing (needs GPS / origin).
    _resolveNearestAndFrame();

    // ETA readout: seed instantly (card ETAs = what the board showed, else the
    // store schedule) so it's never blank, then replace with a fresh real-time
    // fetch for the anchored stop — the SAME source the board uses, so the detail
    // page and the board agree.
    _seedEtas();
    _refreshStopEtas();

    // Live feed now drives ONLY the map vehicle markers + alert badge.
    _startFeed();
  }

  // The stop this page was opened from in STATION context (the card's own stop),
  // if it's on the loaded route/direction. Null for nearby/GPS entry.
  function _originStopIfStation() {
    const c = _state && _state.cardData;
    const id = (c && c.originIsStation) ? c.originStopId : null;
    return id ? _state.allStops.find(s => s.stopId === id) : null;
  }
  // Distance in metres between two lat/lon points.
  function _distM(aLat, aLon, bLat, bLon) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  // Station context resolved to { origin, gpsFar }, or null when not station
  // context (or the origin stop isn't on the loaded route). gpsFar is true when
  // GPS is unknown OR > 250m from the origin.
  function _stationFocus() {
    const origin = _originStopIfStation();
    if (!origin || !(origin.lat || origin.lon)) return null;
    const lat = AppState.userLat, lon = AppState.userLon;
    const gpsFar = (lat == null) || _distM(lat, lon, origin.lat, origin.lon) > 250;
    return { origin, gpsFar };
  }
  // The point the framing algorithm treats as "me": the GPS dot when you're at
  // (or near) the focused location, otherwise the origin/reference stop — so a
  // FAR station frames the station area (origin + nearest stop) rather than
  // stretching back to your real GPS, even with the GPS dot off-screen. Generic
  // on purpose: a future Option-1 map-tapped reference sets the same focus point.
  // Returns {lat,lon} or null.
  function _focusPoint() {
    const sf = _stationFocus();
    if (sf && sf.gpsFar) return { lat: sf.origin.lat, lon: sf.origin.lon };
    if (AppState.userLat != null) return { lat: AppState.userLat, lon: AppState.userLon };
    if (sf) return { lat: sf.origin.lat, lon: sf.origin.lon }; // no GPS at all → origin
    return null;
  }

  function _resolveNearestAndFrame() {
    // STATION context — anchor on the stop the card was built from, NOT the
    // user's GPS-nearest stop, so the detail page shows the same schedule/live
    // feed as the station card the user just tapped. (Nearby entry has no
    // origin, so it falls through to the GPS path below, unchanged.)
    const originStop = _originStopIfStation();
    if (originStop) {
      _state.nearestStopId = originStop.stopId;
      _renderStopList();     // spine: passed collapse + current stop now known
      _drawRoute();          // current-stop styling on the origin
      _updateUserDot();      // GPS dot still shown when known (connector hidden when far)
      _updateOriginDot();    // violet dot on the origin when GPS is far
      _frameToFocus();       // focus point = origin when GPS far/unknown, else GPS
      _state._framed = true; // fixed anchor — don't let GPS ticks re-frame
      return;
    }

    const lat = AppState.userLat, lon = AppState.userLon;
    if (lat != null && _state.direction && typeof findNearestStop === 'function') {
      const stops = _state.allStops.map(s => ({ stopId: s.stopId, ...s }));
      _state.nearestStopId = findNearestStop(lat, lon, stops);
      _renderStopList();  // spine: passed collapse + current stop now known
      _drawRoute();       // redraw with upcoming overlay + passed/current stop styling now nearest is known
      _updateUserDot();
      _frameToFocus();
      _state._framed = true; // Phase 3 focus done — don't re-fit on later GPS ticks
    } else {
      // No GPS yet — fit whole route as a placeholder (NOT counted as framed, so
      // when GPS arrives we upgrade to the upper-2/3 focus view).
      const pts = _state.allStops.filter(s => s.lat || s.lon).map(s => [s.lat, s.lon]);
      if (pts.length > 1) _state.map.fitBounds(L.latLngBounds(pts), { padding: [40, 60], maxZoom: 14, animate: false });
    }
  }

  function _startFeed() {
    _state.feed = LiveFeed.create({
      routeId: _state.routeId,
      intervalMs: 20000,
    });
    _state.unsubFeed = _state.feed.onUpdate((snap) => {
      if (!_state) return;
      _renderVehicles(snap);
      _refreshStopEtas(); // real-time ETAs from arrivals-for-stop on each 20s tick
      _renderAlertBadge(snap);
    });
    _state.feed.start();
  }

  // Ensure this route's full-day schedule is cached for today's day type.
  // Delegates to the shared ScheduleCache module (also used by the home page),
  // which no-ops when the schedule is already warm.
  function _ensureSchedule(routeId) {
    if (typeof ScheduleCache === 'undefined') return Promise.resolve(false);
    return ScheduleCache.ensure(routeId);
  }

  // ── Stop list — coloured-spine design (ported from v6 _renderStopList) ───────
  // Passed stops (before your nearest stop) collapse behind a "Show N passed stops"
  // button; the nearest stop gets a large dot + bold name; upcoming stops follow.
  // Dot colours are v6's per-route "dot" tones (e.g. 1 Line green is #22C55E, not
  // the map's darker #328f23).
  const _STOP_DOT = {
    '#3DAE2B': '#22C55E', '#00A0DF': '#0080b2', '#FDB71A': '#dfa117', '#9C182F': '#891428',
    '#2B376E': '#263061', '#E5007D': '#ca006e', '#F47836': '#d1651d', '#666672': '#5a5a65',
    '#F24C21': '#b25619', '#006CFF': '#005fe0', '#0070C0': '#005fe0',
  };
  function _hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  function _escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function _stopListColors() {
    const color = String((_state.cardData && _state.cardData.color) || '#22C55E');
    const key = color.toUpperCase();
    const dot = _STOP_DOT[key] || color;
    const light = (typeof RouteTones !== 'undefined') ? RouteTones.isLight() : false;
    // Upcoming track: the route's pastel card tone on light; a translucent dot tint
    // on dark (the dark card tones are too close to the sheet surface to read).
    const lineUp = light
      ? ((typeof RouteTones !== 'undefined' && RouteTones.has(key)) ? RouteTones.for(key, 'light').card : _hexToRgba(dot, 0.18))
      : _hexToRgba(dot, 0.28);
    return { dot, lineUp, linePassed: light ? '#E2E8F0' : '#2d333b' };
  }
  function _renderStopList() {
    const el = document.getElementById('dp-stops');
    if (!el || !_state) return;
    const stops = _state.allStops;
    if (!stops.length) { el.innerHTML = '<div class="dp-error">No stops.</div>'; return; }
    const c = _stopListColors();
    el.style.setProperty('--dps-dot', c.dot);
    el.style.setProperty('--dps-line-up', c.lineUp);
    el.style.setProperty('--dps-line-passed', c.linePassed);

    const nearestIdx = stops.findIndex(s => s.stopId === _state.nearestStopId);
    const passed = nearestIdx > 0 ? stops.slice(0, nearestIdx) : [];
    const ahead = nearestIdx >= 0 ? stops.slice(nearestIdx) : stops;   // no anchor yet → all upcoming
    const open = !!_state.passedOpen;
    const row = (s, state, hasPassed) =>
      `<div class="dps-row dps-row--${state}${state === 'current' && hasPassed ? ' dps-has-passed' : ''}" data-stop-id="${_escHtml(s.stopId)}">` +
        `<div class="dps-spine"><div class="dps-dot dps-dot--${state}"></div></div>` +
        `<div class="dps-content"><div class="dps-name">${_escHtml(s.name || s.stopId)}</div></div>` +
      `</div>`;
    const label = n => open ? '\u2193 Hide passed stops' : `\u2191 Show ${n} passed stop${n > 1 ? 's' : ''}`;

    let html = '<div class="dps-wrap">';
    if (passed.length) {
      html += `<div class="dps-row dps-row--passed"><div class="dps-spine"><div class="dps-dot dps-dot--passed"></div></div>` +
              `<div class="dps-content"><button type="button" class="dps-show-passed" id="dps-toggle">${label(passed.length)}</button></div></div>`;
      html += `<div class="dps-passed-group"${open ? '' : ' style="display:none"'}>${passed.map(s => row(s, 'passed', false)).join('')}</div>`;
    }
    ahead.forEach((s, i) => { html += row(s, (nearestIdx >= 0 && i === 0) ? 'current' : 'upcoming', passed.length > 0); });
    html += '</div>';
    el.innerHTML = html;

    const btn = document.getElementById('dps-toggle');
    if (btn) btn.addEventListener('click', () => {
      _state.passedOpen = !_state.passedOpen;
      const grp = el.querySelector('.dps-passed-group');
      if (grp) grp.style.display = _state.passedOpen ? '' : 'none';
      btn.textContent = _state.passedOpen ? '\u2193 Hide passed stops' : `\u2191 Show ${passed.length} passed stop${passed.length > 1 ? 's' : ''}`;
    });
  }

  function _renderStopsError(msg) {
    const el = document.getElementById('dp-stops');
    if (el) el.innerHTML = `<div class="dp-error">${msg}</div>`;
  }

  // ── Public: open / close ────────────────────────────────────────────────────
  function open(cardData) {
    if (_state) close();
    const routeId = cardData.routeId || null;

    const overlay = _buildOverlay(cardData);
    const header = _buildSheetHeader();
    const body = _buildSheetBody();

    const page = MapSheetTemplate.createMapSheetPage({
      id: 'dp',
      topOverlay: overlay,
      sheetHeader: header,
      sheetBody: body,
      sheet: { initial: 0.5, draggable: true, min: 1 / 3, max: 0.95, onPullRefresh: () => { if (!_state) return null; const p = _state.feed ? _state.feed.refresh() : null; _refreshStopEtas(); return p; } },
      mapController: {
        onReady(mapEl) {
          if (!_state) return;
          const map = L.map(mapEl, { zoomControl: false, attributionControl: false, preferCanvas: true })
            .setView([47.6062, -122.3321], 13);
          L.tileLayer(_tileUrl(), { maxZoom: 19 }).addTo(map);
          map.invalidateSize({ animate: false }); // fixed size known → render now
          _state.map = map;
          // Show the locate button once the user drags the map off the focus
          // point (v6 mechanism). Programmatic framing (setView/fitBounds) does
          // not fire dragstart, so the button stays hidden until a real pan.
          map.on('dragstart', () => _setLocateVisible(true));

          // GPS listener — guarded + unsubscribable (fixes bug 5).
          // Fires immediately if GPS already known (possibly before stops load)
          // and on every update. Only frames once stops are loaded and we
          // haven't framed yet — so the first fix lands as soon as both the
          // route stops AND a GPS position are available.
          _state.locCb = AppState.onLocationUpdate(() => {
            if (!_state || !_state.map) return;
            _updateUserDot();
            _updateOriginDot(); // toggle the origin dot as GPS moves near/far
            if (!_state._framed && _state.allStops && _state.allStops.length) {
              _resolveNearestAndFrame();
            }
          });

          _load();
        },
        onDestroy() {
          // Clean teardown — close any alert page, stop feed, drop listener, remove map.
          // History-based back: detach our popstate listener and reset the flags.
          // (If this close came via a back-pop, the pushed entry is already gone;
          // if via the X button, _requestClose already did history.back().)
          if (_popHandler) { window.removeEventListener('popstate', _popHandler); _popHandler = null; }
          _historyPushed = false; _closingViaPop = false;
          if (typeof AlertsPage !== 'undefined' && AlertsPage.isOpen()) AlertsPage.close();
          if (_state) {
            if (_state.unsubFeed) { try { _state.unsubFeed(); } catch (e) {} }
            if (_state.feed) { try { _state.feed.stop(); } catch (e) {} }
            // Cancel any in-flight vehicle glide animations.
            if (_state.vehicleMarkers) {
              Object.keys(_state.vehicleMarkers).forEach(id => {
                const m = _state.vehicleMarkers[id];
                if (m && m._raf) { try { cancelAnimationFrame(m._raf); } catch (e) {} }
              });
            }
            if (_state.locCb && AppState.offLocationUpdate) AppState.offLocationUpdate(_state.locCb);
            if (_state.map) { try { _state.map.remove(); } catch (e) {} }
          }
          _state = null;
          // Hand polling back to whichever root view is underneath, and restore
          // the mode toggle. Routing this through the shell matters: resuming
          // HomePage unconditionally would restart the nearby feed even when the
          // STATION board is the visible view, leaving two feeds polling at once.
          if (typeof AppShell !== 'undefined') {
            AppShell.onDetailClose();
          } else if (typeof HomePage !== 'undefined' && HomePage.resumeFeed) {
            HomePage.resumeFeed();   // standalone fallback (no shell present)
          }
        },
      },
    });

    _state = {
      page, cardData, routeId,
      map: null, direction: null, allStops: [], nearestStopId: null, _framed: false, alerts: [],
      feed: null, unsubFeed: null, locCb: null,
      vehicleMarkers: {}, userMarker: null, userLine: null, originMarker: null,
      baseLayer: null, upcomingLayer: null, stopMarkers: [],
    };

    page.mount(document.body);

    // History-based back: push one entry, then a back (swipe / button) pops it
    // and the popstate handler closes the detail. Programmatic framing etc. never
    // touch history, so nothing else here affects the stack.
    try { history.pushState({ dpOpen: true }, ''); _historyPushed = true; }
    catch (e) { _historyPushed = false; }
    _closingViaPop = false;
    _popHandler = function () { _closingViaPop = true; close(); };
    window.addEventListener('popstate', _popHandler);

    // Wire overlay buttons
    overlay.querySelector('#dp-close').addEventListener('click', _requestClose);
    overlay.querySelector('#dp-alerts').addEventListener('click', _openAlerts);
    overlay.querySelector('#dp-zin').addEventListener('click', () => { if (_state && _state.map) _state.map.zoomIn(); });
    overlay.querySelector('#dp-zout').addEventListener('click', () => { if (_state && _state.map) _state.map.zoomOut(); });
    overlay.querySelector('#dp-locate').addEventListener('click', () => {
      if (_state && _state.map && AppState.userLat != null) { _state._framed = false; _resolveNearestAndFrame(); _setLocateVisible(false); }
    });
  }

  // X button / programmatic close. If we pushed a history entry, go BACK so the
  // SAME popstate path closes us (keeps the history stack balanced); otherwise
  // (no history, or we're already closing via a pop) close directly.
  function _requestClose() {
    if (_state && _historyPushed && !_closingViaPop) { try { history.back(); return; } catch (e) {} }
    close();
  }

  function close() {
    if (!_state) return;
    const page = _state.page;
    // page.unmount() triggers mapController.onDestroy which nulls _state.
    if (page) page.unmount();
  }

  function isOpen() { return !!_state; }

  // Public close routes through _requestClose so external callers stay balanced.
  return { open, close: _requestClose, isOpen };
})();
