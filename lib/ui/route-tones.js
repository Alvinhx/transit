/**
 * route-tones.js — route color → themed surface tones (main-next design system)
 *
 * The M3-style tonal palette that turns a route's brand color into the card
 * background and the company-tag colors, per light/dark theme. Lifted out of
 * card-render.js so both the TransitCard complex and the RouteTag atom read the
 * SAME source instead of each carrying a copy.
 *
 * This is the "tokens" layer of the little design system — pure data + one
 * lookup, no DOM.
 *
 *   RouteTones.for('#FDB71A', 'dark')
 *     → { card:'#1a1712', tagBg:'#7e5c0d', tagTxt:'#ffe500' }
 *
 * Unknown colors fall back to a neutral translucent tone (same behavior the card
 * had before), so a route with an unmapped brand color still renders sanely.
 *
 * Depends on: nothing.
 */

const RouteTones = (function () {
  'use strict';

  // color → { dark:{card,tagBg,tagTxt}, light:{card,tagBg,tagTxt} }
  // Ported verbatim from card-render.js TONES (unchanged values).
  const TONES = {
    "#3DAE2B": { dark: { card: "#0E280A", tagBg: "#2B7A1E", tagTxt: "#B5EAAD" }, light: { card: "#DAF4D6", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#2B7A1E" } },
    "#00A0DF": { dark: { card: "#002433", tagBg: "#006D99", tagTxt: "#99E2FF" }, light: { card: "#CCF0FE", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#006D99" } },
    "#FDB71A": { dark: { card: "#1a1712", tagBg: "#7e5c0d", tagTxt: "#ffe500" }, light: { card: "#ffefcd", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#be8914" } },
    "#9C182F": { dark: { card: "#1a1214", tagBg: "#4e0b17", tagTxt: "#fd3154" }, light: { card: "#e9ccd1", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#751122" } },
    "#2B376E": { dark: { card: "#12141f", tagBg: "#161c37", tagTxt: "#7083d7" }, light: { card: "#cdd2ee", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#132686" } },
    "#E5007D": { dark: { card: "#1a0f14", tagBg: "#72003e", tagTxt: "#ff00be" }, light: { card: "#f9c7e2", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#ac005e" } },
    "#F47836": { dark: { card: "#1f140d", tagBg: "#7a3c1b", tagTxt: "#ffb088" }, light: { card: "#fde8d8", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#b25619" } },
    "#666672": { dark: { card: "#141417", tagBg: "#333339", tagTxt: "#9090a4" }, light: { card: "#dddde0", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#4d4d56" } },
    "#F24C21": { dark: { card: "#1a140f", tagBg: "#773911", tagTxt: "#ffa427" }, light: { card: "#fbe0ce", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#b25619" } },
    "#006CFF": { dark: { card: "#0f141f", tagBg: "#003680", tagTxt: "#00a1ff" }, light: { card: "#c7dfff", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#0051bf" } },
    "#0070C0": { dark: { card: "#0f141f", tagBg: "#003680", tagTxt: "#00a1ff" }, light: { card: "#c7dfff", tagBg: "rgba(255,255,255,0.7)", tagTxt: "#0051bf" } },
  };

  function isLight() {
    return typeof document !== 'undefined' && document.body
      ? document.body.classList.contains('light') : false;
  }

  /**
   * Themed tones for a route color. `theme` defaults to the current body theme.
   * @returns {{card:string, tagBg:string, tagTxt:string}}
   */
  function forColor(color, theme) {
    const t = theme || (isLight() ? 'light' : 'dark');
    const tone = TONES[color];
    if (tone) return tone[t];
    // Neutral fallback — matches card-render.js's previous unmapped-color path.
    return t === 'light'
      ? { card: 'rgba(200,200,200,0.3)', tagBg: 'rgba(255,255,255,0.7)', tagTxt: '#333' }
      : { card: 'rgba(255,255,255,0.08)', tagBg: 'rgba(255,255,255,0.06)', tagTxt: '#aaa' };
  }

  function has(color) { return !!TONES[color]; }

  return { for: forColor, has, isLight };
})();
