/**
 * whats-new.js — version-gated "What's New" modal (main-next / v7)
 *
 * Ported from Main-v6's showWhatsNew()/dismissOnboard() (home.js). Shows a modal
 * of release tips once per version bump: it finds the newest RELEASE_NOTES entry
 * strictly newer than the stored `nextup_last_seen_version`, renders it, and
 * records APP_VERSION on dismiss. The storage key is SHARED with v6 on purpose,
 * so a v6 → v7 user sees the v7 note exactly once (and never re-sees v6's).
 *
 * Differences from v6: numeric version compare (v6 used a fragile string compare,
 * so "6.3" > "6.10"), and it's self-contained — builds its own DOM and injects
 * its own CSS using v7 theme tokens, so boot just calls `WhatsNew.show()` after
 * the app mounts. `WhatsNew.show({ force: true })` re-shows it regardless of the
 * stored version (handy for testing).
 *
 * No dependencies.
 */
const WhatsNew = (function () {
  'use strict';
  const APP_VERSION = '7.0';
  const STORAGE_KEY = 'nextup_last_seen_version';
  // Newest first. show() picks the newest note strictly newer than last-seen.
  const RELEASE_NOTES = [
    {
      version: '7.0',
      title: "What's New in NextUp \u2728",
      sub: 'v7 \u2014 a fresh, map-first redesign',
      tips: [
        { icon: '\u{1F5FA}\uFE0F', title: "See what's around you", desc: 'A live map of what\u2019s moving nearby, with a draggable sheet of upcoming departures.' },
        { icon: '\u{1F500}', title: 'Nearby & Station modes', desc: 'Flip between what\u2019s near you now and a specific station\u2019s board with one tap.' },
        { icon: '\u{1F4CD}', title: 'Consistent times', desc: 'Nearby departures are grouped by your closest stop, so the board matches each route\u2019s detail page.' },
        { icon: '\u{1F4CC}', title: 'Pin your routes', desc: 'Long-press any card to keep it pinned at the top.' },
      ],
    },
  ];

  // Numeric, segment-wise version compare: "7.0" vs "6.3.1" -> [7,0] vs [6,3,1].
  // Returns 1 if a>b, -1 if a<b, 0 if equal.
  function _cmp(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  let _injected = false;
  function _injectCss() {
    if (_injected || typeof document === 'undefined') return;
    _injected = true;
    const css = [
      '.wn-backdrop{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--overlay,rgba(0,0,0,0.8));animation:wn-fade .18s ease}',
      '.wn-card{width:100%;max-width:360px;max-height:85vh;overflow:auto;background:var(--card-bg,#161b22);color:var(--text,#e6edf3);border:1px solid var(--border,#21262d);border-radius:18px;padding:24px 22px;box-shadow:0 20px 48px rgba(0,0,0,.4);animation:wn-pop .2s ease}',
      '.wn-title{font-size:22px;font-weight:800;line-height:1.2;margin:0 0 4px}',
      '.wn-sub{font-size:13px;color:var(--dim,#8b949e);margin:0 0 18px}',
      '.wn-tips{display:flex;flex-direction:column;gap:14px;margin-bottom:22px}',
      '.wn-tip{display:flex;gap:12px;align-items:flex-start}',
      '.wn-icon{font-size:22px;line-height:1.3;flex:0 0 auto}',
      '.wn-tip-title{font-size:14px;font-weight:700;margin:0 0 2px}',
      '.wn-tip-desc{font-size:13px;color:var(--dim,#8b949e);line-height:1.4;margin:0}',
      '.wn-btn{width:100%;padding:13px;border:none;border-radius:12px;background:var(--accent,#3B82F6);color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.wn-btn:active{opacity:.85}',
      '@keyframes wn-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes wn-pop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}',
    ].join('\n');
    const el = document.createElement('style');
    el.id = 'wn-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  let _backdrop = null;
  function _dismiss() {
    try { localStorage.setItem(STORAGE_KEY, APP_VERSION); } catch (e) {}
    if (_backdrop && _backdrop.parentNode) _backdrop.parentNode.removeChild(_backdrop);
    _backdrop = null;
  }

  function _esc(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function _render(note) {
    _injectCss();
    const backdrop = document.createElement('div');
    backdrop.className = 'wn-backdrop';
    backdrop.innerHTML =
      '<div class="wn-card" role="dialog" aria-modal="true" aria-label="' + _esc(note.title) + '">' +
        '<div class="wn-title">' + _esc(note.title) + '</div>' +
        '<div class="wn-sub">' + _esc(note.sub) + '</div>' +
        '<div class="wn-tips">' +
          note.tips.map(t =>
            '<div class="wn-tip">' +
              '<div class="wn-icon">' + t.icon + '</div>' +
              '<div><div class="wn-tip-title">' + _esc(t.title) + '</div>' +
              '<div class="wn-tip-desc">' + _esc(t.desc) + '</div></div>' +
            '</div>'
          ).join('') +
        '</div>' +
        '<button class="wn-btn" type="button">Got it</button>' +
      '</div>';
    // Dismiss on the button, or on a backdrop (outside-card) tap.
    backdrop.addEventListener('click', (e) => {
      const isBtn = e.target && e.target.classList && e.target.classList.contains('wn-btn');
      if (e.target === backdrop || isBtn) _dismiss();
    });
    document.body.appendChild(backdrop);
    _backdrop = backdrop;
  }

  /**
   * Show the newest release note the user hasn't seen. No-ops (returns false) if
   * they're already current. Pass { force: true } to always show the latest.
   * @returns {boolean} whether a note was shown.
   */
  function show(opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || !document.body) return false;
    if (_backdrop) return false; // already open
    let lastSeen = '0';
    try { lastSeen = localStorage.getItem(STORAGE_KEY) || '0'; } catch (e) {}
    if (opts.force) lastSeen = '0';
    const note = RELEASE_NOTES.find(n => _cmp(n.version, lastSeen) > 0);
    if (!note) return false;
    _render(note);
    return true;
  }

  return { show, APP_VERSION, _cmp };
})();
