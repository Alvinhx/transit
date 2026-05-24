/* NextUp Transit — route-detail.js v2.0 */
/* Route detail panel: map, ETAs from nearest stop, stop list */
/* Data layer: TransitStore (static) + LiveCache (live ETAs) + TransitAPI (fetch) */

// ===== STATE =====
var _detailOpen = false;
var _detailRouteId = null;
var _detailRouteData = null;
var _detailMap = null;
var _detailVehicleMarkers = [];
var _detailVehicleInterval = null;
var _detailNearestStopId = null;
var _detailPassedVisible = false;
var _detailAllStops = [];       // stops for the selected direction
var _detailDirection = null;    // current direction entry from TransitStore

// Map layer references — kept so we can update without full redraw
var _detailBaseLayer = null;    // Phase 1: full route, passed style
var _detailUpcomingLayer = null; // Phase 2: upcoming segment, bold style
var _detailStopMarkers = [];    // all stop dot markers

// Location state — delegated to AppState
var _detailUserMarker = null;
var _detailLocCentered = false;

function _getUserLat() { return typeof AppState !== 'undefined' ? AppState.userLat : null; }
function _getUserLon() { return typeof AppState !== 'undefined' ? AppState.userLon : null; }

function _ensureLocationWatch() {
  if (typeof AppState !== 'undefined') AppState.startLocationWatch();
}

// ===== ROUTE ID FALLBACK MAP =====
// Verified OBA IDs for KC Metro (agency 1) and Sound Transit (agency 40)
const _ROUTE_ID_MAP = {
  // Sound Transit Light Rail
  "1":               "40_100479",
  "2":               "40_2LINE",
  // KC Metro buses (verified from OBA routes-for-agency/1)
  "3":               "1_100173",
  "4":               "1_100219",
  "5":               "1_100229",
  "7":               "1_100263",
  "8":               "1_100275",
  "9":               "1_100289",
  "10":              "1_100002",
  "11":              "1_100009",
  "12":              "1_100018",
  "13":              "1_100028",
  "14":              "1_100039",
  "17":              "1_100062",
  "21":              "1_100101",
  "22":              "1_100111",
  "24":              "1_100132",
  "27":              "1_100161",
  "28":              "1_100169",
  "31":              "1_100184",
  "32":              "1_100193",
  "33":              "1_100194",
  "36":              "1_100210",
  "40":              "1_102574",
  "43":              "1_100223",
  "44":              "1_100224",
  "45":              "1_100225",
  "47":              "1_100047",
  "48":              "1_100228",
  "49":              "1_100447",
  "50":              "1_100230",
  "56":              "1_100242",
  "57":              "1_100246",
  "60":              "1_100249",
  "61":              "1_102747",
  "62":              "1_100252",
  "65":              "1_100254",
  "67":              "1_100259",
  "70":              "1_100264",
  "75":              "1_100269",
  "79":              "1_102732",
  // Streetcars
  "First Hill":      "23_102638",
  "South Lake Union":"23_100340",
  // RapidRide
  "C":               "1_102576",
  "D":               "1_102581",
  "E":               "1_102615",
  "F":               "1_102619",
  "G":               "1_102745",
  "H":               "1_102736",
  // ST Express
  "510":             "40_510",
  "512":             "40_512",
  "513":             "40_513",
  "515":             "40_515",
  "522":             "40_100232",
  "532":             "40_532",
  "535":             "40_535",
  "542":             "40_100511",
  "545":             "40_100236",
  "550":             "40_100239",
  "554":             "40_100240",
  "556":             "40_100451",
  "560":             "40_560",
  "566":             "40_102734",
  "570":             "40_102758",
  "574":             "40_574",
  "577":             "40_577",
  "578":             "40_578",
  "580":             "40_580",
  "586":             "40_586",
  "590":             "40_590",
  "592":             "40_592",
  "594":             "40_594",
  "595":             "40_595",
  "596":             "40_596",
  // Swift BRT
  "Swift Orange":    "29_703",
  "Swift Blue":      "29_701",
  "Swift Green":     "29_702",
  // Community Transit
  "101":             "29_101",
  "102":             "29_102",
  "103":             "29_103",
  "106":             "29_106",
  "109":             "29_109",
  "111":             "29_111",
  "112":             "29_112",
  "114":             "29_114",
  "117":             "29_117",
  "119":             "29_119",
  "120":             "29_120",
  "121":             "29_121",
  "130":             "29_130",
  "166":             "29_166",
  "201":             "29_201",
  "202":             "29_202",
  "209":             "29_209",
  "220":             "29_220",
  "222":             "29_222",
  "230":             "29_230",
  "240":             "29_240",
  "270":             "29_270",
  "271":             "29_271",
  "280":             "29_280",
  "424":             "29_424",
};

// ===== MAP STYLE CONSTANTS (from Figma M3 Tonal Palette) =====
// Tone 40 = upcoming segment (vivid, full saturation)
// Tone 10 = base/passed segment (very dark, low saturation)
// Keyed by the route's OBA API color hex

const _ROUTE_TONE_MAP = {
  '#3DAE2B': { t80: '#A8E09E', t40: '#328f23' },  // 1 Line Light Rail
  '#00A0DF': { t80: '#80D0EF', t40: '#0080b2' },  // 2 Line Light Rail
  '#E5007D': { t80: '#F280BE', t40: '#ca006e' },  // First Hill Streetcar
  '#9C182F': { t80: '#CD8C97', t40: '#891428' },  // RapidRide
  '#2B376E': { t80: '#959BB7', t40: '#263061' },  // ST Express
  '#FDB71A': { t80: '#FEDB8D', t40: '#dfa117' },  // KC Metro Bus
  '#F47836': { t80: '#FABC9B', t40: '#d1651d' },  // Swift Orange
  '#006CFF': { t80: '#80B6FF', t40: '#005fe0' },  // Swift Blue
  '#0070C0': { t80: '#80B8E0', t40: '#005fe0' },  // Swift Blue alt
  '#666672': { t80: '#B3B3B9', t40: '#5a5a65' },  // Monorail
};

function _getRouteColors() {
  const apiColor = (_detailRouteData && _detailRouteData.color) || '#FDB71A';
  const tones = _ROUTE_TONE_MAP[apiColor.toUpperCase()] || _ROUTE_TONE_MAP[apiColor] || null;
  return {
    upcoming: tones ? tones.t40 : apiColor,      // tone 40 — vivid, upcoming segment
    base:     tones ? tones.t80 : '#cccccc',      // tone 80 — lighter, passed segment
  };
}

// Legacy constants kept for stop dot colors
const _ROUTE_UPCOMING_COLOR = '#22C55E';  // fallback only
const _ROUTE_PASSED_COLOR   = '#8E9D94';  // fallback only
const _STOP_UPCOMING_FILL   = '#ffffff';
const _STOP_PASSED_FILL     = '#E9E9E9';
const _STOP_CURRENT_FILL    = '#3B82F6';

// ===== OPEN / CLOSE =====

function openRouteDetail(cardData) {
  console.log('[detail] openRouteDetail called, route:', cardData.route, 'routeId:', cardData.routeId, '_detailOpen:', _detailOpen);
  if (_detailOpen) {
    closeRouteDetail();
    setTimeout(() => openRouteDetail(cardData), 400);
    return;
  }
  _detailOpen = true;
  _detailRouteData = cardData;
  _detailPassedVisible = false;
  _detailAllStops = [];
  _detailDirection = null;

  _detailRouteId = cardData.routeId || _ROUTE_ID_MAP[cardData.route] || null;

  _renderDetailPanel();
  // _loadDetailData() is called from _initDetailMap after the map is ready
}

function closeRouteDetail() {
  _detailOpen = false;
  _detailRouteId = null;
  _detailRouteData = null;
  _detailAllStops = [];
  _detailDirection = null;
  _detailNearestStopId = null;
  _detailPassedVisible = false;
  _detailBaseLayer = null;
  _detailUpcomingLayer = null;
  _detailStopMarkers = [];

  if (_detailVehicleInterval) {
    clearInterval(_detailVehicleInterval);
    _detailVehicleInterval = null;
  }
  _detailUserMarker = null;
  _detailLocCentered = false;

  if (_detailMap) {
    _detailMap.remove();
    _detailMap = null;
  }
  _detailVehicleMarkers = [];

  const panel = document.getElementById('detail-panel');
  if (panel) {
    panel.classList.remove('open');
    panel.style.pointerEvents = 'none';
    setTimeout(() => { if (panel && panel.parentNode) panel.remove(); }, 400);
  }

  document.body.classList.remove('detail-open-desktop');
}

// ===== RENDER PANEL SHELL =====

function _renderDetailPanel() {
  const g = _detailRouteData;
  const isDesktop = window.innerWidth > 700;

  // Remove any existing panel
  const existing = document.getElementById('detail-panel');
  if (existing) existing.remove();

  const isIcon = g.badge === 'square' && (g.mode === 'streetcar' || g.mode === 'monorail' || g.mode === 'swift');
  const badgeInner = isIcon
    ? `<span class="badge-icon" style="font-size:24px;font-family:'Material Symbols Rounded'">${g.mode === 'monorail' ? 'train' : g.mode === 'swift' ? 'directions_bus' : 'tram'}</span>`
    : `<span class="detail-route-badge-num">${g.route}</span>${g.mode === 'rail' ? '<span class="detail-route-badge-sub">LINE</span>' : ''}`;

  const isLight = document.body.classList.contains('light');

  // M3 Tonal palette — same as home page cards
  const TONES={
    "#3DAE2B":{dark:{card:"#0E280A",tagBg:"#2B7A1E",tagTxt:"#B5EAAD"},light:{card:"#DAF4D6",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#2B7A1E"}},
    "#00A0DF":{dark:{card:"#002433",tagBg:"#006D99",tagTxt:"#99E2FF"},light:{card:"#CCF0FE",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#006D99"}},
    "#FDB71A":{dark:{card:"#1a1712",tagBg:"#7e5c0d",tagTxt:"#ffe500"},light:{card:"#ffefcd",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#be8914"}},
    "#9C182F":{dark:{card:"#1a1214",tagBg:"#4e0b17",tagTxt:"#fd3154"},light:{card:"#e9ccd1",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#751122"}},
    "#2B376E":{dark:{card:"#12141f",tagBg:"#161c37",tagTxt:"#7083d7"},light:{card:"#cdd2ee",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#132686"}},
    "#E5007D":{dark:{card:"#1a0f14",tagBg:"#72003e",tagTxt:"#ff00be"},light:{card:"#f9c7e2",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#ac005e"}},
    "#F47836":{dark:{card:"#1a0f14",tagBg:"#72003e",tagTxt:"#ff00be"},light:{card:"#f9c7e2",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#ac005e"}},
    "#666672":{dark:{card:"#141417",tagBg:"#333339",tagTxt:"#9090a4"},light:{card:"#dddde0",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#4d4d56"}},
    "#F24C21":{dark:{card:"#1a140f",tagBg:"#773911",tagTxt:"#ffa427"},light:{card:"#fbe0ce",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#b25619"}},
    "#006CFF":{dark:{card:"#0f141f",tagBg:"#003680",tagTxt:"#00a1ff"},light:{card:"#c7dfff",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#0051bf"}},
    "#0070C0":{dark:{card:"#0f141f",tagBg:"#003680",tagTxt:"#00a1ff"},light:{card:"#c7dfff",tagBg:"rgba(255,255,255,0.7)",tagTxt:"#0051bf"}}
  };
  const tone = TONES[g.color];
  const theme = isLight ? 'light' : 'dark';
  const cardBg = tone ? tone[theme].card : (isLight ? 'rgba(200,200,200,0.3)' : 'rgba(255,255,255,0.08)');
  const tagBg = tone ? tone[theme].tagBg : (isLight ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.06)');
  const tagColor = tone ? tone[theme].tagTxt : (isLight ? '#333' : '#aaa');

  const page = document.createElement('div');
  page.id = 'detail-panel';
  page.className = 'detail-page';

  // Pre-calculate map dimensions from known screen size — no dynamic measurement needed
  const screenH = (typeof AppState !== 'undefined') ? AppState.screenH : window.innerHeight;
  const screenW = (typeof AppState !== 'undefined') ? AppState.screenW : window.innerWidth;
  const sheetH = Math.round(screenH * 0.45);
  const mapH = screenH - sheetH;

  page.innerHTML = `
    <div id="detail-map" style="width:${screenW}px;height:${mapH}px"></div>
    <div class="detail-map-overlays">
      <div class="detail-route-badge-card" style="background:${cardBg}">
        <div class="detail-route-badge-circle" style="background:${g.color}">
          ${badgeInner}
        </div>
        <div class="detail-route-badge-info">
          <div class="detail-route-tag" style="background:${tagBg};color:${tagColor}">${g.tag}</div>
          <div class="detail-route-direction" style="color:${tagColor}">${g.headsign || ''}</div>
        </div>
      </div>
      <div class="detail-map-actions">
        <button class="detail-action-btn detail-btn-close" id="detail-close-btn" aria-label="Close">
          <span class="material-icons" style="font-size:20px">close</span>
        </button>
        <button id="detail-locate-btn" class="detail-action-btn detail-btn-locate hidden" aria-label="My location">
          <span class="material-icons" style="font-size:20px">navigation</span>
        </button>
        <button id="detail-zoom-in-btn" class="detail-action-btn" aria-label="Zoom in" style="background:var(--surface);color:var(--text);font-size:22px;font-weight:300;margin-top:4px">+</button>
        <button id="detail-zoom-out-btn" class="detail-action-btn" aria-label="Zoom out" style="background:var(--surface);color:var(--text);font-size:22px;font-weight:300">−</button>
      </div>
    </div>
    <div class="detail-sheet" id="detail-sheet">
      <div class="detail-drag-handle" id="detail-drag-handle"></div>
      <div class="detail-etas-row">
        <div class="detail-etas-info">
          <div class="detail-direction-label" id="detail-etas-label">Loading…</div>
          <div class="detail-stop-label" id="detail-stop-label"></div>
        </div>
        <div class="detail-etas-pills" id="detail-etas-pills"></div>
      </div>
      <div class="detail-divider"></div>
      <div class="detail-stops-wrap" id="detail-stops-section">
        <div class="detail-loading">Loading stops…</div>
      </div>
    </div>
  `;

  if (isDesktop) {
    document.body.classList.add('detail-open-desktop');
  }
  document.body.appendChild(page);

  // Wire buttons immediately — element is in DOM right after appendChild
  page.querySelector('#detail-close-btn').addEventListener('click', closeRouteDetail);
  page.querySelector('#detail-locate-btn').addEventListener('click', _detailCenterOnUser);
  page.querySelector('#detail-zoom-in-btn').addEventListener('click', () => { if(_detailMap) _detailMap.zoomIn(); });
  page.querySelector('#detail-zoom-out-btn').addEventListener('click', () => { if(_detailMap) _detailMap.zoomOut(); });

  // Trigger open animation
  requestAnimationFrame(() => page.classList.add('open'));

  // Init sheet first (sets _sheetCurrentH), then map (uses correct height)
  _initSheetDrag();
  setTimeout(_initDetailMap, 100);
}
// ===== MAP =====

function _initDetailMap() {
  console.log('[map] _initDetailMap called, mapEl:', !!document.getElementById('detail-map'), '_detailMap:', !!_detailMap);
  const mapEl = document.getElementById('detail-map');
  if (!mapEl) return;
  // If a stale map instance exists (e.g. from an interrupted open), destroy it first
  if (_detailMap) {
    _detailMap.remove();
    _detailMap = null;
  }

  // Map container already has explicit pixel dimensions set at creation time
  // No need to call _updateMapHeight() before init — dimensions are pre-known

  // Use AppState for tile URL — single source of truth for theme
  const tileUrl = (typeof AppState !== 'undefined')
    ? AppState.getMapTileUrl()
    : (document.body.classList.contains('light')
        ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png');

  // Start at a neutral Seattle view — will be overridden by fitBounds once stops load
  // preferCanvas: true — uses Canvas rendering instead of SVG for faster line drawing
  _detailMap = L.map('detail-map', { zoomControl: false, attributionControl: false, preferCanvas: true })
    .setView([47.6062, -122.3321], 13);

  L.tileLayer(tileUrl, { maxZoom: 19 }).addTo(_detailMap);

  // Force correct dimensions immediately — prevents polylines from being invisible on first open
  _detailMap.invalidateSize({ animate: false });

  // No built-in zoom control — we use custom buttons in the overlay

  // Hide locate button when user drags map away from their location
  _detailMap.on('dragstart', () => {
    _detailLocCentered = false;
    _showLocateButton(true);
  });

  // Start persistent location watch (no-op if already running)
  _ensureLocationWatch();

  // Register for location updates — draws dot when GPS first arrives, and keeps it moving
  if (typeof AppState !== 'undefined') {
    AppState.onLocationUpdate(() => _updateUserDot());
  }

  // If we already have location from a previous open, draw the dot immediately
  if (_getUserLat() !== null) {
    setTimeout(_updateUserDot, 150);
  }

  // Map is ready — start loading data
  _loadDetailData();
}

function _updateUserDot() {
  if (!_detailMap) return;
  const lat = _getUserLat(), lon = _getUserLon();
  if (lat === null) return;
  const latlng = [lat, lon];
  if (_detailUserMarker) {
    _detailUserMarker.setLatLng(latlng);
  } else {
    _detailUserMarker = L.circleMarker(latlng, {
      radius: 8, color: '#fff', fillColor: '#3B82F6', fillOpacity: 1, weight: 2,
    }).addTo(_detailMap);
    _detailUserMarker.bindPopup('You are here');
    // Don't call setView here — Phase 3 (_refitToUserContext) handles centering.
    // Only show the locate button if the user has panned away.
    if (!_detailLocCentered) {
      _showLocateButton(true);
    }
  }
}

function _detailCenterOnUser() {
  const lat = _getUserLat(), lon = _getUserLon();
  if (lat !== null) {
    _detailMap.setView([lat, lon], 15);
    _detailLocCentered = true;
    _showLocateButton(false);
  } else if (typeof AppState !== 'undefined') {
    // Request location via AppState — prompts only if not yet granted
    AppState.requestLocation(
      (lat, lon) => {
        _updateUserDot();
        _ensureLocationWatch();
      },
      () => {} // denied — nothing to do
    );
  }
}

function _showLocateButton(visible) {
  const btn = document.getElementById('detail-locate-btn');
  if (!btn) return;
  if (visible) btn.classList.remove('hidden');
  else btn.classList.add('hidden');
}

// ===== DRAGGABLE SHEET =====
// Three snap points: collapsed (~120px), mid (~45vh), expanded (~90vh)

var _sheetDragStartY = 0;
var _sheetDragStartH = 0;
var _sheetCurrentH = 0;

function _initSheetDrag() {
  const sheet = document.getElementById('detail-sheet');
  if (!sheet) return;

  const vh = (typeof AppState !== 'undefined') ? AppState.screenH : window.innerHeight;
  const snapCollapsed = 120;
  const snapMid = Math.round(vh * 0.45);
  // Cap expanded height so sheet never overlaps the badge card overlay.
  // Measure the badge card's actual rendered height at runtime — works on any screen size.
  const badgeCard = document.querySelector('.detail-route-badge-card');
  const badgeBottom = badgeCard
    ? badgeCard.getBoundingClientRect().bottom + 12  // 12px gap below the card
    : 180;  // fallback if element not found
  const snapExpanded = vh - badgeBottom;

  // Start at mid
  _sheetCurrentH = snapMid;
  sheet.style.height = snapMid + 'px';
  _updateMapHeight();

  const handle = document.getElementById('detail-drag-handle');
  if (!handle) return;

  function onDragStart(clientY) {
    _sheetDragStartY = clientY;
    _sheetDragStartH = sheet.offsetHeight;
    sheet.style.transition = 'none';
  }

  function onDragMove(clientY) {
    const delta = _sheetDragStartY - clientY;
    const newH = Math.max(snapCollapsed, Math.min(snapExpanded, _sheetDragStartH + delta));
    sheet.style.transition = 'none';
    sheet.style.height = newH + 'px';
    _sheetCurrentH = newH;
    _updateMapHeight();
    if (_detailMap) _detailMap.invalidateSize({ animate: false });
  }

  function onDragEnd() {
    sheet.style.transition = 'height 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
    // Snap to nearest point
    const snaps = [snapCollapsed, snapMid, snapExpanded];
    const nearest = snaps.reduce((a, b) => Math.abs(b - _sheetCurrentH) < Math.abs(a - _sheetCurrentH) ? b : a);
    sheet.style.height = nearest + 'px';
    _sheetCurrentH = nearest;
    // Refit map to account for new sheet height
    setTimeout(_refitMapToSheet, 320);
  }

  // Touch — attach move/end to document (like mouse) so drag works even if finger leaves handle
  handle.addEventListener('touchstart', e => {
    onDragStart(e.touches[0].clientY);
    const onTouchMove = ev => { ev.preventDefault(); onDragMove(ev.touches[0].clientY); };
    const onTouchEnd = () => { onDragEnd(); document.removeEventListener('touchmove', onTouchMove); document.removeEventListener('touchend', onTouchEnd); };
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  }, { passive: true });

  // Mouse
  handle.addEventListener('mousedown', e => {
    onDragStart(e.clientY);
    const onMove = ev => onDragMove(ev.clientY);
    const onUp = () => { onDragEnd(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Route line + stop dot style constants are declared at the top of this file.
// _drawRouteOnMap and _decodePolyline have been replaced by the layered
// _drawBaseLayer / _drawUpcomingOverlay functions above, which use
// decodePolyline() and findSplitIndex() from transit-logic.js.

function _updateVehicleMarkers(vehicles) {
  if (!_detailMap) return;

  // Remove old markers
  _detailVehicleMarkers.forEach(m => _detailMap.removeLayer(m));
  _detailVehicleMarkers = [];

  vehicles.forEach(v => {
    if (!v.lat && !v.lon) return;

    const mode = _detailRouteData ? _detailRouteData.mode : 'bus';
    const iconGlyph = (mode === 'rail') ? '🚇' : (mode === 'streetcar') ? '🚋' : '🚌';
    const { upcoming: upcomingColor } = _getRouteColors();

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:36px;height:36px;border-radius:50%;background:#fff;border:3px solid ${upcomingColor};display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;box-shadow:0 2px 6px rgba(0,0,0,0.25)">${iconGlyph}</div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    const marker = L.marker([v.lat, v.lon], { icon }).addTo(_detailMap);
    marker.bindPopup(`<b>${v.tripHeadsign || 'In service'}</b>`);
    _detailVehicleMarkers.push(marker);
  });
}

// ===== DATA LOADING — Three-phase approach =====
//
// Phase 1: Load route shape from TransitStore (instant if cached, fetch if not)
//          → Draw full route as base layer (all passed style)
//          → fitBounds to full route
//
// Phase 2: Resolve nearest stop via GPS
//          → Overlay upcoming segment (bold vivid green) on top of base layer
//          → Update stop dots
//
// Phase 3: Re-center map to GPS dot + nearest stop context
//          → Draw GPS dot
//          → fitBounds to upcoming stops

async function _loadDetailData() {
  console.log('[detail] _loadDetailData called, routeId:', _detailRouteId, 'map:', !!_detailMap);
  if (!_detailRouteId) {
    _renderStopsError('Route details not available for this line.');
    return;
  }

  try {
    // ── Phase 1: Shape from TransitStore ──────────────────────────────────────
    await _phase1LoadShape();
  } catch (e) {
    console.error('[detail] Phase 1 failed:', e);
    _renderStopsError('Could not load route shape.');
    return;
  }

  // ── Phase 2 & 3: GPS + nearest stop (runs in parallel with vehicle fetch) ─
  const [, vehiclesResult] = await Promise.allSettled([
    _phase2And3GPS().catch(e => console.warn('[detail] Phase 2/3 failed:', e)),
    TransitAPI.fetchVehiclesForRoute(_detailRouteId),
  ]);

  if (vehiclesResult.status === 'fulfilled') {
    _updateVehicleMarkers(vehiclesResult.value);
    if (vehiclesResult.value.length > 0) {
      _detailVehicleInterval = setInterval(async () => {
        try { _updateVehicleMarkers(await TransitAPI.fetchVehiclesForRoute(_detailRouteId)); } catch (e) {}
      }, 20000);
    }
  }

  // ── ETAs ──────────────────────────────────────────────────────────────────
  await _loadNearestStopETAs();
}

async function _phase1LoadShape() {
  const headsign = _detailRouteData.headsign;
  console.log('[detail] phase1 start — routeId:', _detailRouteId, 'headsign:', headsign, 'inStore:', TransitStore.hasRoute(_detailRouteId));

  // Check TransitStore first
  if (TransitStore.hasRoute(_detailRouteId)) {
    // Check for service alerts that would invalidate the cache
    const situations = await TransitAPI.fetchSituationsForRoute(_detailRouteId);
    if (hasActiveShapeAlert(situations)) {
      TransitStore.invalidateRoute(_detailRouteId);
    }
  }

  if (!TransitStore.hasRoute(_detailRouteId)) {
    // Fetch from API and save to store
    try {
      const [stopsJson, shapeJson] = await Promise.allSettled([
        TransitAPI.fetchStopsForRoute(_detailRouteId),
        TransitAPI.fetchShapeForRoute(_detailRouteId),
      ]);
      if (stopsJson.status !== 'fulfilled') throw new Error('stops-for-route failed');

      const shapePoints = (shapeJson.status === 'fulfilled')
        ? (shapeJson.value.data?.entry?.points || null)
        : null;

      const directions = parseRouteDirections(stopsJson.value, shapePoints);
      console.log('[detail] parsed directions:', directions.map(d => ({ name: d.name, stops: d.stopIds.length, polylineLen: d.polyline ? d.polyline.length : 0 })));
      TransitStore.saveRoute(_detailRouteId, { directions });
    } catch (e) {
      console.warn('[detail] shape fetch failed:', e);
      _renderStopsError('Could not load route shape.');
      return;
    }
  }

  // Get the right direction
  _detailDirection = TransitStore.getDirection(_detailRouteId, headsign);
  if (!_detailDirection) { _renderStopsError('No direction data found.'); return; }

  // Check if polyline is bad — if so, fetch from OSRM on-demand
  if (_detailDirection.polyline) {
    const decoded = decodePolyline(_detailDirection.polyline);
    const minPoints = Math.max(10, (_detailDirection.stopIds || []).length * 2);
    console.log('[detail] polyline quality check — decoded:', decoded.length, 'minPoints:', minPoints, 'bad:', decoded.length < minPoints);
    if (decoded.length < minPoints && (_detailDirection.stopIds || []).length >= 3) {
      // Bad polyline — try OSRM
      const stops = (_detailDirection.stopIds || []).map(id => _detailDirection.stops[id]).filter(s => s && s.lat && s.lon);
      if (stops.length >= 2) {
        try {
          const osrmPolyline = await TransitAPI.fetchOSRMShape(stops);
          if (osrmPolyline) {
            _detailDirection.polyline = osrmPolyline;
            // Save back to store for next time
            const entry = TransitStore.getRoute(_detailRouteId);
            if (entry) {
              const dir = entry.directions.find(d => d.name === _detailDirection.name);
              if (dir) { dir.polyline = osrmPolyline; TransitStore.saveRoute(_detailRouteId, { directions: entry.directions }); }
            }
          }
        } catch (e) {}
      }
    }
  }

  // Build stop array for this direction
  _detailAllStops = _detailDirection.stopIds.map((id, idx) => {
    const s = _detailDirection.stops[id] || {};
    return { stopId: id, name: s.name || id, lat: s.lat || 0, lon: s.lon || 0, sequence: idx };
  });

  // Draw base layer (full route, all passed style) and fit bounds
  _drawBaseLayer();
  _renderStopList();
}

async function _phase2And3GPS() {
  // Resolve nearest stop within the CURRENT direction only.
  // User tapped a specific direction — we respect that and find the nearest
  // stop within that direction's stop list.
  const lat = _getUserLat(), lon = _getUserLon();

  if (lat !== null && _detailDirection) {
    const allStops = Object.entries(_detailDirection.stops).map(([id, s]) => ({ stopId: id, ...s }));
    _detailNearestStopId = findNearestStop(lat, lon, allStops);
  }

  if (!_detailNearestStopId) return;

  // Phase 2: overlay upcoming segment
  _drawUpcomingOverlay();
  _renderStopList();

  // Phase 3: zoom to user context
  if (_getUserLat() !== null) {
    _refitToUserContext();
  } else {
    if (typeof AppState !== 'undefined') {
      const _onceGPS = () => {
        if (!_detailOpen) return;
        _updateUserDot();
        _refitToUserContext();
      };
      AppState.onLocationUpdate(_onceGPS);
    }
  }
}

// ===== MAP DRAWING — Layered =====

/**
 * Phase 1: Draw the full route as a base layer in "passed" style.
 * Fits bounds to the full route extent.
 */
function _drawBaseLayer() {
  if (!_detailMap || !_detailDirection) return;

  // Clear any existing layers
  if (_detailBaseLayer) { _detailMap.removeLayer(_detailBaseLayer); _detailBaseLayer = null; }
  if (_detailUpcomingLayer) { _detailMap.removeLayer(_detailUpcomingLayer); _detailUpcomingLayer = null; }
  _detailStopMarkers.forEach(m => _detailMap.removeLayer(m));
  _detailStopMarkers = [];

  const polyline = _detailDirection.polyline;
  const { base: baseColor, upcoming: upcomingColor } = _getRouteColors();
  console.log('[map] drawBaseLayer — direction:', _detailDirection.name, 'polyline length:', polyline ? polyline.length : 0, 'stops:', _detailAllStops.length);
  // Use polyline if available, decodable, and has enough points to be meaningful
  if (polyline) {
    const coords = decodePolyline(polyline);
    // A good polyline should have at least 2 points per stop — otherwise it's partial/bad data
    const minPoints = Math.max(10, _detailAllStops.length * 2);
    if (coords.length >= minPoints) {
      // Verify polyline is in the right area by checking if it overlaps with stop bounds
      const stopLats = _detailAllStops.filter(s => s.lat !== 0).map(s => s.lat);
      const stopLons = _detailAllStops.filter(s => s.lon !== 0).map(s => s.lon);
      if (stopLats.length > 0) {
        const minLat = Math.min(...stopLats) - 0.05;
        const maxLat = Math.max(...stopLats) + 0.05;
        const minLon = Math.min(...stopLons) - 0.05;
        const maxLon = Math.max(...stopLons) + 0.05;
        const polylineInArea = coords.some(([lat, lon]) =>
          lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon
        );
        if (polylineInArea) {
          _detailBaseLayer = L.polyline(coords, {
            color: baseColor, weight: 12, opacity: 1
          }).addTo(_detailMap);
        }
      } else {
        _detailBaseLayer = L.polyline(coords, {
          color: baseColor, weight: 12, opacity: 1
        }).addTo(_detailMap);
      }
    }
  }
  // Always draw straight-line fallback if no polyline layer was created
  if (!_detailBaseLayer && _detailAllStops.length > 1) {
    const coords = _detailAllStops.filter(s => s.lat !== 0 || s.lon !== 0).map(s => [s.lat, s.lon]);
    if (coords.length > 1) {
      _detailBaseLayer = L.polyline(coords, {
        color: baseColor, weight: 12, opacity: 1
      }).addTo(_detailMap);
    }
  }

  // Draw all stops as small white dots inside the line
  _detailAllStops.forEach(stop => {
    if (!stop.lat && !stop.lon) return;
    const m = L.circleMarker([stop.lat, stop.lon], {
      radius: 3, color: baseColor, fillColor: '#ffffff', fillOpacity: 1, weight: 0,
    }).addTo(_detailMap);
    m.bindPopup(`<b>${stop.name}</b>`);
    _detailStopMarkers.push(m);
  });

  // Fit bounds to full route only if GPS is NOT yet available.
  // If GPS is available, Phase 3 will handle the zoom — skip Phase 1 fitBounds
  // to avoid the jarring double-zoom transition.
  const hasGPS = _getUserLat() !== null;
  if (!hasGPS) {
    const validStops = _detailAllStops.filter(s => s.lat !== 0 || s.lon !== 0);
    if (validStops.length > 1) {
      const sheetH = _sheetCurrentH || Math.round(window.innerHeight * 0.45);
      setTimeout(() => {
        if (!_detailMap) return;
        _detailMap.invalidateSize({ animate: false });
        _detailMap.fitBounds(
          L.latLngBounds(validStops.map(s => [s.lat, s.lon])),
          { paddingTopLeft: [30, 160], paddingBottomRight: [80, sheetH + 20], maxZoom: 14 }
        );
      }, 50);
    }
  }
}

/**
 * Phase 2: Overlay the upcoming segment on top of the base layer.
 * Redraws stop dots with passed/current/upcoming distinction.
 */
function _drawUpcomingOverlay() {
  if (!_detailMap || !_detailDirection || !_detailNearestStopId) return;

  const nearestIdx = _detailAllStops.findIndex(s => s.stopId === _detailNearestStopId);
  console.log('[map] drawUpcomingOverlay — nearestStopId:', _detailNearestStopId, 'nearestIdx:', nearestIdx, 'allStops count:', _detailAllStops.length);
  if (nearestIdx < 0) return;

  // Remove old upcoming layer
  if (_detailUpcomingLayer) { _detailMap.removeLayer(_detailUpcomingLayer); _detailUpcomingLayer = null; }

  // Draw upcoming polyline segment on top of base
  const polyline = _detailDirection.polyline;
  const { base: baseColor, upcoming: upcomingColor } = _getRouteColors();
  if (polyline) {
    const allCoords = decodePolyline(polyline);
    if (allCoords.length > 1) {
      const nearestStop = _detailAllStops[nearestIdx];
      const splitIdx = findSplitIndex(allCoords, nearestStop.lat, nearestStop.lon);
      const upcomingCoords = allCoords.slice(splitIdx);
      if (upcomingCoords.length > 1) {
        _detailUpcomingLayer = L.polyline(upcomingCoords, {
          color: upcomingColor, weight: 12, opacity: 1
        }).addTo(_detailMap);
      }
    }
  }
  // Fallback: straight lines for upcoming stops if no polyline layer was created
  if (!_detailUpcomingLayer) {
    const upcomingCoords = _detailAllStops.slice(nearestIdx)
      .filter(s => s.lat || s.lon).map(s => [s.lat, s.lon]);
    if (upcomingCoords.length > 1) {
      _detailUpcomingLayer = L.polyline(upcomingCoords, {
        color: upcomingColor, weight: 12, opacity: 1
      }).addTo(_detailMap);
    }
  }

  // Redraw stop dots with correct styles
  _detailStopMarkers.forEach(m => _detailMap.removeLayer(m));
  _detailStopMarkers = [];

  _detailAllStops.forEach((stop, idx) => {
    if (!stop.lat && !stop.lon) return;
    const isPassed  = idx < nearestIdx;
    const isCurrent = stop.stopId === _detailNearestStopId;

    let fillColor, strokeColor, radius, strokeWeight;
    if (isCurrent) {
      // Current stop: white fill with colored ring — stands out
      fillColor = '#ffffff'; strokeColor = upcomingColor; radius = 5; strokeWeight = 3;
    } else if (isPassed) {
      // Passed: small white dot inside the line
      fillColor = '#ffffff'; strokeColor = baseColor; radius = 3; strokeWeight = 0;
    } else {
      // Upcoming: small white dot inside the line
      fillColor = '#ffffff'; strokeColor = upcomingColor; radius = 3; strokeWeight = 0;
    }

    const m = L.circleMarker([stop.lat, stop.lon], {
      radius, color: strokeColor, fillColor, fillOpacity: 1, weight: strokeWeight,
    }).addTo(_detailMap);
    m.bindPopup(`<b>${stop.name}</b>`);
    _detailStopMarkers.push(m);
  });
}

/**
 * Phase 3 — v2: Center Focus Grid Method
 *
 * Principle:
 *   - Start from zoomed-out view (Phase 1 shows full route)
 *   - Zoom IN to show GPS + nearest + 4 upcoming stops
 *   - Then try to zoom in MORE while GPS+nearest still fit in one quadrant
 *   - Pan to position GPS+nearest into the best quadrant
 *
 * A quadrant = 1/4 viewport width × 1/4 viewport height (center 50% divided into 4)
 */
function _refitToUserContext() {
  if (!_detailMap || !_detailNearestStopId) return;

  const lat = _getUserLat(), lon = _getUserLon();
  if (lat === null) return;

  // Draw the GPS dot
  _updateUserDot();

  const nearestIdx = _detailAllStops.findIndex(s => s.stopId === _detailNearestStopId);
  const nearestStop = _detailAllStops.find(s => s.stopId === _detailNearestStopId);
  if (!nearestStop) return;

  // Get 4 upcoming stops (after nearest)
  const upcomingStops = nearestIdx >= 0
    ? _detailAllStops.slice(nearestIdx + 1, nearestIdx + 5).filter(s => s.lat !== 0 || s.lon !== 0)
    : _detailAllStops.slice(0, 4).filter(s => s.lat !== 0 || s.lon !== 0);

  console.log('[map] v2 refitToUserContext — nearestIdx:', nearestIdx, 'upcomingStops:', upcomingStops.length);

  setTimeout(() => {
    if (!_detailMap) return;

    // fitBounds to show GPS + nearest + 4 upcoming (baseline zoom)
    const allPoints = [[lat, lon], [nearestStop.lat, nearestStop.lon], ...upcomingStops.map(s => [s.lat, s.lon])];
    const mapSize = _detailMap.getSize();
    const padX = Math.round(mapSize.x * 0.12);
    const padY = Math.round(mapSize.y * 0.12);
    _detailMap.fitBounds(L.latLngBounds(allPoints), {
      maxZoom: 16,
      animate: true,
      paddingTopLeft: [padX, padY],
      paddingBottomRight: [padX, padY]
    });

    // After fitBounds settles, try to zoom in more + pan into quadrant
    setTimeout(() => {
      if (!_detailMap) return;
      _zoomInToQuadrant(lat, lon, nearestStop, upcomingStops);
      _detailLocCentered = true;
      _showLocateButton(false);
    }, 200);

  }, 400);
}

/**
 * Try to zoom in further while maintaining:
 *   1. GPS + nearest stop fit in one quadrant (1/4 of viewport)
 *   2. At least 4 upcoming stops remain visible in the viewport
 *
 * Then pan to position GPS+nearest into the best quadrant.
 */
function _zoomInToQuadrant(userLat, userLon, nearestStop, upcomingStops) {
  if (!_detailMap) return;

  const mapSize = _detailMap.getSize();
  const mapW = mapSize.x, mapH = mapSize.y;
  const quadW = mapW * 0.25;
  const quadH = mapH * 0.25;

  function toPixel(lat, lon) {
    return _detailMap.latLngToContainerPoint(L.latLng(lat, lon));
  }

  function countVisibleUpcoming() {
    let count = 0;
    for (const s of upcomingStops) {
      const px = toPixel(s.lat, s.lon);
      if (px.x >= 0 && px.x <= mapW && px.y >= 0 && px.y <= mapH) count++;
    }
    return count;
  }

  function gpsAndStopFitInQuadrant() {
    const gpsPx = toPixel(userLat, userLon);
    const stopPx = toPixel(nearestStop.lat, nearestStop.lon);
    const dx = Math.abs(gpsPx.x - stopPx.x);
    const dy = Math.abs(gpsPx.y - stopPx.y);
    return dx <= quadW && dy <= quadH;
  }

  // Try zooming in one level at a time (max 3 attempts)
  for (let i = 0; i < 3; i++) {
    if (!gpsAndStopFitInQuadrant() || countVisibleUpcoming() < 4) break;
    if (_detailMap.getZoom() >= 16) break;

    // Try one more zoom in
    const midLat = (userLat + nearestStop.lat) / 2;
    const midLon = (userLon + nearestStop.lon) / 2;
    _detailMap.setView([midLat, midLon], _detailMap.getZoom() + 1, { animate: false });

    // Check if we broke constraints
    if (!gpsAndStopFitInQuadrant() || countVisibleUpcoming() < 4) {
      _detailMap.setView([midLat, midLon], _detailMap.getZoom() - 1, { animate: false });
      break;
    }
  }

  // Pan to position GPS+nearest into the best quadrant
  _panToQuadrant(userLat, userLon, nearestStop);
}

/**
 * Pan the map so that GPS+nearest stop midpoint is positioned in one of the 4 quadrants
 * of the center focus area.
 */
function _panToQuadrant(userLat, userLon, nearestStop) {
  if (!_detailMap) return;

  const mapSize = _detailMap.getSize();
  const mapW = mapSize.x, mapH = mapSize.y;

  function toPixel(lat, lon) {
    return _detailMap.latLngToContainerPoint(L.latLng(lat, lon));
  }

  const gpsPx = toPixel(userLat, userLon);
  const stopPx = toPixel(nearestStop.lat, nearestStop.lon);
  const midPx = { x: (gpsPx.x + stopPx.x) / 2, y: (gpsPx.y + stopPx.y) / 2 };

  // Quadrant centers (center of each quarter of the center 50% area)
  const quadCenters = [
    { x: mapW * 0.375, y: mapH * 0.375 }, // Q1 top-left
    { x: mapW * 0.625, y: mapH * 0.375 }, // Q2 top-right
    { x: mapW * 0.375, y: mapH * 0.625 }, // Q3 bottom-left
    { x: mapW * 0.625, y: mapH * 0.625 }, // Q4 bottom-right
  ];

  // Find nearest quadrant center
  let bestQ = quadCenters[0], bestDist = Infinity;
  for (const qc of quadCenters) {
    const d = Math.hypot(midPx.x - qc.x, midPx.y - qc.y);
    if (d < bestDist) { bestDist = d; bestQ = qc; }
  }

  // Pan to move midpoint toward best quadrant center
  const dx = midPx.x - bestQ.x;
  const dy = midPx.y - bestQ.y;

  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
    _detailMap.panBy([dx, dy], { animate: true, duration: 0.3 });
  }
}

async function _loadNearestStopETAs() {
  const labelEl = document.getElementById('detail-etas-label');
  const pillsEl = document.getElementById('detail-etas-pills');
  if (!labelEl || !pillsEl) return;

  const nearestStop = _detailAllStops.find(s => s.stopId === _detailNearestStopId);
  const stopName = nearestStop ? nearestStop.name : (_detailNearestStopId || 'nearby stop');
  const dirName = _detailDirection ? _detailDirection.name : (_detailRouteData ? _detailRouteData.headsign : '');
  labelEl.textContent = dirName || 'Loading…';
  const stopLabel = document.getElementById('detail-stop-label');
  if (stopLabel) stopLabel.textContent = `Next from ${stopName}`;

  // 1. Try LiveCache (already fetched by home.js)
  if (typeof LiveCache !== 'undefined') {
    const etas = LiveCache.getETAs(_detailRouteId, _detailRouteData.headsign);
    if (etas.length) {
      pillsEl.innerHTML = etas.map((eta, i) => renderPill(eta, i)).join('');
      return;
    }
  }

  // 2. Try TransitStore schedule for nearest stop
  if (_detailNearestStopId && _detailDirection) {
    const times = TransitStore.getScheduleForStop(_detailRouteId, _detailDirection.name, _detailNearestStopId);
    const now = Date.now();
    const upcoming = times.filter(t => t > now).slice(0, 3);
    if (upcoming.length) {
      pillsEl.innerHTML = upcoming.map((ms, i) => renderPill({ ms, live: false }, i)).join('');
      // Still fetch live in background
      _fetchLiveETAs();
      return;
    }
  }

  // 3. Fetch live from API
  if (!_detailNearestStopId) { labelEl.textContent = 'No nearby stop found'; return; }
  await _fetchLiveETAs();
}

async function _fetchLiveETAs() {
  const pillsEl = document.getElementById('detail-etas-pills');
  if (!pillsEl || !_detailNearestStopId) return;
  // Validate stop ID format before fetching (prevents ERR_ADDRESS_INVALID)
  if (typeof _detailNearestStopId !== 'string' || !_detailNearestStopId.includes('_')) return;
  try {
    const j = await TransitAPI.fetchArrivalsForStop(_detailNearestStopId);
    const now = Date.now();
    const arrivals = (j.data.entry.arrivalsAndDepartures || [])
      .filter(a => a.routeId === _detailRouteId)
      .map(a => ({ ms: a.predictedDepartureTime || a.scheduledDepartureTime || 0, live: !!(a.predictedDepartureTime) }))
      .filter(a => a.ms > now - 30000)
      .sort((a, b) => a.ms - b.ms)
      .slice(0, 3);
    if (!arrivals.length) {
      pillsEl.innerHTML = '<span style="color:var(--dim);font-size:13px">No upcoming departures</span>';
      return;
    }
    pillsEl.innerHTML = arrivals.map((eta, i) => renderPill(eta, i)).join('');
  } catch (e) {
    const labelEl = document.getElementById('detail-etas-label');
    if (labelEl) labelEl.textContent = 'Could not load departures';
  }
}

function _refitMapToSheet() {
  if (!_detailMap) return;
  _updateMapHeight();
  _detailMap.invalidateSize({ animate: false });
  // Leaflet keeps the center stable after invalidateSize — no panning needed
}

function _updateMapHeight() {
  const mapEl = document.getElementById('detail-map');
  if (!mapEl) return;
  const vh = (typeof AppState !== 'undefined') ? AppState.screenH : window.innerHeight;
  const sheetH = _sheetCurrentH || Math.round(vh * 0.45);
  const mapH = vh - sheetH;
  mapEl.style.height = Math.max(mapH, 100) + 'px';
}

function _renderStopList() {
  const section = document.getElementById('detail-stops-section');
  if (!section) return;

  // Set route-specific colors as CSS custom properties
  const g = _detailRouteData;
  if (g) {
    const TONES = {
      "#3DAE2B": { card: "#DAF4D6", dot: "#22C55E" },
      "#00A0DF": { card: "#CCF0FE", dot: "#0080b2" },
      "#FDB71A": { card: "#ffefcd", dot: "#dfa117" },
      "#9C182F": { card: "#e9ccd1", dot: "#891428" },
      "#2B376E": { card: "#cdd2ee", dot: "#263061" },
      "#E5007D": { card: "#f9c7e2", dot: "#ca006e" },
      "#F47836": { card: "#fbe0ce", dot: "#d1651d" },
      "#666672": { card: "#dddde0", dot: "#5a5a65" },
      "#F24C21": { card: "#fbe0ce", dot: "#b25619" },
      "#006CFF": { card: "#c7dfff", dot: "#005fe0" },
      "#0070C0": { card: "#c7dfff", dot: "#005fe0" },
    };
    const tone = TONES[g.color] || { card: '#DAF4D6', dot: g.color || '#22C55E' };
    section.style.setProperty('--stop-dot-color', tone.dot);
    section.style.setProperty('--stop-line-upcoming', tone.card);
    section.style.setProperty('--stop-line-passed', '#E2E8F0');
  }

  const nearestIdx = _detailAllStops.findIndex(s => s.stopId === _detailNearestStopId);

  _detailAllStops.forEach((s, i) => {
    s.isPassed = nearestIdx >= 0 && i < nearestIdx;
    s.isCurrentStop = s.stopId === _detailNearestStopId;
  });

  const passedStops = nearestIdx > 0 ? _detailAllStops.slice(0, nearestIdx) : [];
  const currentAndAhead = nearestIdx >= 0 ? _detailAllStops.slice(nearestIdx) : _detailAllStops;

  let html = '';

  if (passedStops.length > 0) {
    html += `<div class="stop-row stop-row--passed">
      <div class="stop-spine">
        <div class="stop-line stop-line--hidden"></div>
        <div class="stop-dot stop-dot--passed"></div>
        <div class="stop-line" style="background:var(--stop-line-passed, #E2E8F0)"></div>
      </div>
      <div class="stop-content">
        <button class="detail-show-passed" id="detail-show-passed-btn" onclick="_togglePassedStops()">
          ↑ Show ${passedStops.length} passed stop${passedStops.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>`;
    html += `<div id="detail-passed-stops" style="display:none">`;
    passedStops.forEach((stop, i) => {
      html += _renderStopRow(stop, i, passedStops.length, 'passed');
    });
    html += `</div>`;
  }

  currentAndAhead.forEach((stop, i) => {
    html += _renderStopRow(stop, i, currentAndAhead.length, stop.isCurrentStop ? 'current' : 'upcoming');
  });

  section.innerHTML = html;
}

/**
 * Render a single stop row.
 * Structure is designed for future expansion:
 * - stop-spine: dot + connector lines (upstream/downstream)
 * - stop-content: name, [future: time, transfers]
 *
 * @param {Object} stop - stop data object
 * @param {number} idx - index within its group (passed/upcoming)
 * @param {number} total - total in group
 * @param {string} state - 'passed' | 'current' | 'upcoming'
 */
function _renderStopRow(stop, idx, total, state) {
  const isFirst = idx === 0;
  const isLast = idx === total - 1;

  return `<div class="stop-row stop-row--${state}" data-stop-id="${stop.stopId}" data-sequence="${stop.sequence}">
    <div class="stop-spine">
      <div class="stop-line stop-line--upstream${isFirst ? ' stop-line--hidden' : ''}"></div>
      <div class="stop-dot stop-dot--${state}"></div>
      <div class="stop-line stop-line--downstream${isLast ? ' stop-line--hidden' : ''}"></div>
    </div>
    <div class="stop-content">
      <div class="stop-name">${stop.name}${state === 'current' ? ' <span class="stop-you">← you</span>' : ''}</div>
      <!-- Phase 2: <div class="stop-time"></div> -->
      <!-- Phase 3: <div class="stop-transfers"></div> -->
    </div>
  </div>`;
}

function _renderStopsError(msg) {
  const section = document.getElementById('detail-stops-section');
  if (section) section.innerHTML = `<div class="detail-loading" style="color:var(--danger)">${msg}</div>`;
}
function _togglePassedStops() {
  _detailPassedVisible = !_detailPassedVisible;
  const container = document.getElementById('detail-passed-stops');
  const btn = document.getElementById('detail-show-passed-btn');
  if (!container || !btn) return;

  const passedCount = _detailAllStops.filter(s => s.isPassed).length;
  if (_detailPassedVisible) {
    container.style.display = 'block';
    btn.textContent = `↓ Hide passed stops`;
  } else {
    container.style.display = 'none';
    btn.textContent = `↑ Show ${passedCount} passed stop${passedCount > 1 ? 's' : ''}`;
  }
}
