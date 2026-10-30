/**
 * app.js — application shell (main-next)
 *
 * Owns the two ROOT views and the chrome that spans them. Neither page knows
 * about the other; the shell is the only thing that knows both exist.
 *
 *   NEARBY  → HomePage    (map + GPS dot + nearby cards, Map+Sheet template)
 *   STATION → StationPage (station title + departure list, List template)
 *
 * ── Switching model ─────────────────────────────────────────────────────────
 * Both views stay MOUNTED and we toggle visibility. The alternative — unmount on
 * switch — would re-init Leaflet and re-run the detail page's phase-3 framing
 * animation every time you flipped modes, which feels slow and looks jarring.
 * Keeping both mounted also preserves each view's scroll position.
 *
 * The inactive view's feed is PAUSED, so exactly one poll is ever in flight. The
 * station view is created lazily on first use, so a user who never opens it never
 * pays for it.
 *
 * ── Detail pages ────────────────────────────────────────────────────────────
 * The detail page routes its teardown back through here (`onDetailClose`) rather
 * than calling HomePage.resumeFeed() directly. That's load-bearing: resuming home
 * unconditionally would restart the nearby feed even when the STATION board is
 * the visible view, leaving two feeds polling.
 *
 * ── First run into station mode ─────────────────────────────────────────────
 * If no station has ever been chosen, the station switcher opens so the user can
 * pick one; their choice becomes the default (see ViewMode — selecting IS
 * setting, which is why v1's separate "home station" star is gone). Until the
 * picker exists, we fall back to the city file's own default station.
 *
 * Depends on globals: ViewMode, ModeToggle, HomePage, StationPage,
 * StationConfig, and optionally StationPicker (phase 5).
 */

const AppShell = (function () {
  'use strict';

  let _toggle = null;
  let _stationReady = false;   // StationPage has been mounted at least once
  let _started = false;
  // History-based back (step B): station mode is one "back level" — entering it
  // pushes a history entry so a back (swipe / Back button) returns to Nearby.
  // See _goStation / _goNearby / _onPopState.
  let _stationPushed = false;
  let _pickerDismissible = true;

  // ── Station resolution ──────────────────────────────────────────────────────

  /**
   * Resolve the station to show: the user's saved default, else the city default.
   * @returns {object|null} normalised station from StationConfig
   */
  function _resolveStation() {
    if (typeof StationConfig === 'undefined' || !StationConfig.isLoaded()) return null;
    const ref = ViewMode.getDefaultStation();
    if (ref) {
      const st = StationConfig.get(ref.type, ref.id);
      if (st) return st;
      // Saved station vanished (custom location deleted, or renamed station key).
      ViewMode.clearDefaultStation();
    }
    const id = StationConfig.defaultStationId();
    return id ? StationConfig.get('builtin', id) : null;
  }

  /**
   * Open the station switcher.
   * @param {boolean} dismissible false on first run — there's no station to fall
   *   back to yet, so the user must choose one. True when reached by tapping the
   *   station title, where keeping the current station is a valid outcome.
   */
  function _openPicker(dismissible) {
    if (typeof StationPicker === 'undefined') return false;
    _pickerDismissible = (dismissible !== false); // back closes a dismissible picker; absorbs for first-run
    StationPicker.open({
      dismissible: dismissible !== false,
      // Selecting a station IS setting it as the default.
      onSelect: (station) => {
        if (!station) return;
        ViewMode.setDefaultStation(station.type, station.id);
        if (_stationReady) StationPage.setStation(station);
        else _mountStation(station);
        _syncChrome();
      },
      onDismiss: () => _syncChrome(),
    });
    _syncChrome();   // hide the toggle while the picker is up
    return true;
  }

  function _mountStation(station) {
    if (_stationReady) return;
    StationPage.open({
      station,
      onTitleTap: () => _openPicker(true),   // cancellable — a station is showing
    });
    _stationReady = true;
  }

  // ── Mode switching ──────────────────────────────────────────────────────────

  function _applyMode(mode) {
    const station = mode === ViewMode.STATION;

    if (station) {
      // First time here: create the page. If the user has never chosen a station,
      // show the picker over the resolved fallback so the board isn't empty
      // behind it.
      if (!_stationReady) {
        const st = _resolveStation();
        if (!st) {
          // No station data at all — bounce back rather than showing a dead view.
          ViewMode.set(ViewMode.NEARBY);
          if (_toggle) _toggle.setValue(ViewMode.NEARBY);
          return;
        }
        _mountStation(st);
        // First ever visit: make them choose. The fallback station renders behind
        // the picker so the page isn't blank, but there's no way to back out
        // without picking, because there'd be nothing to back out TO.
        if (!ViewMode.hasDefaultStation()) _openPicker(false);
      }
      HomePage.setVisible(false);
      HomePage.pauseFeed();
      StationPage.setVisible(true);
      StationPage.resumeFeed();
    } else {
      if (_stationReady) {
        StationPage.setVisible(false);
        StationPage.pauseFeed();
      }
      HomePage.setVisible(true);
      HomePage.resumeFeed();
    }
  }

  // ── History-based back (step B) ─────────────────────────────────────────────
  // Enter station mode → push ONE entry; a back pops it → return to Nearby.
  // Detail (step A) owns its own entry on top, so a back from a detail opened
  // over station closes the detail first, then the next back returns to Nearby.
  // Station CHANGES don't push (back goes to home, not through prior stations).
  function _goStation() {
    ViewMode.set(ViewMode.STATION);
    _applyMode(ViewMode.STATION);
    if (!_stationPushed) {
      try { history.pushState({ lvl: 'station' }, ''); _stationPushed = true; } catch (e) {}
    }
    _syncChrome();
  }
  function _goNearby() {
    // If a station entry is on the stack, go BACK so the popstate path does the
    // switch (keeps history balanced); otherwise switch directly.
    if (_stationPushed) { try { history.back(); return; } catch (e) {} }
    ViewMode.set(ViewMode.NEARBY);
    _applyMode(ViewMode.NEARBY);
    _syncChrome();
  }
  function _onPopState() {
    // Detail (step A) owns the top entry — let detail's own handler close it.
    if (typeof DetailPage !== 'undefined' && DetailPage.isOpen && DetailPage.isOpen()) return;
    // Back while the station picker is up: the back consumed the station entry,
    // so re-arm it, and close the picker (unless it's the non-dismissible
    // first-run picker, which requires a choice).
    if (typeof StationPicker !== 'undefined' && StationPicker.isOpen && StationPicker.isOpen()) {
      if (_stationPushed) { try { history.pushState({ lvl: 'station' }, ''); } catch (e) {} }
      if (_pickerDismissible) { try { StationPicker.close(); } catch (e) {} _syncChrome(); }
      return;
    }
    // Otherwise a back popped the station entry → return to Nearby.
    if (_stationPushed && ViewMode.get() === ViewMode.STATION) {
      _stationPushed = false;
      ViewMode.set(ViewMode.NEARBY);
      _applyMode(ViewMode.NEARBY);
      if (_toggle) _toggle.setValue(ViewMode.NEARBY);
      _syncChrome();
    }
  }

  /** Push current app state into the chrome (toggle value + visibility). */
  function _syncChrome() {
    if (!_toggle) return;
    _toggle.setValue(ViewMode.get());
    const drilledIn =
      (typeof DetailPage !== 'undefined' && DetailPage.isOpen && DetailPage.isOpen()) ||
      (typeof AlertsPage !== 'undefined' && AlertsPage.isOpen && AlertsPage.isOpen()) ||
      (typeof StationPicker !== 'undefined' && StationPicker.isOpen && StationPicker.isOpen());
    _toggle.setVisible(!drilledIn);
  }

  // ── Detail page hooks (called by the pages) ─────────────────────────────────

  function onDetailOpen() { if (_toggle) _toggle.setVisible(false); }

  function onDetailClose() {
    // Resume ONLY the visible view.
    if (ViewMode.get() === ViewMode.STATION && _stationReady) StationPage.resumeFeed();
    else HomePage.resumeFeed();
    _syncChrome();
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /** Mount the shell. Call once, after the data layer is warm. */
  function start() {
    if (_started) return;
    _started = true;

    // Default the theme to the OS appearance (was hard-locked to dark). Set it
    // before HomePage.open() so the map tiles + card tones pick the right theme
    // on first paint. Startup-only — we don't follow live OS changes yet.
    try {
      const prefersLight = window.matchMedia
        && window.matchMedia('(prefers-color-scheme: light)').matches;
      document.body.classList.toggle('light', !!prefersLight);
    } catch (e) { /* matchMedia unavailable — leave default (dark) */ }

    // Nearby is always mounted — it's the default destination and owns the map.
    HomePage.open();

    _toggle = ModeToggle.create({
      value: ViewMode.get(),
      segments: [
        { id: ViewMode.NEARBY, label: 'Nearby', icon: 'near_me' },
        { id: ViewMode.STATION, label: 'Station', icon: 'departure_board' },
      ],
      onChange: (mode) => { if (mode === ViewMode.STATION) _goStation(); else _goNearby(); },
    });
    _toggle.mount(document.body);

    // Restore the last-used mode. _goStation (not bare _applyMode) so a back
    // entry is pushed → a back returns to Nearby even on a station-default boot.
    if (ViewMode.get() === ViewMode.STATION) _goStation();
    // Back button / swipe → pop station mode back to Nearby (step B).
    window.addEventListener('popstate', _onPopState);
    _syncChrome();
  }

  function getMode() { return ViewMode.get(); }

  /** Programmatic switch (same path as tapping the toggle). */
  function setMode(mode) {
    if (mode === ViewMode.STATION) _goStation();
    else _goNearby();
  }

  return { start, getMode, setMode, onDetailOpen, onDetailClose, openStationPicker: _openPicker };
})();
