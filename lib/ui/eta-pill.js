/**
 * eta-pill.js — EtaPill atom (main-next design system)
 *
 * One ETA readout in the card/detail "etas" slot. Given one ETA it renders the
 * right pill for the moment:
 *
 * VARIANTS (chosen from the ETA, not passed in):
 *   • now       — live + due now → the neon pulsing "NOW" capsule (no unit, no
 *                 signal icon; the pulse already reads as live)
 *   • live      — live + upcoming → grey pill with the LiveIndicator signal icon
 *   • scheduled — not live (or scheduled-0) → plain grey pill, no icon
 *
 * SIZES (two genuinely different pill families, matched EXACTLY to today):
 *   • card   — the 80px `.pill*` family (default). Live pills carry an urgency
 *              class from their position (idx 0 → live-near, else live-far), and
 *              pills more than a minute stale are dropped (returns "").
 *   • detail — the 44px `.dp-pill*` family. No urgency class, negatives clamp to
 *              0 (nothing is dropped), unit span is `.dp-pill-unit`.
 *
 *   EtaPill.html({ eta:{ ms, live }, idx:0, size:'card' })
 *   EtaPill.emptyDots()   // the card's "no data yet" ··· pill
 *
 * These reproduce card-render's renderPill and detail.js's _renderPill verbatim
 * (same classes, same branching) so the recompose is a pixel no-op. The live
 * icon comes from the shared LiveIndicator primitive (className 'pill-live').
 *
 * MINUTES ROUND DOWN (Alvin, 2026-10-30): a pill shows WHOLE MINUTES REMAINING, so
 * 119 s reads "1 min", never "2". Users should arrive early, not late, and this
 * matches how other transit apps count down. Live + under a minute → NOW.
 * minutesUntil() is the single place this rule lives; transit-card's >90-min
 * test uses it too.
 *
 * TICKING: every pill carries its absolute time in data-eta-* attributes, so
 * EtaPill.refresh(root) can recompute the label with NO new data, and
 * startTicker(5000) does that every 5 s between the 20 s live polls. Only a pill
 * whose label actually changed is replaced (about once a minute each) — cards are
 * never re-rendered, so scrolling / long-press / dragging are unaffected.
 *
 * Owns its CSS in eta-pill.css (the .pill, .pill-live and .next-day-times family
 * moved out of base.css, and the .dp-pill family moved out of main-next.css).
 * The pulse-bg / sig0-2 keyframes it animates stay in base.css (foundation).
 *
 * Depends on: LiveIndicator (lib/ui/live-indicator.js).
 */
const EtaPill = (function () {
  'use strict';

  /** The live-feed signal icon, in the pill-corner wrapper. */
  function _liveIcon() { return LiveIndicator.html({ className: 'pill-live' }); }

  /** Whole minutes remaining until `ms` (rounds DOWN; negative once it has passed). */
  function minutesUntil(ms, now) {
    return Math.floor((ms - (now === undefined ? Date.now() : now)) / 60000);
  }
  /** Card size — the 80px .pill family (verbatim card-render.renderPill, but rounding down). */
  function _card(eta, idx) {
    const mins = minutesUntil(eta.ms);
    if (mins < -1) return '';
    if (mins <= 0 && eta.live) return `<div class="pill now"><span class="pill-num">NOW</span></div>`;
    if (mins <= 0 && !eta.live) return `<div class="pill sched"><span class="pill-num">0</span><span class="pill-min">min</span></div>`;
    const urgClass = eta.live ? (idx === 0 ? 'live-near' : 'live-far') : 'sched';
    const liveIcon = eta.live ? _liveIcon() : '';
    return `<div class="pill ${urgClass}">${liveIcon}<span class="pill-num">${mins}</span><span class="pill-min">min</span></div>`;
  }

  /** Detail size — the 44px .dp-pill family (verbatim detail.js._renderPill). */
  function _detail(eta) {
    const min = Math.max(0, minutesUntil(eta.ms));
    if (min === 0) {
      return eta.live
        ? `<div class="dp-pill now"><span class="dp-pill-num">NOW</span></div>`
        : `<div class="dp-pill sched"><span class="dp-pill-num">0</span><span class="dp-pill-unit">min</span></div>`;
    }
    const live = eta.live ? _liveIcon() : '';
    return `<div class="dp-pill${eta.live ? '' : ' sched'}">${live}<span class="dp-pill-num">${min}</span><span class="dp-pill-unit">min</span></div>`;
  }

  /**
   * @param {object} g { eta:{ms,live}, idx?:number, size?:'card'|'detail' }
   */
  function html(g) {
    g = g || {};
    const size = g.size === 'detail' ? 'detail' : 'card';
    const idx = g.idx || 0;
    const out = size === 'detail' ? _detail(g.eta) : _card(g.eta, idx);
    return _tag(out, g.eta, idx, size);
  }

  // ── ticking ────────────────────────────────────────────────────────────────
  // What the pill currently SHOWS, as a compact signature: size, whole minutes
  // (clamped exactly as _card/_detail clamp them), live flag, urgency position.
  // Two moments with the same signature render identical markup, so refresh()
  // only touches a pill when this changes.
  function _sig(eta, idx, size, now) {
    const m = minutesUntil(eta.ms, now);
    const shown = size === 'detail' ? Math.max(0, m) : (m < -1 ? 'x' : (m <= 0 ? 0 : m));
    return size + '|' + shown + '|' + (eta.live ? 1 : 0) + '|' + idx;
  }
  /** Stamp the pill's root element with what refresh() needs to recompute it. */
  function _tag(out, eta, idx, size) {
    if (!out) return out;
    return out.replace('<div ',
      '<div data-eta-ms="' + Math.round(eta.ms) + '" data-eta-live="' + (eta.live ? 1 : 0) +
      '" data-eta-idx="' + idx + '" data-eta-size="' + size + '" data-eta-sig="' + _sig(eta, idx, size) + '" ');
  }
  /**
   * Recompute every pill under `root` (default: the document) from its stored
   * absolute time. No new data, no network. Replaces only pills whose label
   * changed; a card-size pill that has gone stale (the same drop-rule as html())
   * is removed. Returns how many pills changed.
   */
  function refresh(root) {
    const scope = root || document;
    const now = Date.now();
    let changed = 0;
    scope.querySelectorAll('[data-eta-ms]').forEach(el => {
      const eta = { ms: +el.getAttribute('data-eta-ms'), live: el.getAttribute('data-eta-live') === '1' };
      const idx = +el.getAttribute('data-eta-idx') || 0;
      const size = el.getAttribute('data-eta-size') || 'card';
      if (_sig(eta, idx, size, now) === el.getAttribute('data-eta-sig')) return;
      const fresh = html({ eta, idx, size });
      changed++;
      if (fresh) el.outerHTML = fresh; else el.remove();
    });
    return changed;
  }
  let _ticker = null;
  /** One shared timer for the whole app (default every 5 s; skipped while the tab is hidden). */
  function startTicker(intervalMs) {
    if (_ticker || typeof setInterval === 'undefined') return;
    _ticker = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try { refresh(document); } catch (e) { /* a tick must never break the app */ }
    }, intervalMs || 5000);
  }
  function stopTicker() { if (_ticker) { clearInterval(_ticker); _ticker = null; } }

  /** The card's "no departures known yet" ··· pill (card size only; the detail
   *  sheet shows a text message instead, so there's no detail equivalent). */
  function emptyDots() {
    return `<div class="pill sched"><span class="pill-num" style="font-size:18px;color:var(--dim)">···</span></div>`;
  }

  return { html, emptyDots, minutesUntil, refresh, startTicker, stopTicker };
})();
