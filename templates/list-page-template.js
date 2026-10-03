/**
 * list-page-template.js — List page template
 *
 * The second reusable page template (after Map+Sheet). A full-viewport page with
 * a fixed header (back + title + optional actions) and a scrollable list body.
 *
 * Structure:
 *   Header
 *     ├── back button      (onBack)
 *     ├── title / subtitle (title, subtitle)
 *     └── header actions   (headerActions slot)
 *   List body (scrollable)
 *     ├── section(s)       (optional grouping)
 *     ├── item(s)          (rendered by the consumer's renderItem)
 *     └── empty state      (when there are no items)
 *
 * Consumers: route alert list, the station live board, and a future notification
 * center. The consumer owns how each row LOOKS (renderItem); the template owns
 * the page chrome, scrolling, and mount/unmount lifecycle.
 *
 * ── TWO PAGE KINDS ──────────────────────────────────────────────────────────
 *
 * PUSHED (default) — something you drilled into. Slides in from the right, has a
 * back button, sits above everything at z600. This is the alert list.
 *
 * ROOT (`root: true`) — a top-level destination reached from the mode toggle, not
 * a drill-down. So: no back button (there's nothing to go back to), no slide-in
 * (it isn't arriving from anywhere), and it sits at the page layer, not above it.
 * This is the station board. Pair it with `onTitleTap` to make the title a
 * switcher, and `setVisible()` to swap root views without paying a rebuild or
 * losing scroll position.
 *
 * Row wrapping: by default each item is wrapped in `.lp-item` (padding +
 * divider). Pass `itemClass: ''` to append the consumer's node directly — needed
 * for transit cards, which are self-contained blocks that the divider styling
 * would fight. `bodyClass` adds a class to the scroll body for list layout.
 *
 * Usage:
 *   const page = ListPageTemplate.createListPage({
 *     id: 'alerts',
 *     title: 'Service alerts',
 *     subtitle: 'Route 8 — Seattle Center',
 *     onBack: () => page.unmount(),
 *     items: alerts,
 *     renderItem: (a) => nodeOrHtml,
 *     sections: [ { title: 'Active', items: [...] } ],   // optional, instead of items
 *     emptyState: 'No active alerts for this route.',
 *     headerActions: nodeOrHtml,                          // optional
 *   });
 *   page.mount(document.body);
 *   page.setItems(newAlerts);   // re-render rows without rebuilding the page
 *   page.unmount();
 */

const ListPageTemplate = (function () {
  'use strict';

  function _asNode(content) {
    if (content == null) return document.createDocumentFragment();
    if (content instanceof Node) return content;
    const wrap = document.createElement('div');
    wrap.innerHTML = String(content);
    return wrap.childNodes.length === 1 ? wrap.firstChild : wrap;
  }

  function createListPage(opts) {
    opts = opts || {};
    const renderItem = typeof opts.renderItem === 'function'
      ? opts.renderItem
      : (item) => String(item);

    let _destroyed = false;
    let _mounted = false;

    // ── Build DOM ────────────────────────────────────────────────────────────
    const root = document.createElement('div');
    root.id = opts.id ? (opts.id + '-page') : 'list-page';
    root.className = 'lp-page';

    // Header
    const header = document.createElement('div');
    header.className = 'lp-header';

    // ROOT pages are a tab destination, not something you drilled into, so they
    // have no back affordance and no slide-in (see the `root` note in the header).
    const isRoot = !!opts.root;
    if (isRoot) root.classList.add('lp-root');

    const backBtn = document.createElement('button');
    backBtn.className = 'lp-back';
    backBtn.setAttribute('aria-label', 'Back');
    backBtn.innerHTML = '<span class="material-icons" style="font-size:22px">arrow_back</span>';
    if (!isRoot) header.appendChild(backBtn);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'lp-title-wrap';
    const titleEl = document.createElement('div');
    titleEl.className = 'lp-title';
    titleEl.textContent = opts.title || '';

    // A tappable title (station switcher). Rendered as a real <button> so it's
    // keyboard-reachable and announced as interactive, with a chevron so it
    // doesn't just look like text that happens to respond to taps.
    if (typeof opts.onTitleTap === 'function') {
      const btn = document.createElement('button');
      btn.className = 'lp-title-btn';
      btn.type = 'button';
      btn.appendChild(titleEl);
      const chev = document.createElement('span');
      chev.className = 'material-icons lp-title-chev';
      chev.textContent = 'expand_more';
      btn.appendChild(chev);
      btn.addEventListener('click', () => opts.onTitleTap());
      titleWrap.appendChild(btn);
    } else {
      titleWrap.appendChild(titleEl);
    }
    if (opts.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'lp-subtitle';
      sub.textContent = opts.subtitle;
      titleWrap.appendChild(sub);
    }
    header.appendChild(titleWrap);

    const actions = document.createElement('div');
    actions.className = 'lp-actions';
    actions.appendChild(_asNode(opts.headerActions));
    header.appendChild(actions);

    root.appendChild(header);

    // Scrollable body. `bodyClass` lets a consumer opt into its own list layout
    // (the station board passes 'hm-cards' for the 8px card stack).
    const body = document.createElement('div');
    body.className = 'lp-body' + (opts.bodyClass ? ' ' + opts.bodyClass : '');
    root.appendChild(body);

    // ── Rendering ────────────────────────────────────────────────────────────
    function _renderEmpty() {
      const empty = document.createElement('div');
      empty.className = 'lp-empty';
      empty.appendChild(_asNode(opts.emptyState || 'Nothing here.'));
      return empty;
    }

    /**
     * Wrap each rendered item in a row. `itemClass: ''` (or null) skips the
     * wrapper entirely and appends the consumer's node directly — the station
     * board needs that, because a transit card is already a self-contained block
     * and the default `.lp-item` divider/padding would fight its styling.
     */
    function _renderRows(items) {
      const frag = document.createDocumentFragment();
      const itemClass = ('itemClass' in opts) ? opts.itemClass : 'lp-item';
      for (const item of items) {
        const node = _asNode(renderItem(item));
        if (!itemClass) { frag.appendChild(node); continue; }
        const row = document.createElement('div');
        row.className = itemClass;
        row.appendChild(node);
        frag.appendChild(row);
      }
      return frag;
    }

    function _renderSection(section) {
      const wrap = document.createDocumentFragment();
      if (section.title) {
        const h = document.createElement('div');
        h.className = 'lp-section-title';
        h.textContent = section.title;
        wrap.appendChild(h);
      }
      wrap.appendChild(_renderRows(section.items || []));
      return wrap;
    }

    /** Render from either `sections` or a flat `items` list. */
    function render(data) {
      body.innerHTML = '';
      const sections = (data && data.sections) || opts.sections;
      const items = (data && data.items) || opts.items;

      if (sections && sections.length) {
        const total = sections.reduce((n, s) => n + ((s.items || []).length), 0);
        if (!total) { body.appendChild(_renderEmpty()); return; }
        for (const s of sections) {
          if (!(s.items || []).length) continue;
          body.appendChild(_renderSection(s));
        }
        return;
      }

      if (!items || !items.length) { body.appendChild(_renderEmpty()); return; }
      body.appendChild(_renderRows(items));
    }

    /** Replace the rows (keeps the page mounted). */
    function setItems(items) {
      opts.items = items;
      opts.sections = null;
      render();
    }
    function setSections(sections) {
      opts.sections = sections;
      render();
    }
    function setSubtitle(text) {
      let sub = titleWrap.querySelector('.lp-subtitle');
      if (!sub) {
        sub = document.createElement('div');
        sub.className = 'lp-subtitle';
        titleWrap.appendChild(sub);
      }
      sub.textContent = text || '';
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────
    function mount(parent) {
      if (_mounted) return api;
      _mounted = true;
      render();
      (parent || document.body).appendChild(root);
      // Root pages are already in place (CSS gives .lp-root no transform), so
      // adding the class on the next frame would just cause a needless reflow.
      if (isRoot) root.classList.add('lp-open');
      else requestAnimationFrame(() => root.classList.add('lp-open'));
      return api;
    }

    function unmount() {
      if (_destroyed) return;
      _destroyed = true;
      if (typeof opts.onDestroy === 'function') { try { opts.onDestroy(); } catch (e) {} }
      root.classList.remove('lp-open');
      root.style.pointerEvents = 'none';
      // Root pages don't animate out, so don't wait on a transition that
      // never runs.
      if (isRoot) { if (root.parentNode) root.remove(); return; }
      setTimeout(() => { if (root.parentNode) root.remove(); }, 260);
    }

    /** Show/hide without unmounting — used when toggling between root views so
     *  each keeps its scroll position and doesn't pay a rebuild. */
    function setVisible(v) { root.style.display = v ? '' : 'none'; }

    backBtn.addEventListener('click', () => {
      if (typeof opts.onBack === 'function') opts.onBack();
      else unmount();
    });

    /** Update the header title in place (e.g. after switching station). */
    function setTitle(text) { titleEl.textContent = text || ''; }

    const api = {
      root, header, body,
      render, setItems, setSections, setSubtitle, setTitle,
      getBody: () => body,
      mount, unmount, setVisible,
      isDestroyed: () => _destroyed,
    };
    return api;
  }

  return { createListPage };
})();
