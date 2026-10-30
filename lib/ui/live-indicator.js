/**
 * live-indicator.js — the animated "live feed" signal icon (main-next)
 *
 * The pulsing three-arc signal glyph that marks real-time (vs scheduled) data.
 * A standalone primitive so ANY surface shows the same indicator — cards, the
 * detail sheet, a station header, a future "LIVE" chip.
 *
 * ── Shape sharing (why this is cheap) ────────────────────────────────────────
 * The artwork is one ~940-char wave path, drawn 12 times (mask + fill across 3
 * signal states x 2 themes) and identical every time, plus one mask shape reused
 * by all of them. Inlining all of that per icon cost ~13KB EACH — a board with a
 * dozen live pills carried a dozen copies.
 *
 * Now the heavy path and the mask live ONCE in a document-level <defs> (`#li-defs`,
 * injected on demand), and every instance is just six tiny <svg>s that <use> them:
 *   <g mask="url(#li-mask)"><use href="#li-wave" fill="…"/><circle …/></g>
 * Each instance is ~0.8KB instead of ~13KB, and the shared block is ~1KB total.
 *
 * ── The green-wedge bug is now structurally impossible ───────────────────────
 * The earlier bug was duplicate mask ids across simultaneously-mounted views:
 * `url(#id)` resolves to the first match in document order, so an icon could
 * reference a mask inside a hidden (display:none) subtree and render unmasked.
 * The old fix was a unique-id-per-instance counter. With a single shared mask
 * there is exactly ONE mask id in the whole document, referenced by everyone —
 * so there is nothing to collide and no counter to maintain.
 *
 * USAGE
 *   LiveIndicator.html()                      // default 14px, inline
 *   LiveIndicator.html({ size: 20 })          // any size, via --li-size
 *   LiveIndicator.html({ className: 'pill-live' })  // legacy pill-corner wrapper
 *   LiveIndicator.html({ title: 'Live' })     // announced; else aria-hidden
 *   LiveIndicator.svg()                       // just the six <svg> layers
 *
 * The shared <defs> auto-injects the first time html()/svg() runs (and on module
 * load when a document exists); it's idempotent and re-adds itself if removed.
 * In a non-DOM context (node without jsdom) injection is a safe no-op — the
 * returned markup still references #li-mask / #li-wave, you just need the defs in
 * whatever document ultimately renders it. Call ensureDefs(doc) to force it.
 *
 * THEMING: dark/light artwork both ship; CSS shows one based on body.light.
 *
 * Depends on: nothing.
 */

const LiveIndicator = (function () {
  'use strict';

  const DEFS_ID = 'li-defs';

  // The one wave path (no fill — callers set it via <use fill>) and the one mask.
  const WAVE = "M3.5875 20.4125C3.19583 20.0208 3 19.55 3 19C3 18.45 3.19583 17.9792 3.5875 17.5875C3.97917 17.1958 4.45 17 5 17C5.55 17 6.02083 17.1958 6.4125 17.5875C6.80417 17.9792 7 18.45 7 19C7 19.55 6.80417 20.0208 6.4125 20.4125C6.02083 20.8042 5.55 21 5 21C4.45 21 3.97917 20.8042 3.5875 20.4125ZM17 21C17 19.05 16.6333 17.2292 15.9 15.5375C15.1667 13.8458 14.1667 12.3667 12.9 11.1C11.6333 9.83333 10.1542 8.83333 8.4625 8.1C6.77083 7.36667 4.95 7 3 7V4C5.36667 4 7.575 4.44167 9.625 5.325C11.675 6.20833 13.475 7.425 15.025 8.975C16.575 10.525 17.7917 12.325 18.675 14.375C19.5583 16.425 20 18.6333 20 21H17ZM11 21C11 19.8833 10.7917 18.8458 10.375 17.8875C9.95833 16.9292 9.38333 16.0833 8.65 15.35C7.91667 14.6167 7.07083 14.0417 6.1125 13.625C5.15417 13.2083 4.11667 13 3 13V10C4.53333 10 5.9625 10.2875 7.2875 10.8625C8.6125 11.4375 9.775 12.225 10.775 13.225C11.775 14.225 12.5625 15.3875 13.1375 16.7125C13.7125 18.0375 14 19.4667 14 21H11Z";

  const DEFS_HTML =
    '<svg id="' + DEFS_ID + '" aria-hidden="true" width="0" height="0" ' +
    'style="position:absolute;width:0;height:0;overflow:hidden" ' +
    'xmlns="http://www.w3.org/2000/svg"><defs>' +
      '<path id="li-wave" d="' + WAVE + '"/>' +
      // mask-type:alpha + an opaque (white) fill => the wave shape reveals; a
      // luminance fallback also reveals (white = full luminance), so it's safe
      // either way.
      '<mask id="li-mask" style="mask-type:alpha" maskUnits="userSpaceOnUse" ' +
      'x="3" y="4" width="17" height="17"><use href="#li-wave" fill="#fff"/></mask>' +
    '</defs></svg>';

  // Six tiny layers — identical for every instance (one shared mask id, so no
  // per-instance uniqueness needed).
  const ICON = "<svg class=\"sig-0 dark-svg\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g mask=\"url(#li-mask)\"><use href=\"#li-wave\" fill=\"#8B949E\"/><circle cx=\"5\" cy=\"19\" r=\"2\" fill=\"#22C55E\"/></g></svg><svg class=\"sig-1 dark-svg\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g mask=\"url(#li-mask)\"><use href=\"#li-wave\" fill=\"#8B949E\"/><circle cx=\"3\" cy=\"21\" r=\"11\" fill=\"#22C55E\"/></g></svg><svg class=\"sig-2 dark-svg\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g mask=\"url(#li-mask)\"><use href=\"#li-wave\" fill=\"#22C55E\"/><circle cx=\"3\" cy=\"21\" r=\"17\" fill=\"#22C55E\"/></g></svg><svg class=\"sig-0 light-svg\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g mask=\"url(#li-mask)\"><use href=\"#li-wave\" fill=\"#64748B\"/><circle cx=\"5\" cy=\"19\" r=\"2\" fill=\"#16A34A\"/></g></svg><svg class=\"sig-1 light-svg\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g mask=\"url(#li-mask)\"><use href=\"#li-wave\" fill=\"#64748B\"/><circle cx=\"3\" cy=\"21\" r=\"11\" fill=\"#16A34A\"/></g></svg><svg class=\"sig-2 light-svg\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g mask=\"url(#li-mask)\"><use href=\"#li-wave\" fill=\"#16A34A\"/><circle cx=\"3\" cy=\"21\" r=\"17\" fill=\"#16A34A\"/></g></svg>";

  /** Inject the shared <defs> once. Idempotent; no-op without a document. */
  function ensureDefs(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.body) return;
    if (d.getElementById(DEFS_ID)) return;
    const holder = d.createElement('div');
    holder.innerHTML = DEFS_HTML;
    const node = holder.firstChild;
    if (node) d.body.appendChild(node);
  }

  /** Just the six animated <svg> layers (no wrapper). */
  function svg() { ensureDefs(); return ICON; }

  /**
   * The indicator as a drop-in span.
   * @param {{size?:number, className?:string, title?:string}} [opts]
   */
  function html(opts) {
    opts = opts || {};
    ensureDefs();
    const cls = opts.className || 'live-indicator';
    const style = opts.size ? ' style="--li-size:' + opts.size + 'px"' : '';
    const a11y = opts.title
      ? ' role="img" aria-label="' + opts.title + '" title="' + opts.title + '"'
      : ' aria-hidden="true"';
    return '<span class="' + cls + '"' + style + a11y + '>' + ICON + '</span>';
  }

  // Inject as soon as the module loads if a document is already present.
  ensureDefs();

  return { html, svg, ensureDefs, DEFS_HTML: DEFS_HTML };
})();
