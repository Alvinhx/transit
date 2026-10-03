/**
 * route-tag.js — RouteTag atom (main-next design system)
 *
 * The small colored chip that labels a route's operator / service group
 * ("METRO", "SOUND TRANSIT", "LINK", …). It sits above the headsign on a card
 * and beside the badge on the detail header.
 *
 * ATOM · sizes: card (.tag — rounded pill, mixed-case, ellipsis) |
 *               detail (.dp-badge-tag — smaller UPPERCASE, letter-spaced)
 *
 *   RouteTag.html({ tag:'METRO', bg:'#2B7A1E', color:'#B5EAAD', size:'card' })
 *
 * The two sizes are genuinely different visuals (not just a scale), so each maps
 * to its own legacy class; the atom only picks the class from `size`. Colors are
 * passed in (they come from RouteTones, keyed by the route color) and applied
 * inline exactly as the card/detail did before — zero pixel change.
 *
 * Owns its CSS in route-tag.css (.tag moved out of base.css, .dp-badge-tag moved
 * out of main-next.css).
 *
 * Depends on: nothing.
 */
const RouteTag = (function () {
  'use strict';
  /**
   * @param {object} g { tag, bg, color, size }
   *   size: 'card' (default, .tag) | 'detail' (.dp-badge-tag)
   */
  function html(g) {
    g = g || {};
    const cls = g.size === 'detail' ? 'dp-badge-tag' : 'tag';
    const tag = g.tag == null ? '' : g.tag;
    return `<div class="${cls}" style="background:${g.bg};color:${g.color}">${tag}</div>`;
  }
  return { html };
})();
