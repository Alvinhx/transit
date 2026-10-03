/**
 * map-sheet-template.js — Map + Sheet page template (v2.1)
 *
 * A reusable full-viewport page: a FIXED full-screen map layer with floating
 * controls, and a draggable bottom sheet that OVERLAYS the map (never resizes
 * it). See context.md → "V2.1 — Fixed Map, Upper-2/3 Focus Grid".
 *
 * Layers (z-index):
 *   z0  Map layer     — full width/height, fixed. Rendered ONCE, never resized.
 *   z1  Controls      — floating buttons over the map (close/locate/zoom…).
 *   z2  Bottom sheet  — overlay, initial ~1/2 height, draggable up/down.
 *
 * KEY INVARIANT: the map is frozen after the consumer frames it. Dragging or
 * scrolling the sheet NEVER pans/zooms/resizes the map. The template therefore
 * needs NO sheet-height hook into the map — the consumer's mapController owns
 * map behavior and is called exactly once (on ready), not on sheet changes.
 *
 * Consumers: detail page (now), future home "nearby" view.
 *
 * Usage:
 *   const page = createMapSheetPage({
 *     id: 'detail-page',
 *     topOverlay: node|html,          // floating chrome over the map
 *     sheetHeader: node|html,         // persistent sheet header (ETAs row)
 *     sheetBody: node|html,           // scrollable sheet content (stop list)
 *     sheet: { snaps: [0.3,0.5,0.9], initial: 0.5, draggable: true },
 *     mapController: {                // consumer-owned; template calls onReady once
 *       onReady(mapEl) {},            // build Leaflet map into mapEl (fixed size)
 *       onDestroy() {},               // teardown (remove map, clear intervals, offLocationUpdate)
 *     },
 *   });
 *   page.mount(document.body);
 *   // later: page.unmount();  → animates out, calls mapController.onDestroy()
 */

const MapSheetTemplate = (function () {
  'use strict';

  function _asNode(content) {
    if (content == null) return document.createDocumentFragment();
    if (content instanceof Node) return content;
    const wrap = document.createElement('div');
    wrap.innerHTML = String(content);
    return wrap.childNodes.length === 1 ? wrap.firstChild : wrap;
  }

  function _screenH() {
    return (typeof AppState !== 'undefined') ? AppState.screenH : window.innerHeight;
  }
  function _screenW() {
    return (typeof AppState !== 'undefined') ? AppState.screenW : window.innerWidth;
  }

  function createMapSheetPage(opts) {
    opts = opts || {};
    const sheetCfg = Object.assign({ snaps: [0.3, 0.5, 0.9], initial: 0.5, draggable: true }, opts.sheet || {});
    const mapController = opts.mapController || {};

    let _mounted = false;
    let _destroyed = false;
    let _currentSnap = sheetCfg.initial;

    // ── Build DOM ────────────────────────────────────────────────────────────
    const root = document.createElement('div');
    root.id = opts.id || 'map-sheet-page';
    root.className = 'ms-page';

    // z0 — map layer, fixed full viewport
    const mapEl = document.createElement('div');
    mapEl.className = 'ms-map';
    mapEl.id = (opts.id || 'map-sheet') + '-map';
    // Explicit pixel size at creation so Leaflet knows its canvas immediately
    // (prevents zero-height / invisible-polyline on first open). Full viewport.
    mapEl.style.width = _screenW() + 'px';
    mapEl.style.height = _screenH() + 'px';
    root.appendChild(mapEl);

    // z1 — controls overlay
    const overlay = document.createElement('div');
    overlay.className = 'ms-overlay';
    overlay.appendChild(_asNode(opts.topOverlay));
    root.appendChild(overlay);

    // z2 — bottom sheet
    const sheet = document.createElement('div');
    sheet.className = 'ms-sheet';
    sheet.id = (opts.id || 'map-sheet') + '-sheet';

    const handle = document.createElement('div');
    handle.className = 'ms-sheet-handle';
    sheet.appendChild(handle);

    const header = document.createElement('div');
    header.className = 'ms-sheet-header';
    header.appendChild(_asNode(opts.sheetHeader));
    sheet.appendChild(header);

    const body = document.createElement('div');
    body.className = 'ms-sheet-body';
    body.appendChild(_asNode(opts.sheetBody));
    sheet.appendChild(body);

    root.appendChild(sheet);

    // ── Sheet sizing / snapping ───────────────────────────────────────────────
    function _applySnap(fraction, animate) {
      _currentSnap = Math.max(0.08, Math.min(0.95, fraction));
      const h = Math.round(_screenH() * _currentSnap);
      sheet.style.transition = animate ? 'height 0.25s ease' : 'none';
      sheet.style.height = h + 'px';
      // IMPORTANT: do NOT touch the map here. Map is frozen after framing.
    }

    function _nearestSnap(fraction) {
      let best = sheetCfg.snaps[0], bestD = Infinity;
      for (const s of sheetCfg.snaps) {
        const d = Math.abs(s - fraction);
        if (d < bestD) { bestD = d; best = s; }
      }
      return best;
    }

    // ── Drag handling (sheet only — never affects the map) ─────────────────────
    function _initDrag() {
      if (!sheetCfg.draggable) return;
      let startY = 0, startH = 0, dragging = false;

      function down(clientY) {
        dragging = true;
        startY = clientY;
        startH = sheet.getBoundingClientRect().height;
        sheet.style.transition = 'none';
      }
      function move(clientY) {
        if (!dragging) return;
        const dy = startY - clientY;           // up = taller
        const h = Math.max(0.08 * _screenH(), Math.min(0.95 * _screenH(), startH + dy));
        sheet.style.height = h + 'px';
      }
      function up() {
        if (!dragging) return;
        dragging = false;
        const frac = sheet.getBoundingClientRect().height / _screenH();
        _applySnap(_nearestSnap(frac), true);
      }

      // Touch
      handle.addEventListener('touchstart', e => { down(e.touches[0].clientY); }, { passive: true });
      handle.addEventListener('touchmove', e => { move(e.touches[0].clientY); }, { passive: true });
      handle.addEventListener('touchend', up);
      handle.addEventListener('touchcancel', up);
      // Mouse (desktop)
      handle.addEventListener('mousedown', e => { down(e.clientY); e.preventDefault(); });
      window.addEventListener('mousemove', e => move(e.clientY));
      window.addEventListener('mouseup', up);
    }

    // ── Public page API ─────────────────────────────────────────────────────
    function mount(parent) {
      if (_mounted) return api;
      _mounted = true;
      (parent || document.body).appendChild(root);
      _applySnap(sheetCfg.initial, false);
      _initDrag();
      requestAnimationFrame(() => root.classList.add('ms-open'));
      // Hand the map element to the consumer — ONE time. The consumer builds the
      // Leaflet map at the fixed full-viewport size and frames it (phases 0–3).
      // 100ms lets layout settle (matches Main's setTimeout(_initDetailMap,100)).
      setTimeout(() => {
        if (_destroyed) return;
        if (typeof mapController.onReady === 'function') mapController.onReady(mapEl);
      }, 100);
      return api;
    }

    function unmount() {
      if (_destroyed) return;
      _destroyed = true;
      if (typeof mapController.onDestroy === 'function') {
        try { mapController.onDestroy(); } catch (e) {}
      }
      root.classList.remove('ms-open');
      root.style.pointerEvents = 'none';
      setTimeout(() => { if (root.parentNode) root.remove(); }, 300);
    }

    /**
     * Show/hide WITHOUT unmounting — used when toggling between root views, so
     * the map keeps its position/zoom and the page doesn't pay a rebuild.
     *
     * NOTE the invalidateSize on show: Leaflet can mis-render tiles for a map
     * that was display:none while the browser reflowed. The map element has an
     * explicit pixel size here so the dimensions don't actually change, but
     * telling Leaflet to re-check is cheap insurance against blank tiles.
     */
    function setVisible(v) {
      root.style.display = v ? '' : 'none';
      if (v && typeof mapController.onShow === 'function') {
        try { mapController.onShow(mapEl); } catch (e) {}
      }
    }

    const api = {
      root, mapEl, sheet,
      // slot accessors so consumers can update content without rebuilding
      getSheetHeader: () => header,
      getSheetBody: () => body,
      getOverlay: () => overlay,
      // sheet control
      snapTo: (frac) => _applySnap(frac, true),
      getSnap: () => _currentSnap,
      mount, unmount, setVisible,
      isDestroyed: () => _destroyed,
    };
    return api;
  }

  return { createMapSheetPage };
})();
