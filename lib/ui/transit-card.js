/**
 * transit-card.js — TransitCard (main-next design system, COMPLEX component)
 *
 * The whole transit card, composed from the atoms:
 *   RouteBadge  — the colored square/round route badge
 *   RouteTag    — the operator/service chip
 *   EtaPill     — the ETA readout pills (+ the "no data yet" ··· fallback)
 *   RouteTones  — route color → themed card/tag surfaces
 *   LiveIndicator (transitively, via EtaPill)
 *
 * This replaces the inline badge/tag/pill/tones markup that card-render.js used
 * to carry. Structure, classes, data-attributes and the pinned state are
 * reproduced verbatim from the pre-refactor renderCard, so the card renders
 * pixel-identically — the atoms simply own the pieces now. (The only textual
 * difference is that the atoms emit clean class lists, e.g. `class="badge-num"`
 * instead of the old `class="badge-num "` with a trailing space — cosmetic, no
 * render effect.)
 *
 * The pin state is read from the global PinStore (same guard + fallback key the
 * card always used); if PinStore isn't loaded the card renders unpinned.
 *
 *   el.innerHTML = TransitCard.html(cardData);
 *
 * cardData = { route, headsign, mode, tag, badge, color, textColor,
 *              etas: [{ms, live}], nextDayTimes? }
 *
 * Depends on: RouteBadge, RouteTag, EtaPill, RouteTones (+ PinStore, optional).
 */
const TransitCard = (function () {
  'use strict';

  function formatTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  /** ETA slot: next-day time, a >90-min next-day time, up to-90-min pills, or ···. */
  function _pills(g) {
    if (g.nextDayTimes) {
      return `<div class="next-day-times"><span>${formatTime(g.nextDayTimes[0])}</span></div>`;
    }
    if (g.etas && g.etas.length) {
      const nearestMin = Math.round((g.etas[0].ms - Date.now()) / 60000);
      if (nearestMin > 90) {
        return `<div class="next-day-times"><span>${formatTime(g.etas[0].ms)}</span></div>`;
      }
      let relevant = g.etas.filter(e => Math.round((e.ms - Date.now()) / 60000) <= 90);
      if (!relevant.length) relevant = [g.etas[0]];
      return relevant.map((eta, i) => EtaPill.html({ eta, idx: i, size: 'card' })).join('');
    }
    return EtaPill.emptyDots();
  }

  /**
   * Render one transit card (matches the pre-refactor CardRender.renderCard).
   */
  function html(g) {
    const tones = RouteTones.for(g.color);   // theme resolved from body.light
    const cardBg = tones.card;

    const badge = RouteBadge.html({
      route: g.route, mode: g.mode, badge: g.badge,
      color: g.color, textColor: g.textColor, size: 'card',
    });
    const tag = RouteTag.html({ tag: g.tag, bg: tones.tagBg, color: tones.tagTxt, size: 'card' });
    const pills = _pills(g);

    // Pin key is the STABLE one (routeId|directionName) from PinStore — not the
    // route|headsign|mode key, which silently unpinned when the headsign text
    // changed. data-key stays on the element so list code can map a DOM node
    // back to its card.
    const hasPinStore = (typeof PinStore !== 'undefined');
    const cardKey = hasPinStore ? PinStore.keyFor(g) : g.route + '|' + g.headsign + '|' + g.mode;
    const isPinned = hasPinStore && PinStore.isPinned(g);
    const pinHtml = isPinned
      ? '<span class="card-pin"><svg viewBox="0 0 24 24"><path d="M20 15.31L23.31 12 20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69z"/></svg></span>'
      : '';

    return `<div class="card${isPinned ? ' pinned' : ''}" data-key="${cardKey}" data-route="${g.route}" style="background:${cardBg}">
      ${pinHtml}
      ${badge}
      <div class="info">
        ${tag}
        <div class="dest">${g.headsign}</div>
      </div>
      <div class="etas">${pills}</div>
    </div>`;
  }

  return { html, formatTime };
})();
