/* NextUp Transit — app-state.js */
/* App-level shared state: device, screen, theme, location, transit data access */
/* Loaded first — all other modules read from here. */

const AppState = (function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // DEVICE & SCREEN
  // Captured at boot. Stable for the session. Updated on resize.
  // ═══════════════════════════════════════════════════════════════════════════

  let _screenW = window.innerWidth;
  let _screenH = window.innerHeight;
  const _isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const _pixelRatio = window.devicePixelRatio || 1;

  // iOS/Android safe area insets (notch, home bar)
  // Read from CSS env() variables — 0 on desktop
  function _getSafeArea() {
    try {
      const style = getComputedStyle(document.documentElement);
      const parse = v => parseInt(v) || 0;
      return {
        top:    parse(style.getPropertyValue('env(safe-area-inset-top)')    || '0'),
        bottom: parse(style.getPropertyValue('env(safe-area-inset-bottom)') || '0'),
        left:   parse(style.getPropertyValue('env(safe-area-inset-left)')   || '0'),
        right:  parse(style.getPropertyValue('env(safe-area-inset-right)')  || '0'),
      };
    } catch (e) {
      return { top: 0, bottom: 0, left: 0, right: 0 };
    }
  }

  let _safeArea = _getSafeArea();

  window.addEventListener('resize', () => {
    _screenW = window.innerWidth;
    _screenH = window.innerHeight;
    _safeArea = _getSafeArea();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // THEME
  // Single source of truth for light/dark mode.
  // home.js writes the theme; all modules read from here.
  // ═══════════════════════════════════════════════════════════════════════════

  const _themeCallbacks = [];

  function _isLightTheme() {
    return document.body.classList.contains('light');
  }

  /**
   * Get the current map tile URL based on the active theme.
   * Used by both the location creation map and the detail panel map.
   */
  // CARTO Basemaps API key (free tier, ≤5M tile requests/month). Required since
  // CARTO began watermarking keyless basemap tiles ("API KEY REQUIRED"). It's
  // appended to every tile URL as ?key=. This key is client-side/public by
  // design for CARTO basemaps — rate-limited, and can be domain-restricted in
  // the CARTO dashboard if this is ever hosted on a real domain.
  const CARTO_KEY = 'cb1_3voy_1_3b54454d35a0e66f93ab3e4e';
  function getMapTileUrl() {
    const style = _isLightTheme() ? 'light_all' : 'dark_all';
    return `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`;
  }

  /**
   * Register a callback to be called when the theme changes.
   * Called immediately with the current theme state.
   */
  function onThemeChange(cb) {
    _themeCallbacks.push(cb);
    try { cb(_isLightTheme()); } catch (e) {}
  }

  /**
   * Notify all theme callbacks — called by home.js when theme changes.
   */
  function notifyThemeChange() {
    _themeCallbacks.forEach(cb => { try { cb(_isLightTheme()); } catch (e) {} });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCATION
  // Single persistent watcher for the entire app session.
  // All modules read from here — no module calls watchPosition independently.
  // ═══════════════════════════════════════════════════════════════════════════

  let _lat = null;
  let _lon = null;
  let _watcher = null;
  let _permissionDenied = false;
  const _locationCallbacks = [];

  function _onPosition(pos) {
    _lat = pos.coords.latitude;
    _lon = pos.coords.longitude;
    _permissionDenied = false;
    _locationCallbacks.forEach(cb => { try { cb(_lat, _lon); } catch (e) {} });
  }

  function _onError(err) {
    if (err.code === 1) _permissionDenied = true;
  }

  /**
   * Start the location watcher. Safe to call multiple times — only starts once.
   */
  function startLocationWatch() {
    if (_watcher !== null || !navigator.geolocation) return;
    _watcher = navigator.geolocation.watchPosition(_onPosition, _onError, {
      enableHighAccuracy: false,
      maximumAge: 30000,
      timeout: 10000,
    });
  }

  /**
   * Explicitly request location (will prompt if not yet granted).
   * Call this only in response to a user action.
   */
  function requestLocation(onSuccess, onDenied) {
    if (!navigator.geolocation) { if (onDenied) onDenied(); return; }
    if (_lat !== null) { if (onSuccess) onSuccess(_lat, _lon); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        _onPosition(pos);
        if (onSuccess) onSuccess(_lat, _lon);
        startLocationWatch();
      },
      err => { _onError(err); if (onDenied) onDenied(); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  /**
   * Register a callback for location updates.
   * Called immediately with current coords if already available.
   */
  function onLocationUpdate(cb) {
    _locationCallbacks.push(cb);
    if (_lat !== null) { try { cb(_lat, _lon); } catch (e) {} }
    return cb; // return handle so callers can unsubscribe
  }

  /**
   * Unregister a previously-registered location callback.
   * (main-next addition — Main's app-state has no unsubscribe; this lets pages
   * clean up their location listeners on teardown to avoid leaks / dead-map calls.)
   */
  function offLocationUpdate(cb) {
    const i = _locationCallbacks.indexOf(cb);
    if (i >= 0) _locationCallbacks.splice(i, 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSIT DATA ACCESS
  // Clean read interface into home.js's routeCache.
  // ═══════════════════════════════════════════════════════════════════════════

  function getETAsForRoute(routeId) {
    if (typeof routeCache === 'undefined') return [];
    const results = [];
    for (const key in routeCache) {
      const entry = routeCache[key];
      if (entry.routeId === routeId && entry.etas && entry.etas.length) {
        entry.etas.forEach(e => results.push(e));
      }
    }
    return results.sort((a, b) => a.ms - b.ms).slice(0, 3);
  }

  function getNearestStopForRoute(routeId) {
    if (typeof routeCache === 'undefined') return null;
    const servingStops = new Set();
    for (const key in routeCache) {
      const entry = routeCache[key];
      if (entry.routeId === routeId && entry.stopId) servingStops.add(entry.stopId);
    }
    if (!servingStops.size) return null;
    if (_lat !== null && typeof getAllStopIds === 'function') {
      const homeStops = getAllStopIds();
      for (const sid of homeStops) { if (servingStops.has(sid)) return sid; }
    }
    return [...servingStops][0];
  }

  function getHeadsignForRoute(routeId) {
    if (typeof routeCache === 'undefined') return '';
    for (const key in routeCache) {
      const entry = routeCache[key];
      if (entry.routeId === routeId && entry.headsign) return entry.headsign;
    }
    return '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  return {
    // Device & Screen
    get screenW()       { return _screenW; },
    get screenH()       { return _screenH; },
    get isTouch()       { return _isTouch; },
    get pixelRatio()    { return _pixelRatio; },
    get safeAreaTop()   { return _safeArea.top; },
    get safeAreaBottom(){ return _safeArea.bottom; },
    get safeAreaLeft()  { return _safeArea.left; },
    get safeAreaRight() { return _safeArea.right; },

    // Theme
    get isLight()       { return _isLightTheme(); },
    getMapTileUrl,
    onThemeChange,
    notifyThemeChange,

    // Location
    get userLat()        { return _lat; },
    get userLon()        { return _lon; },
    get hasLocation()    { return _lat !== null; },
    get locationDenied() { return _permissionDenied; },
    startLocationWatch,
    requestLocation,
    onLocationUpdate,
    offLocationUpdate,

    // Transit data
    getETAsForRoute,
    getNearestStopForRoute,
    getHeadsignForRoute,
  };
})();
