#!/usr/bin/env node
/**
 * NextUp Transit — Local Dev Server
 * Serves static files + provides API endpoints for route data management.
 *
 * Usage: node server.js [port]
 * Default port: 8080
 *
 * API Endpoints:
 *   GET  /api/routes-data       — Read routes-data.json
 *   POST /api/routes-data       — Write routes-data.json (full replace)
 *   PATCH /api/routes-data/:id  — Update a single route entry
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '8080', 10);
const ROOT = __dirname;
const ROUTES_FILE = path.join(ROOT, 'routes-data.json');

// MIME types for static files
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(json);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

async function handleAPI(req, res) {
  const url = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  // GET /api/routes-data — read the full file
  if (url === '/api/routes-data' && req.method === 'GET') {
    try {
      const data = fs.readFileSync(ROUTES_FILE, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    } catch (e) {
      sendError(res, 500, `Failed to read routes-data.json: ${e.message}`);
    }
    return true;
  }

  // POST /api/routes-data — full replace
  if (url === '/api/routes-data' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      fs.writeFileSync(ROUTES_FILE, JSON.stringify(parsed));
      sendJSON(res, 200, { ok: true, routeCount: Object.keys(parsed.routes || {}).length });
    } catch (e) {
      sendError(res, 400, `Failed to write: ${e.message}`);
    }
    return true;
  }

  // PATCH /api/routes-data/:routeId — update single route
  const patchMatch = url.match(/^\/api\/routes-data\/(.+)$/);
  if (patchMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    const routeId = decodeURIComponent(patchMatch[1]);
    try {
      const body = await readBody(req);
      const routeUpdate = JSON.parse(body);
      const raw = fs.readFileSync(ROUTES_FILE, 'utf8');
      const data = JSON.parse(raw);
      data.routes[routeId] = routeUpdate;
      fs.writeFileSync(ROUTES_FILE, JSON.stringify(data));
      sendJSON(res, 200, { ok: true, routeId });
    } catch (e) {
      sendError(res, 400, `Failed to patch route: ${e.message}`);
    }
    return true;
  }

  // DELETE /api/routes-data/:routeId — delete a route
  if (patchMatch && req.method === 'DELETE') {
    const routeId = decodeURIComponent(patchMatch[1]);
    try {
      const raw = fs.readFileSync(ROUTES_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.routes[routeId]) {
        delete data.routes[routeId];
        fs.writeFileSync(ROUTES_FILE, JSON.stringify(data));
        sendJSON(res, 200, { ok: true, deleted: routeId });
      } else {
        sendError(res, 404, `Route ${routeId} not found`);
      }
    } catch (e) {
      sendError(res, 400, `Failed to delete route: ${e.message}`);
    }
    return true;
  }

  // GET /api/gtfs/shape/:agencyId/:routeId/:directionId — get GTFS shape for a route direction
  const gtfsMatch = url.match(/^\/api\/gtfs\/shape\/(.+?)\/(.+?)\/(.+)$/);
  if (gtfsMatch && req.method === 'GET') {
    const [, agencyId, routeId, directionId] = gtfsMatch;
    try {
      // Read current route data to get OBA directions
      const routesRaw = fs.readFileSync(ROUTES_FILE, 'utf8');
      const routesData = JSON.parse(routesRaw);
      const obaRouteId = `${agencyId}_${routeId}`;
      const route = routesData.routes[obaRouteId];
      if (!route || !route.directions) {
        sendError(res, 404, 'Route not found in routes-data.json');
        return true;
      }

      const shapes = await getGTFSShapesForRoute(agencyId, obaRouteId, route.directions);
      if (shapes) {
        const dirIdx = parseInt(directionId);
        const shape = shapes[dirIdx];
        if (shape) {
          sendJSON(res, 200, shape);
        } else {
          sendError(res, 404, `No shape matched for direction ${directionId}`);
        }
      } else {
        sendError(res, 404, 'No parser available for this agency');
      }
    } catch (e) {
      sendError(res, 500, `GTFS fetch failed: ${e.message}`);
    }
    return true;
  }

  // POST /api/gtfs/refresh/:agencyId — download fresh GTFS data for an agency
  const gtfsRefreshMatch = url.match(/^\/api\/gtfs\/refresh\/(.+)$/);
  if (gtfsRefreshMatch && req.method === 'POST') {
    const agencyId = gtfsRefreshMatch[1];
    try {
      await downloadAndLoadGTFS(agencyId, true);
      sendJSON(res, 200, { ok: true, agency: agencyId });
    } catch (e) {
      sendError(res, 500, `GTFS download failed: ${e.message}`);
    }
    return true;
  }

  return false;
}

function serveStatic(req, res) {
  let filePath = path.join(ROOT, req.url.split('?')[0]);
  if (filePath.endsWith('/')) filePath += 'index.html';

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

  try {
    let stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GTFS DATA MANAGEMENT — uses parsers/
// ═══════════════════════════════════════════════════════════════════════════════

const https_mod = require('https');
const { execSync } = require('child_process');
const { getParser } = require('./parsers');
const { loadGTFS } = require('./parsers/gtfs-parser');

const GTFS_CACHE_DIR = path.join(ROOT, '.gtfs-cache');

// In-memory GTFS data cache
let gtfsCache = {}; // agencyId → loaded GTFS data

async function downloadAndLoadGTFS(agencyId, force = false) {
  const parser = getParser(agencyId);
  if (!parser) throw new Error(`No parser for agency ${agencyId}`);

  if (!fs.existsSync(GTFS_CACHE_DIR)) fs.mkdirSync(GTFS_CACHE_DIR, { recursive: true });

  const zipPath = path.join(GTFS_CACHE_DIR, `${agencyId}_gtfs.zip`);
  const extractDir = path.join(GTFS_CACHE_DIR, agencyId);

  // Check cache freshness (24h)
  if (!force && fs.existsSync(zipPath)) {
    const stat = fs.statSync(zipPath);
    const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    if (ageHours < 24 && gtfsCache[agencyId]) return gtfsCache[agencyId];
  }

  // Download
  console.log(`[GTFS] Downloading ${parser.GTFS_URL}...`);
  execSync(`curl -sL "${parser.GTFS_URL}" -o "${zipPath}"`);

  // Extract (include stop_times.txt for stop-based direction matching)
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });
  execSync(`unzip -o "${zipPath}" routes.txt trips.txt shapes.txt stop_times.txt -d "${extractDir}"`);

  // Load using shared parser
  gtfsCache[agencyId] = loadGTFS(extractDir);
  return gtfsCache[agencyId];
}

async function getGTFSShapesForRoute(agencyId, obaRouteId, obaDirections) {
  const parser = getParser(agencyId);
  if (!parser) return null;

  if (!gtfsCache[agencyId]) {
    await downloadAndLoadGTFS(agencyId);
  }

  return parser.getShapesForRoute(gtfsCache[agencyId], obaRouteId, obaDirections);
}

// ═══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const handled = await handleAPI(req, res);
    if (handled) return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`NextUp Transit server running at http://localhost:${PORT}`);
  console.log(`  Static files: ${ROOT}`);
  console.log(`  Routes data:  ${ROUTES_FILE}`);
  console.log(`  API: GET/POST /api/routes-data, PATCH/DELETE /api/routes-data/:id`);
});
