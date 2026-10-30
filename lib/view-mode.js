/**
 * view-mode.js — which root view is showing, and which station is "home"
 * (main-next)
 *
 * Two pieces of persisted app state, both small enough to live together:
 *
 *   MODE — 'nearby' (map + GPS + nearby cards) or 'station' (station live board).
 *     Persisted so relaunching puts you back where you were.
 *
 *   DEFAULT STATION — the station the station view opens to. Per the product
 *     decision, there is no separate "set as home" gesture: whichever station you
 *     pick simply BECOMES the default. That's why v1's header home/star icon is
 *     gone — selecting is setting.
 *
 * Storage is namespaced (`mn.*`) so it can't collide with Main's
 * `nextup_active_location` / `nextup_default_location`, which mean subtly
 * different things and are still in use by the old app.
 *
 * Depends on: nothing.
 */

const ViewMode = (function () {
  'use strict';

  const MODE_KEY = 'mn.viewmode.v1';
  const STATION_KEY = 'mn.station.default';

  const NEARBY = 'nearby';
  const STATION = 'station';
  const VALID = [NEARBY, STATION];

  const _subs = [];
  let _mode = null;

  function get() {
    if (_mode) return _mode;
    let stored = null;
    try { stored = localStorage.getItem(MODE_KEY); } catch (e) {}
    _mode = VALID.indexOf(stored) >= 0 ? stored : NEARBY;
    return _mode;
  }

  /** @returns {boolean} true if the mode actually changed */
  function set(mode) {
    if (VALID.indexOf(mode) < 0) return false;
    if (get() === mode) return false;
    _mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    for (const cb of _subs) { try { cb(mode); } catch (e) { /* isolate */ } }
    return true;
  }

  function onChange(cb) {
    _subs.push(cb);
    return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); };
  }

  /**
   * The default station, as a {type, id} reference (NOT a resolved station —
   * resolving needs StationConfig, which needs the city file loaded).
   * @returns {{type:'builtin'|'custom', id:string}|null}
   */
  function getDefaultStation() {
    try {
      const raw = localStorage.getItem(STATION_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (p && typeof p.type === 'string' && typeof p.id === 'string') {
        return { type: p.type, id: p.id };
      }
      return null;
    } catch (e) { return null; }
  }

  function setDefaultStation(type, id) {
    if (!type || !id) return false;
    try { localStorage.setItem(STATION_KEY, JSON.stringify({ type, id })); return true; }
    catch (e) { return false; }
  }

  function clearDefaultStation() {
    try { localStorage.removeItem(STATION_KEY); } catch (e) {}
  }

  /** Has the user ever chosen a station? Drives the first-run picker. */
  function hasDefaultStation() { return !!getDefaultStation(); }

  return {
    NEARBY, STATION,
    get, set, onChange,
    getDefaultStation, setDefaultStation, clearDefaultStation, hasDefaultStation,
  };
})();
