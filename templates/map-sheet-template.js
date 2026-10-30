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
    const sheetCfg = Object.assign({ min: 1 / 3, max: 0.95, initial: 0.5, draggable: true }, opts.sheet || {});
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

    // Pull-to-refresh indicator — between header and body; revealed only when
    // pulling down while the sheet sits at its minimum height. Driven by _initDrag.
    const ptr = document.createElement('div');
    ptr.className = 'ms-ptr';
    ptr.innerHTML = '<span class="ms-ptr-spinner material-icons">refresh</span><span class="ms-ptr-text">Pull to refresh</span>';
    sheet.appendChild(ptr);

    const body = document.createElement('div');
    body.className = 'ms-sheet-body';
    body.appendChild(_asNode(opts.sheetBody));
    sheet.appendChild(body);

    root.appendChild(sheet);

    // ── Sheet sizing (free-drag, no snap — clamped between min and max) ────────
    function _applyHeight(fraction, animate) {
      _currentSnap = Math.max(sheetCfg.min, Math.min(sheetCfg.max, fraction));
      const h = Math.round(_screenH() * _currentSnap);
      sheet.style.transition = animate ? 'height 0.25s ease' : 'none';
      sheet.style.height = h + 'px';
      // IMPORTANT: do NOT touch the map here. Map is frozen after framing.
    }
    function _minH() { return _screenH() * sheetCfg.min; }
    function _maxH() { return _screenH() * sheetCfg.max; }

    // ── Staged drag (touch) — ONE gesture flows between three modes, decided at
    //    the start of the gesture from the sheet position, the content scroll
    //    offset, and the drag direction (matches the user's staged model):
    //      'sheet'   — move the sheet (grow when below max / shrink when the
    //                  content is at its top and the sheet is above min). We
    //                  preventDefault so the map/page never scroll or refresh.
    //      'content' — let the body scroll NATIVELY (keeps momentum). No
    //                  preventDefault. Used when the sheet is at max (drag up) or
    //                  the content is mid-scroll (drag down).
    //      'refresh' — only when the sheet is at its MIN and content at top and
    //                  you pull down: a controlled pull-to-refresh (soft; calls
    //                  sheetCfg.onPullRefresh). Native pull-to-refresh is disabled
    //                  via overscroll-behavior so it can't fire anywhere else.
    //    Mode is locked per gesture (so native momentum scrolling stays intact);
    //    crossing stages happens on the next finger motion. The whole sheet is
    //    the drag surface — you don't have to hit the little handle.
    //    Mouse keeps a simple handle-drag (desktop is not the target interface).
    const _DRAG_THRESHOLD = 8;   // px before a touch counts as a drag (taps/long-press pass through)
    const _PTR_TRIGGER = 64;     // px of pull-down past min before a refresh arms
    let _refreshing = false;

    function _setPtr(pull, armed, busy) {
      ptr.style.transition = 'none';
      ptr.style.height = (busy ? 44 : Math.min(Math.round(pull * 0.5), 56)) + 'px';
      ptr.style.opacity = busy ? '1' : String(Math.min(pull / _PTR_TRIGGER, 1));
      ptr.classList.toggle('ms-ptr-armed', !!armed);
      ptr.classList.toggle('ms-ptr-busy', !!busy);
      const txt = ptr.querySelector('.ms-ptr-text');
      if (txt) txt.textContent = busy ? 'Refreshing\u2026' : (armed ? 'Release to refresh' : 'Pull to refresh');
    }
    function _resetPtr(animate) {
      ptr.style.transition = animate ? 'height 0.2s ease, opacity 0.2s ease' : 'none';
      ptr.style.height = '0px';
      ptr.style.opacity = '0';
      ptr.classList.remove('ms-ptr-armed', 'ms-ptr-busy');
    }
    function _triggerRefresh() {
      _refreshing = true;
      _setPtr(0, false, true);
      let p = null;
      try { if (typeof sheetCfg.onPullRefresh === 'function') p = sheetCfg.onPullRefresh(); } catch (e) {}
      Promise.resolve(p).catch(() => {}).finally(() => {
        setTimeout(() => { _resetPtr(true); _refreshing = false; }, 400);
      });
    }

    function _initDrag() {
      if (!sheetCfg.draggable) return;
      let dragging = false, decided = false, mode = null, startY = 0, startH = 0, pull = 0;

      sheet.addEventListener('touchstart', e => {
        if (_refreshing || e.touches.length !== 1) return;
        dragging = true; decided = false; mode = null; pull = 0;
        startY = e.touches[0].clientY;
        startH = sheet.getBoundingClientRect().height;
        sheet.style.transition = 'none';
      }, { passive: true });

      sheet.addEventListener('touchmove', e => {
        if (!dragging) return;
        const y = e.touches[0].clientY;
        const dy = startY - y;                 // finger up = positive
        if (!decided) {
          if (Math.abs(dy) < _DRAG_THRESHOLD) return;   // sub-threshold → let taps / long-press through
          const up = dy > 0;
          const atMax = startH >= _maxH() - 2;
          const atMin = startH <= _minH() + 2;
          const contentTop = body.scrollTop <= 0;
          if (up) mode = atMax ? 'content' : 'sheet';
          else mode = (!contentTop) ? 'content' : (atMin ? 'refresh' : 'sheet');
          decided = true;
        }
        if (mode === 'content') return;        // native scroll owns the gesture (momentum intact)
        if (mode === 'sheet') {
          e.preventDefault();
          _applyHeight((startH + dy) / _screenH(), false);   // clamped to [min,max]
          return;
        }
        if (mode === 'refresh') {
          e.preventDefault();
          pull = Math.max(0, y - startY);
          _setPtr(pull, pull >= _PTR_TRIGGER, false);
          return;
        }
      }, { passive: false });

      function end() {
        if (!dragging) return;
        dragging = false;
        if (mode === 'refresh') {
          if (pull >= _PTR_TRIGGER && !_refreshing) _triggerRefresh();
          else _resetPtr(true);
        }
        mode = null; decided = false;
      }
      sheet.addEventListener('touchend', end);
      sheet.addEventListener('touchcancel', end);

      // Mouse: simple handle-drag to move the sheet (desktop convenience only).
      let mDown = false, mStartY = 0, mStartH = 0;
      handle.addEventListener('mousedown', e => {
        mDown = true; mStartY = e.clientY; mStartH = sheet.getBoundingClientRect().height;
        sheet.style.transition = 'none'; e.preventDefault();
      });
      window.addEventListener('mousemove', e => {
        if (!mDown || _destroyed) return;
        _applyHeight((mStartH + (mStartY - e.clientY)) / _screenH(), false);
      });
      window.addEventListener('mouseup', () => { mDown = false; });
    }

    // ── Public page API ─────────────────────────────────────────────────────
    function mount(parent) {
      if (_mounted) return api;
      _mounted = true;
      (parent || document.body).appendChild(root);
      _applyHeight(sheetCfg.initial, false);
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
      snapTo: (frac) => _applyHeight(frac, true),
      getSnap: () => _currentSnap,
      mount, unmount, setVisible,
      isDestroyed: () => _destroyed,
    };
    return api;
  }

  return { createMapSheetPage };
})();
