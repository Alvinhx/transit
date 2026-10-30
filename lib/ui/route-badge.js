/**
 * route-badge.js — RouteBadge atom (main-next design system)
 *
 * The colored square/round that leads a transit card / detail header: shows the
 * route NUMBER, or a MODE GLYPH for named services whose "number" is prose
 * ("South Lake Union", "Swift Orange") and would overflow.
 *
 * ATOM · variants: number | icon (chosen automatically from mode) ·
 *                  sizes: card (72px, shape from `badge`) | detail (44px circle)
 *
 *   RouteBadge.html({ route:'8', mode:'bus', badge:'square',
 *                     color:'#FDB71A', textColor:'#000', size:'card' })
 *
 * Owns its CSS in route-badge.css (the .badge* family, moved out of base.css).
 * Also owns the badge-glyph rules (usesIconBadge / badgeGlyph); card-render and
 * the detail page delegate here so the icon rule lives in one place.
 *
 * Depends on: nothing.
 */

const RouteBadge = (function () {
  'use strict';

  /** Named services get a glyph instead of a number (their route is prose). */
  function usesIconBadge(g) {
    return !!g && g.badge === 'square' &&
      (g.mode === 'streetcar' || g.mode === 'monorail' || g.mode === 'swift' || g.mode === 'shuttle');
  }

  /** Material glyph for an icon badge. */
  function badgeGlyph(g) {
    if (!g) return 'directions_bus';
    if (g.mode === 'monorail') return 'train';
    if (g.mode === 'swift' || g.mode === 'shuttle') return 'directions_bus';
    return 'tram';
  }

  // Card badges shrink the number for longer route names; detail is fixed size.
  function _numClass(route) {
    const n = String(route || '').length;
    return n > 4 ? 'xs' : n > 2 ? 'sm' : '';
  }

  /**
   * @param {object} g { route, mode, badge, color, textColor, size }
   *   size: 'card' (default) | 'detail'
   */
  function html(g) {
    g = g || {};
    const detail = g.size === 'detail';
    const color = g.color || '#666';
    const textColor = g.textColor || '#fff';

    // Shape: card honors square/round; detail is always a circle (no shape class,
    // .badge--detail forces border-radius:50%).
    const shapeCls = detail ? '' : (g.badge === 'square' ? ' square' : ' round');
    const sizeCls = detail ? ' badge--detail' : '';

    let inner;
    if (usesIconBadge(g)) {
      inner = `<span class="badge-icon">${badgeGlyph(g)}</span>`;
    } else {
      // The route number is colored by the route's textColor at BOTH sizes — a
      // consistency fix: the detail badge used to force white, so e.g. "40" on
      // the yellow route was white in detail but black on the card.
      const numCls = detail ? '' : _numClass(g.route);
      const numClsAttr = numCls ? ' ' + numCls : '';
      const sub = g.mode === 'rail' ? '<span class="badge-sub">LINE</span>' : '';
      inner = `<span class="badge-num${numClsAttr}" style="color:${textColor}">${g.route}</span>${sub}`;
    }

    return `<div class="badge${shapeCls}${sizeCls}" style="background:${color}">${inner}</div>`;
  }

  return { html, usesIconBadge, badgeGlyph };
})();
