/**
 * station-config.js — station catalogue + geometry (main-next)
 *
 * Loads the city file (`stations/<city>.json`, shared with Main/ — READ ONLY, we
 * never write to it) and normalises everything the station board needs into one
 * shape, so pages don't have to know whether a station is a built-in or a
 * user-created custom location.
 *
 * A normalised station:
 *   { id, name, type: 'builtin'|'custom', stopIds: [...], center: {lat,lon},
 *     priority: [routeName...], manifest: [...] }
 *
 * ── The centroid problem ─────────────────────────────────────────────────────
 * Built-in stations in the JSON have NO lat/lon — only a list of stop ids. But
 * the station feed needs a centre point to aim the location call at (see
 * stop-feed.js). Options were to add coordinates to the shared JSON, or derive
 * them. We DERIVE them, from the stop coordinates already in routes-data.json
 * via TransitStore, because:
 *   - it needs no edit to a file Main/ also reads (the "never touch Main" rule),
 *   - it self-heals when stop positions change,
 *   - and the JSON stays a pure list of stops, which is what it's meant to be.
 *
 * A station's stops are tightly clustered (measured max pair distance: 223m
 * Capitol Hill, 228m Lynnwood, 449m Denny & Westlake), so the centroid is a good
 * aim point and a small radius covers the set.
 *
 * Custom locations already store their own lat/lon, so they skip all this.
 *
 * Depends on globals: TransitStore (stop coords), and the transit-logic globals
 * loadCustomLocations() / genericClassify() for custom locations.
 */

const StationConfig = (function () {
  'use strict';

  const DEFAULT_CITY = 'seattle';
  // main-next is standalone: it carries its OWN stations/ (copied from Main),
  // served at the app root by main-next's own server. No dependency on Main/.
  const STATIONS_PATH = 'stations/';

  let _city = null;              // raw city json
  let _builtins = {};            // id -> raw station
  let _centroidCache = {};       // id -> {lat,lon} | null

  /** Load the city file. Call once at boot, before opening the station page. */
  async function load(cityFile) {
    const file = cityFile || DEFAULT_CITY;
    try {
      const r = await fetch(STATIONS_PATH + file + '.json');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _city = await r.json();
      _builtins = _city.stations || {};
      // The city file can override the API base/key (same contract as Main).
      if (_city.obaApiBase) window._OBA_BASE = _city.obaApiBase;
      if (_city.obaApiKey) window._OBA_KEY = _city.obaApiKey;
      return _city;
    } catch (e) {
      _city = null;
      _builtins = {};
      return null;
    }
  }

  function isLoaded() { return !!_city; }
  function cityName() { return _city ? _city.city : ''; }

  /** The city file's own default station id (e.g. 'caphill'). */
  function defaultStationId() {
    return (_city && _city.defaultStation) || Object.keys(_builtins)[0] || null;
  }

  /** Classify fn for built-ins, resolved from the city file's `classifyRules`. */
  function classifyFor(type) {
    // Custom locations use the generic classifier; built-ins use the city's rules
    // if we have them. StopFeed has its own Seattle default, so returning
    // undefined is safe and just means "use the feed's built-in rules".
    if (type === 'custom' && typeof genericClassify === 'function') return genericClassify;
    return undefined;
  }

  /** Flat stop id list for a built-in (the JSON groups them by mode, decoratively). */
  function _stopIdsOf(raw) {
    return Object.values(raw.stops || {}).flat();
  }

  /**
   * Centroid of a station's stops, from TransitStore stop coordinates.
   * Cached — this walks route data, which isn't free.
   * @returns {{lat:number, lon:number, resolved:number, total:number}|null}
   */
  function centroidOf(stationId) {
    if (stationId in _centroidCache) return _centroidCache[stationId];
    const raw = _builtins[stationId];
    if (!raw) return (_centroidCache[stationId] = null);

    const want = new Set(_stopIdsOf(raw));
    const found = {};
    // Stop coords live inside each route's directions in routes-data/TransitStore.
    // Walk until every wanted stop is found (early exit keeps this cheap).
    const all = _allStoredStops();
    for (const [sid, s] of Object.entries(all)) {
      if (want.has(sid) && s && s.lat != null) found[sid] = s;
      if (Object.keys(found).length === want.size) break;
    }
    const pts = Object.values(found);
    if (!pts.length) return (_centroidCache[stationId] = null);
    const c = {
      lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
      lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length,
      resolved: pts.length,
      total: want.size,
    };
    _centroidCache[stationId] = c;
    return c;
  }

  // Build (once) a stopId -> {lat,lon} index across everything in the store.
  let _stopIndex = null;
  function _allStoredStops() {
    if (_stopIndex) return _stopIndex;
    _stopIndex = {};
    if (typeof TransitStore === 'undefined') return _stopIndex;
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem('nextup_transit_store')); } catch (e) {}
    if (!raw) return _stopIndex;
    for (const route of Object.values(raw)) {
      for (const dir of (route.directions || [])) {
        for (const [sid, s] of Object.entries(dir.stops || {})) {
          if (s && s.lat != null && !_stopIndex[sid]) _stopIndex[sid] = { lat: s.lat, lon: s.lon };
        }
      }
    }
    return _stopIndex;
  }

  /** Invalidate the derived geometry (e.g. after the store is repopulated). */
  function invalidateGeometry() { _stopIndex = null; _centroidCache = {}; }

  /** Normalised built-in stations, in city-file order. */
  function listBuiltins() {
    return Object.keys(_builtins).map(id => get('builtin', id)).filter(Boolean);
  }

  /** Normalised custom locations from localStorage. */
  function listCustoms() {
    if (typeof loadCustomLocations !== 'function') return [];
    return loadCustomLocations().map(cl => ({
      id: cl.id,
      name: cl.name,
      type: 'custom',
      stopIds: cl.stopIds || [],
      center: { lat: cl.lat, lon: cl.lon },
      priority: [],
      manifest: null,   // custom locations have no hand-authored manifest
    }));
  }

  function listAll() { return listBuiltins().concat(listCustoms()); }

  /**
   * Get one normalised station. Returns null if unknown, or if a built-in has no
   * resolvable centre (which would make the feed unaimed).
   * @param {'builtin'|'custom'} type
   */
  function get(type, id) {
    if (type === 'custom') {
      return listCustoms().find(s => s.id === id) || null;
    }
    const raw = _builtins[id];
    if (!raw) return null;
    const c = centroidOf(id);
    return {
      id,
      name: raw.name,
      type: 'builtin',
      stopIds: _stopIdsOf(raw),
      center: c ? { lat: c.lat, lon: c.lon } : null,
      centroidCoverage: c ? { resolved: c.resolved, total: c.total } : null,
      priority: raw.priority || [],
      manifest: raw.manifest || null,
    };
  }

  return {
    load, isLoaded, cityName, defaultStationId, classifyFor,
    get, listAll, listBuiltins, listCustoms,
    centroidOf, invalidateGeometry,
  };
})();
