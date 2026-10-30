/**
 * alerts.js — Route service-alert list page (main-next)
 *
 * First consumer of the List page template. Shows all ACTIVE alerts scoped to a
 * route (per the recorded decision: route-based = any routeId in allAffects).
 *
 * The alert objects come from the detail page's LiveFeed snapshot — i.e. from the
 * SAME 20s trips-for-route poll — so opening this page costs no extra request.
 *
 * A future notification center should reuse ListPageTemplate the same way.
 *
 * Depends on globals: ListPageTemplate.
 */

const AlertsPage = (function () {
  'use strict';

  // Map OBA `reason` codes to a friendly label + icon.
  const REASON_META = {
    CONSTRUCTION:    { label: 'Construction', icon: 'construction' },
    MAINTENANCE:     { label: 'Maintenance',  icon: 'build' },
    ACCIDENT:        { label: 'Incident',     icon: 'report' },
    WEATHER:         { label: 'Weather',      icon: 'cloud' },
    POLICE_ACTIVITY: { label: 'Police activity', icon: 'local_police' },
    MEDICAL_EMERGENCY: { label: 'Medical emergency', icon: 'medical_services' },
    TECHNICAL_PROBLEM: { label: 'Technical issue', icon: 'settings' },
    STRIKE:          { label: 'Strike',       icon: 'campaign' },
    DEMONSTRATION:   { label: 'Demonstration', icon: 'campaign' },
    HOLIDAY:         { label: 'Holiday',      icon: 'event' },
    OTHER_CAUSE:     { label: 'Notice',       icon: 'info' },
    UNKNOWN_CAUSE:   { label: 'Notice',       icon: 'info' },
  };

  function _meta(reason) {
    return REASON_META[reason] || { label: 'Notice', icon: 'info' };
  }

  // Severity → accent color for the row icon.
  function _accent(severity) {
    switch ((severity || '').toLowerCase()) {
      case 'severe':
      case 'verysevere': return '#e5484d';
      case 'slight':
      case 'normal':     return '#f5a623';
      default:           return '#4da3ff'; // noImpact / unknown → informational
    }
  }

  function _fmtWindow(win) {
    if (!win || !win.from) return '';
    const f = new Date(win.from);
    const t = win.to ? new Date(win.to) : null;
    const opts = { month: 'short', day: 'numeric' };
    const fs = f.toLocaleDateString(undefined, opts);
    if (!t) return `From ${fs}`;
    const ts = t.toLocaleDateString(undefined, opts);
    return fs === ts ? fs : `${fs} – ${ts}`;
  }

  let _page = null;

  /** Render one alert row. Description collapses behind a "More" toggle. */
  function _renderAlert(alert) {
    const meta = _meta(alert.reason);
    const accent = _accent(alert.severity);

    const row = document.createElement('div');
    row.className = 'al-row';

    const icon = document.createElement('div');
    icon.className = 'al-icon';
    icon.style.background = accent + '22';
    icon.innerHTML = `<span class="material-icons" style="color:${accent}">${meta.icon}</span>`;
    row.appendChild(icon);

    const main = document.createElement('div');
    main.className = 'al-main';

    const summary = document.createElement('div');
    summary.className = 'al-summary';
    summary.textContent = alert.summary || meta.label;
    main.appendChild(summary);

    // Description — collapsed by default (these can be long), expandable.
    if (alert.description) {
      const desc = document.createElement('div');
      desc.className = 'al-desc';
      desc.textContent = alert.description;
      desc.style.display = 'none';
      const toggle = document.createElement('button');
      toggle.className = 'al-toggle';
      toggle.textContent = 'More details';
      toggle.addEventListener('click', () => {
        const open = desc.style.display !== 'none';
        desc.style.display = open ? 'none' : 'block';
        toggle.textContent = open ? 'More details' : 'Less';
      });
      main.appendChild(desc);
      main.appendChild(toggle);
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'al-meta';

    const tag = document.createElement('span');
    tag.className = 'al-tag';
    tag.textContent = meta.label;
    metaRow.appendChild(tag);

    const win = (alert.activeWindows || [])[0];
    const winText = _fmtWindow(win);
    if (winText) {
      const w = document.createElement('span');
      w.className = 'al-tag';
      w.textContent = winText;
      metaRow.appendChild(w);
    }

    // Multi-route alerts (e.g. a system-wide service change) — show the count.
    if ((alert.affectedRouteIds || []).length > 1) {
      const m = document.createElement('span');
      m.className = 'al-tag';
      m.textContent = `${alert.affectedRouteIds.length} routes`;
      metaRow.appendChild(m);
    }

    if (alert.url) {
      const link = document.createElement('a');
      link.className = 'al-link';
      link.href = alert.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Agency info';
      metaRow.appendChild(link);
    }

    main.appendChild(metaRow);
    row.appendChild(main);
    return row;
  }

  /**
   * Open the alert list for a route.
   * @param {Object} o  — { routeLabel, alerts[] }
   */
  function open(o) {
    o = o || {};
    if (_page && !_page.isDestroyed()) close();

    _page = ListPageTemplate.createListPage({
      id: 'alerts',
      title: 'Service alerts',
      subtitle: o.routeLabel || '',
      items: o.alerts || [],
      renderItem: _renderAlert,
      emptyState: 'No active alerts for this route.',
      onBack: () => close(),
      onDestroy: () => { _page = null; },
    });
    _page.mount(document.body);
    return _page;
  }

  /** Push fresh alerts in while the page is open (called on each feed tick). */
  function update(alerts) {
    if (_page && !_page.isDestroyed()) _page.setItems(alerts || []);
  }

  function close() {
    if (_page && !_page.isDestroyed()) _page.unmount();
    _page = null;
  }

  function isOpen() { return !!(_page && !_page.isDestroyed()); }

  return { open, update, close, isOpen };
})();
