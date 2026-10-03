/**
 * home.js — Home page (main-next)
 *
 * Second consumer of the Map+Sheet template (same template as the detail page):
 *   - Map layer (z0): fixed full-viewport, shows the live GPS dot centred on you.
 *   - Controls (z1): locate / zoom buttons.
 *   - Sheet (z2): info cards for NEARBY transit, soonest departure first.
 *
 * Data comes from StopFeed — ONE `arrivals-and-departures-for-location` call per
 * 20s covering every nearby stop (see lib/stop-feed.js).
 *
 * Tapping a card opens the route detail page.
 *
 * Depends on globals: L (Leaflet), AppState, TransitAPI, MapSheetTemplate,
 * StopFeed, DetailPage.
 */

const HomePage = (function () {
  'use strict';

  let _state = null; // { page, map, feed, unsubFeed, locCb, userMarker, stopMarkers, cards }

  // Default sheet height as a fraction of the screen (covers the bottom 2/3).
  // Used BOTH for the sheet's initial snap AND to place the GPS dot in the
  // visible map above it, so the two can't drift apart.
  const SHEET_INITIAL = 0.66;
  // Nearby scan radius in metres — how far out the home board looks for stops.
  // Kept as a single named constant (not a magic number) so it can graduate to a
  // user-configurable setting later. Keep it ≤450: OBA's location endpoint caps
  // at 250 arrivals and starts dropping stops past ~500m (see stop-feed.js).
  const NEARBY_RADIUS_M = 300;

  function _tileUrl() {
    return typeof AppState !== 'undefined'
      ? AppState.getMapTileUrl()
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  }

  // ── Overlay chrome (title + locate/zoom buttons) ───────────────────────────
  function _buildOverlay() {
    const wrap = document.createElement('div');
    wrap.className = 'dp-overlay-top';
    // No title chip — the locate button (top right) already conveys "my location".
    wrap.innerHTML = `
      <div></div>
      <div class="dp-actions">
        <button class="dp-btn" id="hm-zin" aria-label="Zoom in" style="font-size:22px">+</button>
        <button class="dp-btn" id="hm-zout" aria-label="Zoom out" style="font-size:22px">−</button>
        <button class="dp-btn hidden" id="hm-locate" aria-label="My location"><span class="material-icons" style="font-size:20px">navigation</span></button>
      </div>`;
    return wrap;
  }

  // No sheet header — this is a list, not a dashboard. Status messages (locating
  // / no service / error) render inline in the list area instead.
  function _buildSheetHeader() {
    return document.createDocumentFragment();
  }

  function _buildSheetBody() {
    const el = document.createElement('div');
    el.innerHTML = '<div class="hm-cards" id="hm-cards"><div class="dp-loading">Loading nearby departures…</div></div>';
    return el;
  }

  // ── Card rendering — uses the shared CardRender module so cards are identical
  //    to the current shipping transit card (ported from Main/home.js). ────────
  function _renderCards(snapshot) {
    if (!_state) return;
    const host = document.getElementById('hm-cards');
    if (!host) return;

    const raw = (snapshot && snapshot.cards) || [];

    if (!raw.length) {
      _state.cards = [];
      const msg = (!snapshot || snapshot.ok === false)
        ? 'Couldn\'t load nearby departures — retrying…'
        : 'Nothing scheduled nearby in the next 90 minutes.';
      host.innerHTML = `<div class="dp-loading">${msg}</div>`;
      return;
    }

    // PINNED block first, then the feed's own order: distance (nearest stop
    // first). Distance is stable, so the list doesn't visibly re-shuffle every
    // 20s the way an ETA sort would.
    const cards = (typeof PinStore !== 'undefined')
      ? PinStore.sortCards(raw, (a, b) => {
          const ad = (a.distance == null) ? Infinity : a.distance;
          const bd = (b.distance == null) ? Infinity : b.distance;
          return ad - bd;
        })
      : raw;
    _state.cards = cards;

    host.innerHTML = cards.map(c => CardRender.renderCard(c)).join('');

    // Tap → detail page. Long-press → toggle the global pin.
    if (_state.unbindPress) { try { _state.unbindPress(); } catch (e) {} }
    _state.unbindPress = LongPress.bindAll(host, '.card', i => ({
      onTap: () => _openDetail(cards[i]),
      onLongPress: () => PinStore.toggle(cards[i]),   // onChange re-renders
    }));
  }

  /** Re-render the current cards without waiting for the next feed tick. */
  function _rerenderCards() {
    if (!_state) return;
    _renderCards(_state.feed ? _state.feed.getLast() : { cards: _state.cards, ok: true });
  }

  // ── Map: GPS dot + nearby stop dots ─────────────────────────────────────────
  function _updateUserDot(center) {
    if (!_state || !_state.map) return;
    const lat = AppState.userLat, lon = AppState.userLon;
    if (lat == null) return;
    if (_state.userMarker) {
      _state.userMarker.setLatLng([lat, lon]);
    } else {
      _state.userMarker = L.circleMarker([lat, lon], {
        radius: 8, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1,
      }).addTo(_state.map);
    }
    if (center) _centerOnUser();
  }

  /**
   * Put the GPS dot in the visible map ABOVE the sheet (the upper focus cells).
   *
   * setView centres the dot at H/2, but the sheet covers the bottom
   * SHEET_INITIAL of the screen, so the visible map is only the top
   * (1 - SHEET_INITIAL) strip. We pan the map UP so the dot lands in the middle
   * of that visible strip — e.g. a 2/3 sheet leaves the top third, dot at ~H/6.
   * Deriving the target from SHEET_INITIAL keeps the dot centred no matter the
   * default sheet height.
   */
  function _centerOnUser() {
    if (!_state || !_state.map) return;
    const lat = AppState.userLat, lon = AppState.userLon;
    if (lat == null) return;
    const map = _state.map;
    map.setView([lat, lon], 15, { animate: false });
    const h = map.getSize().y;
    const target = h * (1 - SHEET_INITIAL) / 2;  // centre of the visible map above the sheet
    const dy = (h / 2) - target;                 // panBy(+y) moves content UP
    if (dy > 4) map.panBy([0, dy], { animate: false });
  }

  /**
   * Draw one dot per distinct boarding stop that OWNS a card — i.e. the stops we
   * actually show departures for (not every scanned stop, which would clutter a
   * dense place like Capitol Hill). Amber with a white stroke so they read on
   * both light and dark tiles and stay distinct from the blue GPS dot. Tooltip
   * carries the stop name. Tap wiring is deferred to Option 1 (station mode).
   */
  function _updateStopMarkers(cards) {
    if (!_state || !_state.map) return;
    const map = _state.map;
    // Distinct owning stops, keyed by stopId.
    const byId = {};
    for (const c of (cards || [])) {
      if (c.stopLat == null || c.stopLon == null) continue;
      if (!byId[c.stopId]) {
        byId[c.stopId] = { lat: c.stopLat, lon: c.stopLon, name: c.stopName || '' };
      }
    }
    const prev = _state.stopMarkers || {};
    const next = {};
    for (const id in byId) {
      const s = byId[id];
      let m = prev[id];
      if (m) { m.setLatLng([s.lat, s.lon]); delete prev[id]; }
      else {
        m = L.circleMarker([s.lat, s.lon], {
          radius: 5, color: '#fff', weight: 1.5, fillColor: '#f59e0b', fillOpacity: 1,
        }).addTo(map);
        if (s.name) m.bindTooltip(s.name, { direction: 'top', offset: [0, -6] });
      }
      next[id] = m;
    }
    // Drop markers whose stop fell out of the feed.
    for (const id in prev) { try { map.removeLayer(prev[id]); } catch (e) {} }
    _state.stopMarkers = next;
    // Keep the GPS dot painted above the stop dots.
    if (_state.userMarker && _state.userMarker.bringToFront) {
      try { _state.userMarker.bringToFront(); } catch (e) {}
    }
  }
  /**
   * Frame the map to the nearby CLUSTER — GPS dot + the stops we're showing —
   * fitted into the visible strip ABOVE the sheet (the sheet covers the bottom
   * SHEET_INITIAL, so we pad the bottom by that much). Falls back to the single
   * GPS-centred view when there are fewer than 2 points. maxZoom keeps very-close
   * stops from zooming in too far.
   */
  // v6 recenter mechanism: hide the locate button while the map is centered on
  // the nearby cluster; show it once the user drags away. Mirrors Main-v6's
  // _showLocateButton — toggles the `hidden` class.
  function _setLocateVisible(v) {
    const b = document.getElementById('hm-locate');
    if (b) b.classList.toggle('hidden', !v);
  }
  function _frameNearby() {
    if (!_state || !_state.map) return;
    const map = _state.map;
    const pts = [];
    if (AppState.userLat != null) pts.push([AppState.userLat, AppState.userLon]);
    const sm = _state.stopMarkers || {};
    for (const id in sm) { const ll = sm[id].getLatLng(); pts.push([ll.lat, ll.lng]); }
    if (pts.length < 2) { _centerOnUser(); return; }
    const h = map.getSize().y;
    const sheetPx = Math.round(h * SHEET_INITIAL);
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [28, 28],
      paddingBottomRight: [28, sheetPx + 20], // keep the cluster above the sheet
      maxZoom: 16,
      animate: false,
    });
  }

  // ── Feed ────────────────────────────────────────────────────────────────────
  function _startFeed(lat, lon) {
    if (!_state || _state.feed) return;
    _state.feed = StopFeed.create({ radius: NEARBY_RADIUS_M, intervalMs: 20000 });
    _state.unsubFeed = _state.feed.onUpdate(snap => {
      if (!_state) return;
      _renderCards(snap);
      _updateStopMarkers(snap.cards);
      // Frame the cluster once, on the first tick that actually has stops — then
      // leave the map alone so it doesn't jump every 20s as times tick.
      if (!_state._framed && _state.stopMarkers && Object.keys(_state.stopMarkers).length) {
        _frameNearby();
        _state._framed = true;
      }
    });
    _state.feed.start(lat, lon);
  }

  /** Pause/resume home's nearby poll so we don't spend calls while the detail
   *  page (which runs its own 20s route feed) is on top. */
  function pauseFeed() {
    if (_state && _state.feed) { _state.feed.stop(); _state.feed = null; _state.unsubFeed = null; }
  }
  function resumeFeed() {
    if (_state && !_state.feed && AppState.userLat != null) _startFeed(AppState.userLat, AppState.userLon);
  }

  function _openDetail(card) {
    if (typeof DetailPage === 'undefined') return;
    pauseFeed(); // detail page has its own feed — don't double-poll
    // Hide the mode toggle: you've drilled into a page, so the root-level
    // switcher shouldn't float over it.
    if (typeof AppShell !== 'undefined') AppShell.onDetailOpen();
    // Shape the payload the detail page expects.
    DetailPage.open({
      route: card.route,
      routeId: card.routeId,
      headsign: card.headsign,
      color: card.color,
      textColor: card.textColor,
      mode: card.mode,
      tag: card.tag,
      badge: card.badge,
      // Seed the detail ETA readout with what this card is showing, so it's
      // consistent on open before the detail page's own live fetch returns.
      etas: card.etas,
    });
  }

  // ── Public: open / close ────────────────────────────────────────────────────
  function open() {
    if (_state) close();

    const overlay = _buildOverlay();
    const page = MapSheetTemplate.createMapSheetPage({
      id: 'hm',
      topOverlay: overlay,
      sheetHeader: _buildSheetHeader(),
      sheetBody: _buildSheetBody(),
      sheet: { initial: SHEET_INITIAL, draggable: true, snap: false },
      mapController: {
        onReady(mapEl) {
          if (!_state) return;
          const map = L.map(mapEl, { zoomControl: false, attributionControl: false, preferCanvas: true })
            .setView([47.6062, -122.3321], 13);
          L.tileLayer(_tileUrl(), { maxZoom: 19 }).addTo(map);
          map.invalidateSize({ animate: false }); // size is known upfront → render now
          _state.map = map;
          // Show the locate button once the user drags the map off the cluster
          // (v6 mechanism). Programmatic framing does not fire dragstart, so the
          // button stays hidden until a real pan.
          map.on('dragstart', () => _setLocateVisible(true));

          // Live GPS dot. Centre once on the first fix, then just track.
          _state.locCb = AppState.onLocationUpdate(() => {
            if (!_state || !_state.map) return;
            const first = !_state._centred;
            _updateUserDot(first);
            if (first) {
              _state._centred = true;
              _startFeed(AppState.userLat, AppState.userLon);
            } else if (_state.feed) {
              _state.feed.setLocation(AppState.userLat, AppState.userLon);
            }
          });

          // Already have a fix from a previous session? Use it immediately.
          if (AppState.userLat != null) {
            _state._centred = true;
            _updateUserDot(true);
            _startFeed(AppState.userLat, AppState.userLon);
          }
        },
        // Re-shown after being hidden by the mode toggle — nudge Leaflet in case
        // it mis-rendered tiles while the element was display:none.
        onShow() {
          if (_state && _state.map) {
            try { _state.map.invalidateSize({ animate: false }); } catch (e) {}
          }
        },
        onDestroy() {
          if (_state) {
            if (_state.unsubFeed) { try { _state.unsubFeed(); } catch (e) {} }
            if (_state.unsubPins) { try { _state.unsubPins(); } catch (e) {} }
            if (_state.unbindPress) { try { _state.unbindPress(); } catch (e) {} }
            if (_state.feed) { try { _state.feed.stop(); } catch (e) {} }
            if (_state.locCb && AppState.offLocationUpdate) AppState.offLocationUpdate(_state.locCb);
            if (_state.map) { try { _state.map.remove(); } catch (e) {} }
          }
          _state = null;
        },
      },
    });

    _state = {
      page, map: null, feed: null, unsubFeed: null, locCb: null,
      userMarker: null, stopMarkers: {}, cards: [], _centred: false, _framed: false,
      unsubPins: null, unbindPress: null,
    };

    page.mount(document.body);

    // Pinning is global, so a pin toggled anywhere (here, the station page)
    // re-orders this list too.
    if (typeof PinStore !== 'undefined') {
      _state.unsubPins = PinStore.onChange(() => _rerenderCards());
    }

    overlay.querySelector('#hm-locate').addEventListener('click', () => { _frameNearby(); _setLocateVisible(false); });
    overlay.querySelector('#hm-zin').addEventListener('click', () => { if (_state && _state.map) _state.map.zoomIn(); });
    overlay.querySelector('#hm-zout').addEventListener('click', () => { if (_state && _state.map) _state.map.zoomOut(); });

    // Nudge the browser for a location fix if we don't have one yet.
    if (AppState.userLat == null && AppState.requestLocation) {
      AppState.requestLocation(() => {}, () => {
        const host = document.getElementById('hm-cards');
        if (host) host.innerHTML = '<div class="dp-loading">Location access is needed to show nearby transit.</div>';
      });
    }
    return page;
  }

  function close() {
    if (!_state) return;
    if (_state.page) _state.page.unmount();
  }

  function isOpen() { return !!_state; }
  function setVisible(v) { if (_state && _state.page) _state.page.setVisible(v); }

  return { open, close, isOpen, setVisible, pauseFeed, resumeFeed };
})();
