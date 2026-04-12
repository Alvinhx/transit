/**
 * transit-logic.js — Pure logic functions for NextUp Transit
 * Self-contained, no dependencies. Works via <script> tag (globals) or Node.js require().
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    var exports = factory();
    for (var k in exports) {
      if (exports.hasOwnProperty(k)) root[k] = exports[k];
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ===== Storage Keys =====
  var STORAGE_KEYS = {
    customLocations: 'nextup_custom_locations',
    activeLocation: 'nextup_active_location'
  };

  // ===== Storage Manager =====

  /**
   * Load custom locations from localStorage with defensive parsing and shape validation.
   * Malformed entries are silently discarded.
   * @returns {Array} Array of valid CustomLocation objects
   */
  function loadCustomLocations() {
    try {
      var raw = localStorage.getItem(STORAGE_KEYS.customLocations);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (loc) {
        return (
          loc &&
          typeof loc.id === 'string' &&
          typeof loc.name === 'string' &&
          typeof loc.lat === 'number' &&
          typeof loc.lon === 'number' &&
          Array.isArray(loc.stopIds) &&
          loc.stopIds.length > 0
        );
      });
    } catch (e) {
      return [];
    }
  }

  /**
   * Save custom locations to localStorage.
   * @param {Array} locations - Array of CustomLocation objects
   * @returns {boolean} true if saved successfully, false otherwise
   */
  function saveCustomLocations(locations) {
    try {
      localStorage.setItem(STORAGE_KEYS.customLocations, JSON.stringify(locations));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Load the active location from localStorage.
   * @returns {{ type: string, id: string } | null}
   */
  function loadActiveLocation() {
    try {
      var raw = localStorage.getItem(STORAGE_KEYS.activeLocation);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.type === 'string' &&
        typeof parsed.id === 'string'
      ) {
        return { type: parsed.type, id: parsed.id };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save the active location to localStorage.
   * @param {string} type - 'builtin' or 'custom'
   * @param {string} id - Station key or custom location UUID
   */
  function saveActiveLocation(type, id) {
    try {
      localStorage.setItem(
        STORAGE_KEYS.activeLocation,
        JSON.stringify({ type: type, id: id })
      );
    } catch (e) {
      // silently fail
    }
  }

  /**
   * Delete a custom location by id. Loads current locations, filters out the
   * target, and saves back.
   * @param {string} id - The id of the custom location to delete
   */
  function deleteCustomLocation(id) {
    var locations = loadCustomLocations();
    var filtered = locations.filter(function (loc) {
      return loc.id !== id;
    });
    saveCustomLocations(filtered);
  }

  /**
   * Generate a unique location id. Uses crypto.randomUUID() with a fallback
   * for environments that don't support it.
   * @returns {string}
   */
  function generateLocationId() {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID();
    }
    // Fallback: simple pseudo-UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Validate a location name.
   * Rejects empty/whitespace-only strings and enforces a 40-character limit.
   * @param {string} name
   * @returns {{ valid: boolean, error?: string }}
   */
  function validateLocationName(name) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { valid: false, error: 'Please enter a name for this location.' };
    }
    if (name.length > 40) {
      return { valid: false, error: 'Location name must be 40 characters or fewer.' };
    }
    return { valid: true };
  }

  /**
   * Suggest a default name from an array of stop objects.
   * Derives the name from the most common stop name in the array.
   * @param {Array<{ name: string }>} stops
   * @returns {string}
   */
  function suggestDefaultName(stops) {
    if (!Array.isArray(stops) || stops.length === 0) return '';
    var counts = {};
    for (var i = 0; i < stops.length; i++) {
      var n = (stops[i] && stops[i].name) || '';
      if (n) {
        counts[n] = (counts[n] || 0) + 1;
      }
    }
    var best = '';
    var bestCount = 0;
    for (var key in counts) {
      if (counts.hasOwnProperty(key) && counts[key] > bestCount) {
        bestCount = counts[key];
        best = key;
      }
    }
    return best;
  }

  // ===== Generic Classify =====

  /**
   * Universal transit route classifier for all Puget Sound agencies.
   * Returns { mode, tag, badge } for any combination of inputs — never undefined/null.
   * @param {number} type - OBA route_type integer
   * @param {string} agencyId - OBA agency ID string
   * @param {string} shortName - Route short name
   * @returns {{ mode: string, tag: string, badge: string }}
   */
  function genericClassify(type, agencyId, shortName) {
    // Light Rail: route_type 0, Sound Transit (40)
    if (type === 0 && agencyId === '40') return { mode: 'rail', tag: 'Light Rail', badge: 'round' };
    // Streetcar: route_type 0, other agencies
    if (type === 0) return { mode: 'streetcar', tag: (shortName || '').replace(/\s*Streetcar$/i, ' Streetcar').trim(), badge: 'square' };
    // Monorail: route_type 2, Seattle Monorail (96)
    if (type === 2 && agencyId === '96') return { mode: 'monorail', tag: 'Monorail', badge: 'square' };
    // ST Express: route_type 3, Sound Transit (40)
    if (type === 3 && agencyId === '40') return { mode: 'express', tag: 'ST Express', badge: 'square' };
    // Swift BRT: route_type 3, name starts with "Swift"
    if (type === 3 && (shortName || '').match(/^Swift/i)) return { mode: 'swift', tag: shortName, badge: 'square', isSwift: true };
    // RapidRide: route_type 3, name ends with "Line"
    if (type === 3 && (shortName || '').match(/Line$/i)) return { mode: 'rapid', tag: 'RapidRide', badge: 'square' };
    // Ferry: route_type 4
    if (type === 4) return { mode: 'ferry', tag: 'Ferry', badge: 'square' };
    // Default bus
    return { mode: 'bus', tag: 'Bus', badge: 'square' };
  }

  // ===== Location Resolver =====

  /**
   * Build a StationConfig shape from a CustomLocation object.
   * @param {Object} customLocation - A CustomLocation object with name and stopIds
   * @param {Function} genericClassifyFn - The genericClassify function reference
   * @returns {{ name: string, stops: { all: string[] }, priority: Array, classify: Function }}
   */
  function buildCustomConfig(customLocation, genericClassifyFn) {
    return {
      name: customLocation.name,
      stops: { all: customLocation.stopIds },
      priority: [],
      classify: genericClassifyFn
    };
  }

  /**
   * Resolve which location to use at boot time.
   * Priority: URL param > stored active location > default ("caphill").
   *
   * @param {string|null} urlParam - The ?station= URL parameter value
   * @param {string[]} builtinKeys - Keys of the STATIONS object (e.g. ["caphill", "lynnwood", "dennypark"])
   * @param {Array} customLocations - Array of CustomLocation objects from localStorage
   * @param {Function} genericClassifyFn - The genericClassify function reference (for building custom configs)
   * @returns {{ type: 'builtin'|'custom', id: string }}
   */
  function resolveLocation(urlParam, builtinKeys, customLocations, genericClassifyFn) {
    // 1. If urlParam is truthy and exists in builtinKeys, return builtin
    if (urlParam && builtinKeys.indexOf(urlParam) !== -1) {
      return { type: 'builtin', id: urlParam };
    }

    // 2. If urlParam is truthy and matches a custom location id, return custom
    if (urlParam) {
      for (var i = 0; i < customLocations.length; i++) {
        if (customLocations[i].id === urlParam) {
          return { type: 'custom', id: urlParam };
        }
      }
    }

    // 3. No valid URL param — check stored active location
    var stored = loadActiveLocation();

    if (stored) {
      // 4. If stored active is a valid builtin key, return it
      if (stored.type === 'builtin' && builtinKeys.indexOf(stored.id) !== -1) {
        return { type: 'builtin', id: stored.id };
      }

      // 5. If stored active is a valid custom location id, return it
      if (stored.type === 'custom') {
        for (var j = 0; j < customLocations.length; j++) {
          if (customLocations[j].id === stored.id) {
            return { type: 'custom', id: stored.id };
          }
        }
      }
    }

    // 6. Check default launch location
    var def = loadDefaultLocation();
    if (def) {
      if (def.type === 'builtin' && builtinKeys.indexOf(def.id) !== -1) {
        return { type: 'builtin', id: def.id };
      }
      if (def.type === 'custom') {
        for (var m = 0; m < customLocations.length; m++) {
          if (customLocations[m].id === def.id) {
            return { type: 'custom', id: def.id };
          }
        }
      }
    }

    // 7. Default fallback
    return { type: 'builtin', id: 'caphill' };
  }

  // ===== Default Location =====

  var DEFAULT_LOC_KEY = 'nextup_default_location';

  /**
   * Load the default launch location from localStorage.
   * @returns {{ type: string, id: string } | null}
   */
  function loadDefaultLocation() {
    try {
      var raw = localStorage.getItem(DEFAULT_LOC_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.type === 'string' && typeof parsed.id === 'string') {
        return { type: parsed.type, id: parsed.id };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save the default launch location to localStorage.
   * @param {string} type - 'builtin' or 'custom'
   * @param {string} id - Station key or custom location UUID
   */
  function saveDefaultLocation(type, id) {
    try {
      localStorage.setItem(DEFAULT_LOC_KEY, JSON.stringify({ type: type, id: id }));
    } catch (e) {}
  }

  /**
   * Clear the default launch location.
   */
  function clearDefaultLocation() {
    try { localStorage.removeItem(DEFAULT_LOC_KEY); } catch (e) {}
  }

  // ===== Priority Overrides =====

  var PRIORITY_STORAGE_KEY = 'nextup_priority_overrides';

  /**
   * Load priority overrides for a specific location from localStorage.
   * Returns an array of route names, or null if no override exists.
   * @param {string} locationId - Station key or custom location UUID
   * @returns {string[]|null}
   */
  function loadPriorityOverride(locationId) {
    try {
      var raw = localStorage.getItem(PRIORITY_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed[locationId])) return parsed[locationId];
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save priority overrides for a specific location to localStorage.
   * @param {string} locationId - Station key or custom location UUID
   * @param {string[]} routes - Array of priority route names
   */
  function savePriorityOverride(locationId, routes) {
    try {
      var raw = localStorage.getItem(PRIORITY_STORAGE_KEY);
      var all = {};
      if (raw) { try { all = JSON.parse(raw) || {}; } catch(e) { all = {}; } }
      all[locationId] = routes;
      localStorage.setItem(PRIORITY_STORAGE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  /**
   * Get the effective priority list for a location.
   * Returns the user override if it exists, otherwise the default from config.
   * @param {string} locationId
   * @param {string[]} defaultPriority
   * @returns {string[]}
   */
  function getEffectivePriority(locationId, defaultPriority) {
    var override = loadPriorityOverride(locationId);
    return override !== null ? override : defaultPriority;
  }

  // ===== Schedule Cache =====

  var SCHEDULE_CACHE_KEY = 'nextup_schedule_cache';

  /**
   * Get the day type key: 'weekday', 'saturday', or 'sunday'
   */
  function getDayType() {
    var day = new Date().getDay();
    if (day === 0) return 'sunday';
    if (day === 6) return 'saturday';
    return 'weekday';
  }

  /**
   * Load cached schedule data for a location.
   * Returns the cached data if it's from the same day type, otherwise null.
   * @param {string} locationId
   * @returns {Array|null} Array of route objects with etas, or null if no valid cache
   */
  function loadScheduleCache(locationId) {
    try {
      var raw = localStorage.getItem(SCHEDULE_CACHE_KEY);
      if (!raw) return null;
      var all = JSON.parse(raw);
      var entry = all[locationId];
      if (!entry) return null;
      // Check if same day type and not older than 24 hours
      var now = Date.now();
      if (entry.dayType !== getDayType()) return null;
      if (now - entry.timestamp > 24 * 60 * 60 * 1000) return null;
      return entry.data;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save schedule data to cache for a location.
   * @param {string} locationId
   * @param {Array} data - Array of route objects with schedule times
   */
  function saveScheduleCache(locationId, data) {
    try {
      var raw = localStorage.getItem(SCHEDULE_CACHE_KEY);
      var all = {};
      if (raw) { try { all = JSON.parse(raw) || {}; } catch(e) { all = {}; } }
      all[locationId] = {
        dayType: getDayType(),
        timestamp: Date.now(),
        data: data
      };
      localStorage.setItem(SCHEDULE_CACHE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  // ===== Exports =====
  return {
    STORAGE_KEYS: STORAGE_KEYS,
    loadCustomLocations: loadCustomLocations,
    saveCustomLocations: saveCustomLocations,
    loadActiveLocation: loadActiveLocation,
    saveActiveLocation: saveActiveLocation,
    deleteCustomLocation: deleteCustomLocation,
    generateLocationId: generateLocationId,
    validateLocationName: validateLocationName,
    suggestDefaultName: suggestDefaultName,
    genericClassify: genericClassify,
    buildCustomConfig: buildCustomConfig,
    resolveLocation: resolveLocation,
    loadPriorityOverride: loadPriorityOverride,
    savePriorityOverride: savePriorityOverride,
    getEffectivePriority: getEffectivePriority,
    loadDefaultLocation: loadDefaultLocation,
    saveDefaultLocation: saveDefaultLocation,
    clearDefaultLocation: clearDefaultLocation,
    loadScheduleCache: loadScheduleCache,
    saveScheduleCache: saveScheduleCache,
    getDayType: getDayType
  };
});
