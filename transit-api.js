/**
 * transit-api.js — Service layer for NextUp Transit
 * All OBA API calls live here. Returns raw parsed JSON data.
 * No state, no UI, no localStorage. Pure async fetch functions.
 *
 * Depends on: getOBA() and getKEY() being available globally (set by home.js at boot).
 */

const TransitAPI = (function () {
  'use strict';

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function _base() { return (typeof getOBA === 'function') ? getOBA() : window._OBA_BASE || 'https://api.pugetsound.onebusaway.org/api/where'; }
  function _key()  { return (typeof getKEY === 'function') ? getKEY() : window._OBA_KEY  || '55c7b445-e38b-4da6-ba94-0006a4b3a4bf'; }

  async function _get(path) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${_base()}${path}${sep}key=${_key()}`);
    if (r.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return r.json();
  }

  // ─── Arrivals ────────────────────────────────────────────────────────────────

  /**
   * Fetch real-time + scheduled arrivals for a single stop.
   * @param {string} stopId
   * @param {number} [minutesAfter=60]
   * @returns {Promise<Object>} Raw OBA response JSON
   */
  async function fetchArrivalsForStop(stopId, minutesAfter = 60) {
    return _get(`/arrivals-and-departures-for-stop/${stopId}.json?minutesBefore=0&minutesAfter=${minutesAfter}`);
  }

  // ─── Schedule ────────────────────────────────────────────────────────────────

  /**
   * Fetch the full day schedule for a stop.
   * @param {string} stopId
   * @returns {Promise<Object>} Raw OBA response JSON
   */
  async function fetchScheduleForStop(stopId) {
    return _get(`/schedule-for-stop/${stopId}.json`);
  }

  // ─── Route Shape & Stops ─────────────────────────────────────────────────────

  /**
   * Fetch all stops and polylines for a route (both directions).
   * @param {string} routeId
   * @returns {Promise<Object>} Raw OBA response JSON
   */
  async function fetchStopsForRoute(routeId) {
    return _get(`/stops-for-route/${routeId}.json`);
  }

  /**
   * Fetch the encoded polyline shape for a route.
   * Fallback when stops-for-route doesn't include polylines.
   * @param {string} routeId
   * @returns {Promise<Object>} Raw OBA response JSON
   */
  async function fetchShapeForRoute(routeId) {
    return _get(`/shape/${routeId}.json`);
  }

  // ─── Vehicles ────────────────────────────────────────────────────────────────

  /**
   * Fetch live vehicle positions for a route.
   * Returns empty array (not an error) if route doesn't support tracking (404).
   * @param {string} routeId
   * @returns {Promise<Array>} Array of vehicle objects { vehicleId, lat, lon, tripHeadsign, distanceAlongTrip }
   */
  async function fetchVehiclesForRoute(routeId) {
    try {
      const j = await _get(`/vehicles-for-route/${routeId}.json`);
      return (j.data.list || []).map(v => ({
        vehicleId: v.vehicleId,
        lat: v.location?.lat || 0,
        lon: v.location?.lon || 0,
        tripHeadsign: v.tripStatus?.headsign || '',
        distanceAlongTrip: v.tripStatus?.distanceAlongTrip || 0,
      }));
    } catch (e) {
      if (e.status === 404) return []; // route doesn't support vehicle tracking
      throw e;
    }
  }

  // ─── Nearby Stops ────────────────────────────────────────────────────────────

  /**
   * Fetch stops near a lat/lon within a given radius.
   * @param {number} lat
   * @param {number} lon
   * @param {number} [radius=400] metres
   * @returns {Promise<Object>} Raw OBA response JSON
   */
  async function fetchStopsForLocation(lat, lon, radius = 400) {
    return _get(`/stops-for-location.json?lat=${lat}&lon=${lon}&radius=${radius}`);
  }

  // ─── Service Alerts ──────────────────────────────────────────────────────────

  /**
   * Fetch active service situations for a route.
   * Used to decide whether to invalidate the static shape cache.
   * @param {string} routeId
   * @returns {Promise<Array>} Array of situation objects
   */
  async function fetchSituationsForRoute(routeId) {
    try {
      const j = await _get(`/situations-for-route/${routeId}.json`);
      return j.data?.list || [];
    } catch (e) {
      return []; // on error, assume no alerts
    }
  }

  // ─── OSRM Route Matching ──────────────────────────────────────────────────

  /**
   * Fetch a road-following route shape from OSRM (Open Source Routing Machine).
   * Takes an array of stop coordinates and returns an encoded polyline that
   * follows actual roads between them. Used when OBA's polyline is bad/missing.
   *
   * @param {Array<{lat: number, lon: number}>} stops — ordered stop coordinates
   * @param {string} [profile='driving'] — 'driving' for buses, 'foot' for walking
   * @returns {Promise<string|null>} — encoded polyline string, or null on failure
   */
  async function fetchOSRMShape(stops, profile = 'driving') {
    if (!stops || stops.length < 2) return null;

    // OSRM expects coordinates as lon,lat (reversed from our lat,lon)
    // Limit to 100 waypoints (OSRM public server limit)
    const waypoints = stops
      .filter(s => s.lat && s.lon)
      .slice(0, 100)
      .map(s => `${s.lon},${s.lat}`)
      .join(';');

    if (!waypoints) return null;

    try {
      const url = `https://router.project-osrm.org/route/v1/${profile}/${waypoints}?overview=full&geometries=polyline`;
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      if (j.code !== 'Ok' || !j.routes || !j.routes[0]) return null;
      return j.routes[0].geometry; // encoded polyline string
    } catch (e) {
      return null;
    }
  }

  // ─── Route Schedule (all stops) ──────────────────────────────────────────────

  /**
   * Fetch schedule data for all stops in a route's directions.
   * Calls schedule-for-stop for each unique stop ID across all directions.
   * Staggers requests to avoid rate limiting.
   *
   * @param {Array} directions  — from TransitStore (already parsed)
   * @param {number} [staggerMs=800]  — ms between each stop fetch
   * @returns {Promise<Object>}  — { directionName: { stopId: [ms, ...] } }
   */
  async function fetchRouteSchedule(directions, staggerMs = 800) {
    // Collect all unique stop IDs across all directions
    const allStopIds = new Set();
    for (const dir of directions) {
      for (const stopId of (dir.stopIds || [])) {
        allStopIds.add(stopId);
      }
    }

    // Fetch schedule for each stop with stagger
    const stopIds = [...allStopIds];
    const scheduleByStop = {}; // stopId → { headsign: [ms, ...] }

    await Promise.allSettled(stopIds.map(async (stopId, idx) => {
      await new Promise(r => setTimeout(r, idx * staggerMs));
      try {
        const j = await _get(`/schedule-for-stop/${stopId}.json`);
        const entry = j.data?.entry || {};

        for (const sr of entry.stopRouteSchedules || []) {
          for (const dir of sr.stopRouteDirectionSchedules || []) {
            const times = (dir.scheduleStopTimes || [])
              .map(t => t.arrivalTime || t.departureTime)
              .filter(Boolean);
            if (!times.length) continue;

            const headsign = dir.tripHeadsign || '';
            if (!scheduleByStop[stopId]) scheduleByStop[stopId] = {};
            if (!scheduleByStop[stopId][headsign]) scheduleByStop[stopId][headsign] = [];
            scheduleByStop[stopId][headsign].push(...times);
          }
        }
      } catch (e) {
        // Skip failed stops — partial schedule is better than none
      }
    }));

    // Reorganize into { directionName: { stopId: [ms, ...] } }
    const result = {};
    for (const dir of directions) {
      result[dir.name] = {};
      const dirName = dir.name || '';
      const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const dirWords = dirName.toLowerCase().split(/\s+/).filter(w => w.length > 2);

      for (const stopId of (dir.stopIds || [])) {
        const stopSchedules = scheduleByStop[stopId] || {};
        let bestTimes = [], bestScore = -1;
        for (const [headsign, times] of Object.entries(stopSchedules)) {
          const hn = normalize(headsign);
          const score = dirWords.filter(w => hn.includes(normalize(w))).length;
          if (score > bestScore || (score === bestScore && times.length > bestTimes.length)) {
            bestScore = score;
            bestTimes = times;
          }
        }
        if (bestTimes.length) {
          result[dir.name][stopId] = [...new Set(bestTimes)].sort((a, b) => a - b);
        }
      }
    }

    return result;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    fetchArrivalsForStop,
    fetchScheduleForStop,
    fetchStopsForRoute,
    fetchShapeForRoute,
    fetchVehiclesForRoute,
    fetchStopsForLocation,
    fetchSituationsForRoute,
    fetchRouteSchedule,
    fetchOSRMShape,
  };

})();
