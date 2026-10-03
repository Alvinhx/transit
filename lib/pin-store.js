/**
 * pin-store.js — GLOBAL route pinning (main-next)
 *
 * WHAT IT IS
 * A pinned line floats to the top of EVERY list — nearby, station, anywhere.
 * Pinning is a user-level statement ("I care about Route 8"), not a per-board
 * one, so there is exactly ONE pin set for the whole app.
 *
 * ── Difference from Main/, on purpose ──────────────────────────────────────────
 * 1. SCOPE. Main scoped pins per location (`nextup_priority_overrides[locationId]`),
 *    so pinning the 8 at Capitol Hill did nothing on any other board. There is
 *    also no location id in Nearby mode (it's GPS-based), so a per-location model
 *    has nowhere to put those pins. This store is global.
 *
 * 2. KEY FORMAT — this fixes a real bug. Main pinned by `route|headsign|mode`
 *    while its cache keyed on `route|mode|dirIndex`. Headsigns are live API text
 *    that changes ("Downtown Seattle" → "Downtown Seattle Broadway"), and when it
 *    did, the stored pin key stopped matching and the route SILENTLY UNPINNED.
 *    We key on `routeId|directionName` instead: `routeId` is a stable OBA id and
 *    `directionName` comes from our own store (routes-data), so neither drifts
 *    with upstream text. Both fields are present on cards in every mode, which is
 *    what actually makes "pinned everywhere" hold.
 *
 * 3. NO PER-STATION DEFAULTS. Main seeded pins from each station's JSON
 *    `priority` array of route NAMES. Route names are ambiguous across agencies
 *    (Metro 1 vs Link "1 Line", Metro 102 vs CT 102 — see the service-change
 *    audit), and per-station defaults contradict a global set. Instead the global
 *    list is seeded ONCE from the first station the user picks (see seedFrom()),
 *    then it's theirs.
 *
 * Storage: `mn.pins.v1` — namespaced so it can't collide with Main's
 * `nextup_priority_overrides` while both apps exist.
 *
 * Depends on: nothing. (Deliberately dependency-free so any page can use it.)
 */

const PinStore = (function () {
  'use strict';

  const KEY = 'mn.pins.v1';
  const _subs = [];
  let _mem = null; // in-memory mirror, avoids re-parsing on every card render

  /**
   * Stable pin key for a card. Falls back through progressively weaker
   * identifiers so a card missing directionName still pins predictably rather
   * than silently failing.
   */
  function keyFor(card) {
    if (!card) return '';
    const rid = card.routeId || card.route || '';
    if (!rid) return '';
    const dir = card.directionName || card.headsign || '';
    return rid + '|' + dir;
  }

  function _load() {
    if (_mem) return _mem;
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      _mem = Array.isArray(parsed) ? parsed.filter(k => typeof k === 'string') : [];
    } catch (e) {
      _mem = [];
    }
    return _mem;
  }

  function _save() {
    try { localStorage.setItem(KEY, JSON.stringify(_mem || [])); } catch (e) { /* quota */ }
    for (const cb of _subs) { try { cb(getPins()); } catch (e) { /* isolate */ } }
  }

  /** All pinned keys (copy — callers can't mutate our state). */
  function getPins() { return _load().slice(); }

  function isPinned(card) {
    const k = keyFor(card);
    return !!k && _load().indexOf(k) >= 0;
  }

  /** @returns {boolean} the NEW pinned state */
  function toggle(card) {
    const k = keyFor(card);
    if (!k) return false;
    const list = _load();
    const i = list.indexOf(k);
    if (i >= 0) { list.splice(i, 1); _save(); return false; }
    list.push(k); _save(); return true;
  }

  function pin(card) { if (!isPinned(card)) toggle(card); }
  function unpin(card) { if (isPinned(card)) toggle(card); }

  /**
   * Sort comparator: pinned block first, then whatever the caller's own ordering
   * is (passed as `tieBreak`). Each mode keeps its own secondary sort — Nearby
   * sorts by distance (stable across refreshes), Station sorts by soonest ETA.
   *
   * @param {function} tieBreak (a,b) => number, applied within each block
   */
  function comparator(tieBreak) {
    const tb = tieBreak || (() => 0);
    return function (a, b) {
      const ap = isPinned(a) ? 0 : 1;
      const bp = isPinned(b) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return tb(a, b);
    };
  }

  /** Convenience: pinned-first ordering applied to a card array (stable). */
  function sortCards(cards, tieBreak) {
    return (cards || []).slice().sort(comparator(tieBreak));
  }

  /**
   * One-time seed so a brand-new user gets a sensible starting set instead of an
   * empty pin list. Takes route NAMES (from a station's JSON `priority`) and
   * resolves them against real cards, which is the only way to turn an ambiguous
   * name like "102" into a concrete routeId. No-ops if the user already has pins
   * or if we've seeded before.
   *
   * @param {string[]} routeNames e.g. ["8","1","2","First Hill"]
   * @param {object[]} cards      current cards to resolve names against
   * @returns {number} how many pins were added
   */
  function seedFrom(routeNames, cards) {
    if (_load().length) return 0;                       // user already has pins
    try { if (localStorage.getItem(KEY + '.seeded')) return 0; } catch (e) {}
    const names = routeNames || [];
    let added = 0;
    for (const c of (cards || [])) {
      if (names.indexOf(c.route) < 0) continue;
      const k = keyFor(c);
      if (k && _mem.indexOf(k) < 0) { _mem.push(k); added++; }
    }
    try { localStorage.setItem(KEY + '.seeded', '1'); } catch (e) {}
    if (added) _save();
    return added;
  }

  /** Subscribe to pin changes → re-render lists. Returns an unsubscribe fn. */
  function onChange(cb) {
    _subs.push(cb);
    return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); };
  }

  function clearAll() { _mem = []; _save(); }

  return {
    keyFor, getPins, isPinned, toggle, pin, unpin,
    comparator, sortCards, seedFrom, onChange, clearAll,
  };
})();
