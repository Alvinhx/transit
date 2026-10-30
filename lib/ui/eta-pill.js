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

  /** Card size — the 80px .pill family (verbatim card-render.renderPill). */
  function _card(eta, idx) {
    const mins = Math.round((eta.ms - Date.now()) / 60000);
    if (mins < -1) return '';
    if (mins <= 0 && eta.live) return `<div class="pill now"><span class="pill-num">NOW</span></div>`;
    if (mins <= 0 && !eta.live) return `<div class="pill sched"><span class="pill-num">0</span><span class="pill-min">min</span></div>`;
    const urgClass = eta.live ? (idx === 0 ? 'live-near' : 'live-far') : 'sched';
    const liveIcon = eta.live ? _liveIcon() : '';
    return `<div class="pill ${urgClass}">${liveIcon}<span class="pill-num">${mins}</span><span class="pill-min">min</span></div>`;
  }

  /** Detail size — the 44px .dp-pill family (verbatim detail.js._renderPill). */
  function _detail(eta) {
    const min = Math.max(0, Math.round((eta.ms - Date.now()) / 60000));
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
    return g.size === 'detail' ? _detail(g.eta) : _card(g.eta, g.idx || 0);
  }

  /** The card's "no departures known yet" ··· pill (card size only; the detail
   *  sheet shows a text message instead, so there's no detail equivalent). */
  function emptyDots() {
    return `<div class="pill sched"><span class="pill-num" style="font-size:18px;color:var(--dim)">···</span></div>`;
  }

  return { html, emptyDots };
})();
