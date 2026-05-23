/**
 * gtfs-parser.js — Shared GTFS parsing utilities
 *
 * Reads GTFS files and maps shapes to OBA directions using stop ID matching.
 * This is the translation layer between GTFS raw data and our OBA-based data store.
 *
 * Key insight: GTFS stop_times.txt links trips → stops → shapes.
 * GTFS stop IDs map to OBA stop IDs by adding the agency prefix (e.g. '1_' + '12210' = '1_12210').
 */

const fs = require('fs');
const path = require('path');

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].trim().replace(/^\uFEFF/, '').split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.split(',');
    const row = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

function encodePolyline(points) {
  let encoded = '';
  let prevLat = 0, prevLng = 0;
  for (const [lat, lng] of points) {
    const latInt = Math.round(lat * 1e5), lngInt = Math.round(lng * 1e5);
    const dLat = latInt - prevLat, dLng = lngInt - prevLng;
    prevLat = latInt; prevLng = lngInt;
    for (const v of [dLat, dLng]) {
      let val = v < 0 ? ~(v << 1) : (v << 1);
      let chunk = '';
      while (val >= 0x20) { chunk += String.fromCharCode((0x20 | (val & 0x1f)) + 63); val >>= 5; }
      chunk += String.fromCharCode(val + 63);
      encoded += chunk;
    }
  }
  return encoded;
}

/**
 * Load and index GTFS data from an extracted directory.
 */
function loadGTFS(extractDir) {
  console.log(`[GTFS] Loading from ${extractDir}...`);

  const tripsRaw = parseCSV(path.join(extractDir, 'trips.txt'));
  const tripsByRoute = {};
  for (const row of tripsRaw) {
    if (!row.route_id || !row.shape_id) continue;
    if (!tripsByRoute[row.route_id]) tripsByRoute[row.route_id] = {};
    const dir = row.direction_id || '0';
    if (!tripsByRoute[row.route_id][dir]) tripsByRoute[row.route_id][dir] = [];
    tripsByRoute[row.route_id][dir].push({ tripId: row.trip_id, shapeId: row.shape_id });
  }

  const stopTimesRaw = parseCSV(path.join(extractDir, 'stop_times.txt'));
  const stopsByTrip = {};
  for (const row of stopTimesRaw) {
    if (!row.trip_id || !row.stop_id) continue;
    if (!stopsByTrip[row.trip_id]) stopsByTrip[row.trip_id] = [];
    stopsByTrip[row.trip_id].push({ stopId: row.stop_id, seq: parseInt(row.stop_sequence) || 0 });
  }
  for (const tripId in stopsByTrip) {
    stopsByTrip[tripId].sort((a, b) => a.seq - b.seq);
  }

  const shapesRaw = parseCSV(path.join(extractDir, 'shapes.txt'));
  const shapes = {};
  for (const row of shapesRaw) {
    if (!row.shape_id) continue;
    if (!shapes[row.shape_id]) shapes[row.shape_id] = [];
    shapes[row.shape_id].push([parseInt(row.shape_pt_sequence) || 0, parseFloat(row.shape_pt_lat), parseFloat(row.shape_pt_lon)]);
  }
  for (const shapeId in shapes) {
    shapes[shapeId].sort((a, b) => a[0] - b[0]);
    shapes[shapeId] = shapes[shapeId].map(([, lat, lon]) => [lat, lon]);
  }

  console.log(`[GTFS] Loaded: ${Object.keys(tripsByRoute).length} routes, ${Object.keys(stopsByTrip).length} trips, ${Object.keys(shapes).length} shapes`);
  return { tripsByRoute, stopsByTrip, shapes };
}

/**
 * Match GTFS shapes to OBA directions using stop ID overlap.
 *
 * @param {object} gtfsData — from loadGTFS()
 * @param {string} gtfsRouteId — GTFS route_id (e.g. '100009')
 * @param {string} obaPrefix — OBA agency prefix (e.g. '1_')
 * @param {Array} obaDirections — [{ name, stopIds: ['1_12210', ...] }]
 * @returns {Array} — same length as obaDirections, each { polyline, shapeId, matchedStops } or null
 */
function matchShapesToDirections(gtfsData, gtfsRouteId, obaPrefix, obaDirections) {
  const { tripsByRoute, stopsByTrip, shapes } = gtfsData;
  const routeTrips = tripsByRoute[gtfsRouteId];
  if (!routeTrips) return obaDirections.map(() => null);

  // For each GTFS direction, find the representative trip (most stops) and its shape
  const gtfsDirData = {};
  for (const [dirId, trips] of Object.entries(routeTrips)) {
    let bestTrip = null, bestStopCount = 0;
    for (const { tripId, shapeId } of trips) {
      const stops = stopsByTrip[tripId];
      if (stops && stops.length > bestStopCount) {
        bestStopCount = stops.length;
        bestTrip = { tripId, shapeId, stops: stops.map(s => s.stopId) };
      }
    }
    if (bestTrip && shapes[bestTrip.shapeId]) {
      gtfsDirData[dirId] = {
        shapeId: bestTrip.shapeId,
        stopIds: bestTrip.stops,
        coords: shapes[bestTrip.shapeId],
      };
    }
  }

  // Match each OBA direction to a GTFS direction by stop ID overlap
  const results = [];
  const usedGtfsDirs = new Set();

  for (const obaDir of obaDirections) {
    const obaStopsRaw = (obaDir.stopIds || []).map(id => id.replace(obaPrefix, ''));

    let bestMatch = null, bestScore = 0;
    for (const [dirId, gtfsDir] of Object.entries(gtfsDirData)) {
      if (usedGtfsDirs.has(dirId)) continue;
      const gtfsStopSet = new Set(gtfsDir.stopIds);
      const overlap = obaStopsRaw.filter(id => gtfsStopSet.has(id)).length;
      if (overlap > bestScore) { bestScore = overlap; bestMatch = { dirId, ...gtfsDir }; }
    }

    if (bestMatch && bestScore >= 2) {
      usedGtfsDirs.add(bestMatch.dirId);

      // Ensure polyline orientation matches OBA stop order
      const firstObaStop = obaStopsRaw[0];
      const lastObaStop = obaStopsRaw[obaStopsRaw.length - 1];
      const firstIdx = bestMatch.stopIds.indexOf(firstObaStop);
      const lastIdx = bestMatch.stopIds.indexOf(lastObaStop);

      let coords = bestMatch.coords;
      if (firstIdx > lastIdx && firstIdx >= 0 && lastIdx >= 0) {
        coords = [...coords].reverse();
      }

      results.push({ polyline: encodePolyline(coords), shapeId: bestMatch.shapeId, matchedStops: bestScore });
    } else {
      results.push(null);
    }
  }

  return results;
}

module.exports = { parseCSV, encodePolyline, loadGTFS, matchShapesToDirections };
