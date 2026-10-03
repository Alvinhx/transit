/**
 * card-render.js — CardRender compatibility shim (main-next)
 *
 * The card is now composed by the design system: the TransitCard complex
 * (lib/ui/transit-card.js) built from the RouteBadge / RouteTag / EtaPill atoms
 * and the RouteTones tokens. This module used to carry all of that inline; it is
 * now a thin façade that keeps the historical `CardRender.*` API so existing
 * callers don't have to change:
 *
 *   CardRender.renderCard(g)  → TransitCard.html(g)
 *   CardRender.renderPill(e,i)→ EtaPill.html({ eta, idx, size:'card' })
 *   CardRender.formatTime     → TransitCard.formatTime
 *   CardRender.usesIconBadge  → RouteBadge.usesIconBadge   (badge glyph rule)
 *   CardRender.badgeGlyph     → RouteBadge.badgeGlyph
 *
 * The two things that AREN'T atoms live here, because they're the card module's
 * own concerns and other pages import them from CardRender:
 *   parseRoute      — normalize a route short-name for display
 *   vehicleGlyph    — the glyph for a VEHICLE marker on the MAP (not a badge)
 *   liveSignalIcon  — the pill-corner LiveIndicator (detail page uses it)
 *
 * Consumers today: home.js (renderCard), station.js (renderCard),
 * stop-feed.js (parseRoute), detail.js (usesIconBadge, badgeGlyph, vehicleGlyph,
 * liveSignalIcon).
 *
 * Depends on: TransitCard, EtaPill, RouteBadge, LiveIndicator.
 */

const CardRender = (function () {
  'use strict';

  /** Main's parseRoute: badge shows the bare number/name. */
  function parseRoute(shortName) {
    return String(shortName || '').replace(/\s*Line$/i, '').replace(/\s*Streetcar$/i, '').trim();
  }

  // Badge glyph rules live on the RouteBadge atom; delegate so there's one source.
  function usesIconBadge(g) { return RouteBadge.usesIconBadge(g); }
  function badgeGlyph(g) { return RouteBadge.badgeGlyph(g); }

  /**
   * Material glyph for a VEHICLE marker on the map.
   *
   * Deliberately separate from badgeGlyph, which answers a different question.
   * badgeGlyph only applies to routes whose badge CAN'T show a number; a map
   * marker needs a glyph for EVERY mode, including numbered ones (rail shows a
   * number on its badge but still needs a train on the map).
   */
  function vehicleGlyph(mode) {
    if (mode === 'rail' || mode === 'monorail') return 'train';
    if (mode === 'streetcar') return 'tram';
    return 'directions_bus';
  }

  /**
   * Live-feed signal icon in the pill-corner wrapper. Thin alias over the shared
   * LiveIndicator primitive so the markup lives in ONE place; `className:'pill-live'`
   * reuses the pill-corner positioning, so cards/detail look exactly as before.
   */
  function liveSignalIcon() {
    return LiveIndicator.html({ className: 'pill-live' });
  }

  return {
    // Card + pill composition now flows through the design system.
    renderCard: function (g) { return TransitCard.html(g); },
    renderPill: function (eta, idx) { return EtaPill.html({ eta, idx, size: 'card' }); },
    formatTime: TransitCard.formatTime,
    parseRoute,
    // Shared so the detail page renders the same badge + live indicator as a card
    // instead of keeping its own diverging copies.
    usesIconBadge, badgeGlyph, vehicleGlyph, liveSignalIcon,
  };
})();
