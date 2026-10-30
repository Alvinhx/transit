/**
 * station-picker.js — choose / add a station (main-next)
 *
 * Two jobs in one page, on the pushed List template:
 *   1. PICK — preset stations + the user's own saved ones. Choosing one makes it
 *      the default (see ViewMode: selecting IS setting, which is why v1's
 *      separate "home station" star icon doesn't exist here).
 *   2. ADD — build a custom station from nearby stops: locate → discover stops →
 *      tap to include/exclude on a map → name it → save.
 *
 * ── Two entry points, one component ─────────────────────────────────────────
 * FIRST RUN (`dismissible: false`) — the user has never chosen a station, so
 * there's nothing to fall back to. No back button; they must pick something.
 * SWITCHING (`dismissible: true`) — reached by tapping the station title, so
 * backing out and keeping the current station is valid.
 *
 * Custom stations are stored in Main's existing `nextup_custom_locations` (via
 * the transit-logic globals) rather than a new key, so a station added in either
 * app shows up in both. That's deliberate: it's user data, not app state, and
 * main-next is meant to replace Main in place.
 *
 * Depends on globals: ListPageTemplate, StationConfig, ViewMode, AppState, L
 * (Leaflet), TransitAPI, and the transit-logic globals loadCustomLocations /
 * saveCustomLocations / deleteCustomLocation / generateLocationId /
 * validateLocationName / suggestDefaultName.
 */

const StationPicker = (function () {
  'use strict';

  const DISCOVER_RADIUS_M = 400;

  let _state = null; // { page, onSelect, onDismiss, mode, map, markers, selected, stops, coords }

  // ── Row builders ────────────────────────────────────────────────────────────

  function _stationRow(station, isCurrent, isDefault) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sp-row' + (isCurrent ? ' is-current' : '');
    row.innerHTML = `
      <span class="material-icons sp-row-ico">${station.type === 'custom' ? 'place' : 'directions_transit'}</span>
      <span class="sp-row-main">
        <span class="sp-row-name"></span>
        <span class="sp-row-meta">${station.stopIds.length} stop${station.stopIds.length === 1 ? '' : 's'}${isDefault ? ' · default' : ''}</span>
      </span>
      ${isCurrent ? '<span class="material-icons sp-row-check">check</span>' : ''}`;
    // textContent so a user-supplied station name can't inject markup.
    row.querySelector('.sp-row-name').textContent = station.name;
    row.addEventListener('click', () => _choose(station));

    if (station.type === 'custom') {
      const del = document.createElement('span');
      del.className = 'material-icons sp-row-del';
      del.textContent = 'close';
      del.setAttribute('role', 'button');
      del.setAttribute('aria-label', 'Delete ' + station.name);
      del.addEventListener('click', (e) => { e.stopPropagation(); _deleteCustom(station); });
      row.appendChild(del);
    }
    return row;
  }

  function _addRow() {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sp-row sp-add';
    row.innerHTML =
      '<span class="material-icons sp-row-ico">add_circle_outline</span>' +
      '<span class="sp-row-main"><span class="sp-row-name">Add a station</span>' +
      '<span class="sp-row-meta">Pick stops near you</span></span>';
    row.addEventListener('click', () => _showAdd());
    return row;
  }

  // ── List view ───────────────────────────────────────────────────────────────

  function _renderList() {
    if (!_state) return;
    const body = _state.page.getBody();
    body.innerHTML = '';
    _state.mode = 'list';

    const current = (typeof StationPage !== 'undefined' && StationPage.getStation)
      ? StationPage.getStation() : null;
    const def = ViewMode.getDefaultStation();
    const isDef = (s) => !!def && def.type === s.type && def.id === s.id;

    body.appendChild(_addRow());

    const builtins = StationConfig.listBuiltins();
    if (builtins.length) {
      const h = document.createElement('div');
      h.className = 'lp-section-title';
      h.textContent = 'Preset';
      body.appendChild(h);
      for (const s of builtins) {
        body.appendChild(_stationRow(s, current && current.type === s.type && current.id === s.id, isDef(s)));
      }
    }

    const customs = StationConfig.listCustoms();
    if (customs.length) {
      const h = document.createElement('div');
      h.className = 'lp-section-title';
      h.textContent = 'Yours';
      body.appendChild(h);
      for (const s of customs) {
        body.appendChild(_stationRow(s, current && current.type === s.type && current.id === s.id, isDef(s)));
      }
    }
  }

  function _choose(station) {
    if (!_state) return;
    const cb = _state.onSelect;
    close();
    if (typeof cb === 'function') cb(station);
  }

  function _deleteCustom(station) {
    if (!_state) return;
    if (typeof deleteCustomLocation !== 'function') return;
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete "' + station.name + '"?')) return;
    deleteCustomLocation(station.id);
    StationConfig.invalidateGeometry();

    // If we just deleted the default, drop that reference so the shell falls
    // back to the city default instead of pointing at something gone.
    const def = ViewMode.getDefaultStation();
    if (def && def.type === 'custom' && def.id === station.id) ViewMode.clearDefaultStation();
    _renderList();
  }

  // ── Add flow ────────────────────────────────────────────────────────────────

  function _msg(html) {
    if (!_state) return;
    _state.page.getBody().innerHTML = '<div class="sp-msg">' + html + '</div>';
  }

  function _showAdd() {
    if (!_state) return;
    _state.mode = 'add';
    _state.page.setSubtitle('Add a station');

    // Reuse an existing fix if we have one so we don't re-prompt.
    if (typeof AppState !== 'undefined' && AppState.userLat != null) {
      _discover(AppState.userLat, AppState.userLon);
      return;
    }
    _msg('<span class="material-icons sp-spin">my_location</span><div>Finding your location…</div>');
    if (typeof AppState === 'undefined' || !AppState.requestLocation) {
      _msg('<div>Location isn\'t available in this browser.</div>');
      return;
    }
    AppState.requestLocation(
      (lat, lon) => _discover(lat, lon),
      () => _msg('<div>Location access is needed to find nearby stops.</div>' +
                 '<div class="sp-msg-sub">Enable it and try again.</div>')
    );
  }

  async function _discover(lat, lon) {
    if (!_state) return;
    _state.coords = { lat, lon };
    _msg('<span class="material-icons sp-spin">explore</span><div>Looking for nearby stops…</div>');
    try {
      const j = await TransitAPI.fetchStopsForLocation(lat, lon, DISCOVER_RADIUS_M);
      if (!_state) return;
      const refs = {};
      for (const rt of ((j.data && j.data.references && j.data.references.routes) || [])) refs[rt.id] = rt;
      const stops = ((j.data && j.data.list) || []).map(s => ({
        id: s.id,
        name: s.name,
        direction: s.direction || '',
        lat: s.lat,
        lon: s.lon,
        routeNames: (s.routeIds || [])
          .map(rid => (refs[rid] ? (refs[rid].shortName || refs[rid].longName || '') : ''))
          .filter(Boolean),
      }));
      if (!stops.length) {
        _msg('<div>No transit stops within ' + DISCOVER_RADIUS_M + 'm.</div>');
        return;
      }
      _state.stops = stops;
      _renderStopPicker();
    } catch (e) {
      _msg('<div>Couldn\'t load nearby stops.</div>');
    }
  }

  function _renderStopPicker() {
    if (!_state) return;
    const body = _state.page.getBody();
    const stops = _state.stops;

    // Everything selected by default — most users want the whole cluster.
    _state.selected = {};
    for (const s of stops) _state.selected[s.id] = true;

    body.innerHTML = `
      <label class="sp-label" for="sp-name">Station name</label>
      <input class="sp-input" id="sp-name" type="text" maxlength="40" placeholder="e.g. My stop">
      <div class="sp-err" id="sp-name-err" hidden></div>
      <label class="sp-label">Tap stops to include or exclude</label>
      <div class="sp-count" id="sp-count"></div>
      <div class="sp-map" id="sp-map"></div>
      <div class="sp-err" id="sp-err" hidden></div>
      <div class="sp-actions">
        <button class="sp-btn" id="sp-cancel" type="button">Cancel</button>
        <button class="sp-btn sp-primary" id="sp-save" type="button">Save station</button>
      </div>`;

    const nameInput = body.querySelector('#sp-name');
    if (typeof suggestDefaultName === 'function') nameInput.value = suggestDefaultName(stops) || '';

    body.querySelector('#sp-cancel').addEventListener('click', () => {
      _teardownMap();
      _state.page.setSubtitle('');
      _renderList();
    });
    body.querySelector('#sp-save').addEventListener('click', () => _save());

    _buildMap(body.querySelector('#sp-map'));
    _updateCount();
  }

  function _updateCount() {
    if (!_state) return;
    const el = document.getElementById('sp-count');
    if (!el) return;
    const n = Object.keys(_state.selected).filter(k => _state.selected[k]).length;
    el.textContent = n + ' of ' + _state.stops.length + ' stops selected';
  }

  function _buildMap(el) {
    if (!_state || !el || typeof L === 'undefined') return;
    const { lat, lon } = _state.coords;
    const map = L.map(el, { zoomControl: true, attributionControl: false }).setView([lat, lon], 16);
    L.tileLayer(
      (typeof AppState !== 'undefined' && AppState.getMapTileUrl)
        ? AppState.getMapTileUrl()
        : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { maxZoom: 19 }
    ).addTo(map);
    _state.map = map;

    // You
    L.circleMarker([lat, lon], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1,
    }).addTo(map);

    _state.markers = [];
    for (const s of _state.stops) {
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 9, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.8, weight: 2,
      }).addTo(map);
      const routes = s.routeNames.length ? '<br>' + s.routeNames.join(', ') : '';
      m.bindPopup('<b>' + s.name + '</b>' + routes);
      m.on('click', () => {
        const on = !_state.selected[s.id];
        _state.selected[s.id] = on;
        m.setStyle({
          color: on ? '#22c55e' : '#666', fillColor: on ? '#22c55e' : '#666',
          fillOpacity: on ? 0.8 : 0.35,
        });
        _updateCount();
      });
      _state.markers.push(m);
    }
    // Leaflet needs a nudge when it's created inside a container that just
    // appeared — otherwise tiles can render blank.
    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 150);
  }

  function _teardownMap() {
    if (_state && _state.map) { try { _state.map.remove(); } catch (e) {} }
    if (_state) { _state.map = null; _state.markers = []; }
  }

  function _showErr(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }
  function _clearErr(id) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }

  function _save() {
    if (!_state) return;
    const nameInput = document.getElementById('sp-name');
    const name = (nameInput.value || '').trim();

    if (typeof validateLocationName === 'function') {
      const v = validateLocationName(name);
      if (!v.valid) { _showErr('sp-name-err', v.error); nameInput.focus(); return; }
    } else if (!name) {
      _showErr('sp-name-err', 'Please enter a name.'); return;
    }
    _clearErr('sp-name-err');

    const stopIds = Object.keys(_state.selected).filter(k => _state.selected[k]);
    if (!stopIds.length) { _showErr('sp-err', 'Select at least one stop.'); return; }
    _clearErr('sp-err');

    const loc = {
      id: (typeof generateLocationId === 'function') ? generateLocationId() : String(Date.now()),
      name,
      lat: _state.coords.lat,
      lon: _state.coords.lon,
      stopIds,
      createdAt: Date.now(),
    };

    const all = (typeof loadCustomLocations === 'function') ? loadCustomLocations() : [];
    all.push(loc);
    const ok = (typeof saveCustomLocations === 'function') ? saveCustomLocations(all) : false;
    if (!ok) { _showErr('sp-err', 'Couldn\'t save — storage may be full.'); return; }

    _teardownMap();
    StationConfig.invalidateGeometry();

    // Select it immediately: adding a station is also choosing it.
    const station = StationConfig.get('custom', loc.id);
    if (station) _choose(station);
    else { _state.page.setSubtitle(''); _renderList(); }
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /**
   * @param {object} opts
   *   onSelect(station)  chosen station (already normalised)
   *   onDismiss()        backed out without choosing
   *   dismissible        false on first run — there's no station to fall back to
   */
  function open(opts) {
    opts = opts || {};
    if (_state) close();

    const dismissible = opts.dismissible !== false;

    const page = ListPageTemplate.createListPage({
      id: 'station-picker',
      title: 'Stations',
      subtitle: dismissible ? '' : 'Choose a station to get started',
      items: [],
      itemClass: '',
      renderItem: () => document.createDocumentFragment(),
      // Back only exists when backing out is meaningful.
      onBack: dismissible ? () => {
        const cb = _state && _state.onDismiss;
        close();
        if (typeof cb === 'function') cb();
      } : undefined,
      root: !dismissible,   // first run has no back affordance
      onDestroy() {
        _teardownMap();
        _state = null;
      },
    });

    _state = {
      page,
      onSelect: opts.onSelect,
      onDismiss: opts.onDismiss,
      mode: 'list',
      map: null, markers: [], selected: {}, stops: [], coords: null,
    };

    // A previously closed page lingers for the slide-out animation (~260ms). If
    // the picker is reopened inside that window we'd end up with two elements
    // sharing one id, so any getElementById/querySelector could resolve to the
    // dead one. Drop any stale node before mounting.
    const stale = document.getElementById('station-picker-page');
    if (stale) stale.remove();

    page.mount(document.body);
    _renderList();
    return page;
  }

  function close() {
    if (!_state) return;
    if (_state.page) _state.page.unmount();
    _state = null;
  }

  function isOpen() { return !!_state; }

  return { open, close, isOpen };
})();
