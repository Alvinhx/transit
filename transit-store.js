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
  // Schedule expires after 90 days — covers summer/winter schedule changes
  const SCHEDULE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  // In-memory cache — avoids repeated localStorage parses within a session
  let _mem = null;

  function _load() {
    if (_mem !== null) return _mem;
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
  function getScheduleForStop(routeId, directionName, stopId, dayType) {
    const dt = dayType || (typeof getDayType === 'function' ? getDayType() : 'weekday');
    const entry = getRoute(routeId);
    if (!entry) return [];
    const dir = entry.directions.find(d => d.name === directionName);
    if (!dir || !dir.schedule) return [];
    return dir.schedule[dt]?.[stopId] || [];
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
      const dirTimes = dir.schedule?.[dt]?.[stopId] || [];
      dirTimes.forEach(t => { if (t > now) times.push(t); });
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
      for (const [routeId, route] of Object.entries(data.routes || {})) {
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
    getUpcomingTimesForStop,
    // Static data loading
    loadFromStaticFile,
    // Util
    clearAll,
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
