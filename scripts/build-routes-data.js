#!/usr/bin/env node
/**
 * build-routes-data.js — Pre-fetch all transit route shapes for the Seattle area
 *
 * Fetches from:
 * 1. OBA (OneBusAway) — route list, stop coordinates, direction groups
 * 2. OSRM (Open Source Routing Machine) — road-following polylines
 *
 * Outputs: ../routes-data.json — ready to load at app boot
 *
 * Usage: node scripts/build-routes-data.js
 *
 * Takes ~5-10 minutes due to rate limiting (OSRM public server).
 * Run once, or whenever routes change (seasonal schedule updates).
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OBA_BASE = 'https://api.pugetsound.onebusaway.org/api/where';
const OBA_KEY = '55c7b445-e38b-4da6-ba94-0006a4b3a4bf';
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';

// Agencies to fetch
const AGENCIES = ['1', '40', '23', '29', '96'];

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── OBA: Get all routes for an agency ────────────────────────────────────────

async function fetchAllRoutes() {
  console.log('Fetching route list from OBA...');
  const allRoutes = [];

  for (const agencyId of AGENCIES) {
    try {
      const url = `${OBA_BASE}/routes-for-agency/${agencyId}.json?key=${OBA_KEY}`;
      const j = await fetchJSON(url);
      const routes = j.data?.list || [];
      console.log(`  Agency ${agencyId}: ${routes.length} routes`);
      allRoutes.push(...routes.map(r => ({
        routeId: r.id,
        shortName: r.shortName || '',
        longName: r.longName || '',
        type: r.type,
        agencyId: r.agencyId,
        color: r.color ? `#${r.color}` : '#666',
        textColor: r.textColor ? `#${r.textColor}` : '#fff',
      })));
      await sleep(500);
    } catch (e) {
      console.warn(`  Agency ${agencyId} failed:`, e.message);
    }
  }

  console.log(`Total routes: ${allRoutes.length}`);
  return allRoutes;
}

// ─── OBA: Get stops and directions for a route ────────────────────────────────

async function fetchRouteDetails(routeId) {
  const url = `${OBA_BASE}/stops-for-route/${routeId}.json?key=${OBA_KEY}`;
  const j = await fetchJSON(url);
  const entry = j.data?.entry || {};
  const refs = j.data?.references || {};

  // Build stop lookup
  const stopRefs = {};
  (refs.stops || []).forEach(s => { stopRefs[s.id] = s; });

  // Get direction groups
  const groups = entry.stopGroupings?.[0]?.stopGroups || [];
  const polylines = (entry.polylines || []).map(p => p.points).filter(Boolean);

  const directions = groups.map((g, idx) => {
    const stopIds = g.stopIds || [];
    const stops = {};
    stopIds.forEach(id => {
      const s = stopRefs[id] || {};
      stops[id] = { name: s.name || id, lat: s.lat || 0, lon: s.lon || 0 };
    });

    return {
      name: g.name?.name || g.name || `Direction ${idx}`,
      stopIds,
      stops,
      obaPolyline: polylines[idx] || polylines[0] || '',
      polyline: '', // will be filled by OSRM
    };
  });

  return directions;
}

// ─── OSRM: Get road-following shape ──────────────────────────────────────────

async function fetchOSRMShape(stops) {
  if (stops.length < 2) return null;

  // OSRM expects lon,lat — limit to 100 waypoints
  const waypoints = stops
    .filter(s => s.lat && s.lon)
    .slice(0, 100)
    .map(s => `${s.lon},${s.lat}`)
    .join(';');

  if (!waypoints) return null;

  const url = `${OSRM_BASE}/${waypoints}?overview=full&geometries=polyline`;
  try {
    const j = await fetchJSON(url);
    if (j.code !== 'Ok' || !j.routes || !j.routes[0]) return null;
    return j.routes[0].geometry;
  } catch (e) {
    return null;
  }
}

// ─── Main build process ──────────────────────────────────────────────────────

async function main() {
  console.log('=== Building routes-data.json ===\n');

  // Step 1: Get all routes
  const allRoutes = await fetchAllRoutes();
  console.log('');

  // Step 2: For each route, get directions + stops + OSRM shapes
  const routesData = {};
  let processed = 0;
  const total = allRoutes.length;

  for (const route of allRoutes) {
    processed++;
    process.stdout.write(`\r[${processed}/${total}] ${route.shortName || route.routeId}...          `);

    try {
      const directions = await fetchRouteDetails(route.routeId);
      await sleep(300); // rate limit OBA

      // Fetch OSRM shape for each direction
      for (const dir of directions) {
        const stops = dir.stopIds
          .map(id => dir.stops[id])
          .filter(s => s && s.lat && s.lon);

        if (stops.length >= 2) {
          const osrmShape = await fetchOSRMShape(stops);
          if (osrmShape) {
            dir.polyline = osrmShape;
          } else {
            // Fall back to OBA polyline if OSRM fails
            dir.polyline = dir.obaPolyline;
          }
          await sleep(1000); // rate limit OSRM (public server)
        } else {
          dir.polyline = dir.obaPolyline;
        }

        // Remove obaPolyline from output (not needed)
        delete dir.obaPolyline;
      }

      routesData[route.routeId] = {
        routeId: route.routeId,
        shortName: route.shortName,
        longName: route.longName,
        type: route.type,
        agencyId: route.agencyId,
        color: route.color,
        textColor: route.textColor,
        directions,
      };

    } catch (e) {
      console.warn(`\n  Failed: ${route.routeId} — ${e.message}`);
    }
  }

  console.log('\n');

  // Step 3: Write output
  const outputPath = path.join(__dirname, '..', 'routes-data.json');
  const output = {
    generatedAt: new Date().toISOString(),
    routeCount: Object.keys(routesData).length,
    routes: routesData,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output));
  const sizeKB = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`✓ Written to: ${outputPath}`);
  console.log(`  Routes: ${output.routeCount}`);
  console.log(`  File size: ${sizeKB} KB`);
  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
