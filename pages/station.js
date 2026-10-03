/**
 * station.js — Station live board (main-next)
 *
 * The v1 home page, rebuilt: station name at the top, a flat list of departures
 * below it, soonest first. No map — this is the "I'm standing at the station,
 * what leaves next" view.
 *
 * Built on the ROOT variant of the List page template (title bar + scrollable
 * list). Deliberately NOT on the Map+Sheet template: with no map, that template's
 * Leaflet lifecycle and drag/snap machinery would be dead weight, and its snap
 * points would let the user drag the sheet down to reveal a map that shouldn't
 * exist in this mode.
 *
 * DATA — one API call per refresh. StopFeed in station mode: centre fixed on the
 * station's centroid, restricted to that station's curated stop ids, sorted by
 * soonest departure. v1 polled every stop individually (7 calls at Capitol Hill,
 * 20 at Lynnwood, staggered 1s apart so a Lynnwood cycle outran its own 15s
 * refresh, and rate-limiting was observable). See lib/stop-feed.js.
 *
 * ORDERING — pinned block first (global pins, so a pin made here or on the
 * Nearby board applies to both), then soonest ETA. Distance is not used: every
 * stop is within ~200m of the centroid, so "what leaves next" is the only
 * meaningful order.
 *
 * Tap a card → route detail. Long-press a card → toggle its pin.
 *
 * Depends on globals: ListPageTemplate, StopFeed, StationConfig, PinStore,
 * LongPress, CardRender, DetailPage, ScheduleCache (optional).
 */

const StationPage = (function () {
  'use strict';

  const REFRESH_MS = 20000;
  const STATION_RADIUS_M = 300;   // small on purpose — see stop-feed.js header

  let _state = null; // { page, station, feed, unsubFeed, unsubPins, unbindPress, cards }

  // ── Rendering ───────────────────────────────────────────────────────────────

  function _renderCards(snapshot) {
    if (!_state || !_state.page) return;
    const host = _state.page.getBody();
    if (!host) return;

    const raw = (snapshot && snapshot.cards) || [];

    if (!raw.length) {
      _state.cards = [];
      let msg;
      if (!snapshot) msg = 'Loading departures…';
      else if (snapshot.ok === false) msg = 'Couldn\'t load departures — retrying…';
      else msg = 'Nothing scheduled here in the next 90 minutes.';
      host.innerHTML = `<div class="dp-loading">${msg}</div>`;
      return;
    }

    // Pinned block first, then soonest departure.
    const cards = (typeof PinStore !== 'undefined')
      ? PinStore.sortCards(raw, (a, b) => {
          const ae = (a.etas && a.etas.length) ? a.etas[0].ms : Infinity;
          const be = (b.etas && b.etas.length) ? b.etas[0].ms : Infinity;
          return ae - be;
        })
      : raw;
    _state.cards = cards;

    host.innerHTML = cards.map(c => CardRender.renderCard(c)).join('');

    if (_state.unbindPress) { try { _state.unbindPress(); } catch (e) {} }
    _state.unbindPress = LongPress.bindAll(host, '.card', i => ({
      onTap: () => _openDetail(cards[i]),
      onLongPress: () => PinStore.toggle(cards[i]),   // onChange re-renders
    }));
  }

  function _rerender() {
    if (!_state) return;
    _renderCards(_state.feed ? _state.feed.getLast() : { cards: _state.cards, ok: true });
  }

  function _openDetail(card) {
    if (typeof DetailPage === 'undefined' || !card) return;
    pauseFeed(); // the detail page runs its own route feed — don't double-poll
    if (typeof AppShell !== 'undefined') AppShell.onDetailOpen();
    DetailPage.open({
      route: card.route,
      routeId: card.routeId,
      headsign: card.headsign,
      color: card.color,
      textColor: card.textColor,
      mode: card.mode,
      tag: card.tag,
      badge: card.badge,
      // Seed the detail ETA readout with what this card is showing, so it's
      // consistent on open before the detail page's own live fetch returns.
      etas: card.etas,
      // Station context: anchor the detail page on the SAME stop this card was
      // built from (a stop in this station), not the user's GPS-nearest stop —
      // otherwise a user far from the station sees different times than the card.
      originStopId: card.stopId,
      originStopName: card.stopName,
      directionName: card.directionName,
      originIsStation: true,
    });
  }

  // ── Feed ────────────────────────────────────────────────────────────────────

  function _startFeed() {
    if (!_state || _state.feed || !_state.station) return;
    const st = _state.station;
    if (!st.center) {
      const host = _state.page.getBody();
      if (host) host.innerHTML = '<div class="dp-loading">Couldn\'t locate this station\'s stops.</div>';
      return;
    }
    _state.feed = StopFeed.create({
      radius: STATION_RADIUS_M,
      intervalMs: REFRESH_MS,
      sortBy: 'eta',
      stopIds: st.stopIds,
    });
    _state.unsubFeed = _state.feed.onUpdate(snap => {
      if (!_state) return;
      _renderCards(snap);
      // First real data: seed the global pin list once from this station's
      // suggested routes, so a new user doesn't start with an empty board.
      if (!_state._seeded && snap.cards && snap.cards.length) {
        _state._seeded = true;
        if (typeof PinStore !== 'undefined' && st.priority && st.priority.length) {
          if (PinStore.seedFrom(st.priority, snap.cards)) _rerender();
        }
      }
    });
    // Fixed centre — never setLocation(), unlike the Nearby board.
    _state.feed.start(st.center.lat, st.center.lon);
  }

  function pauseFeed() {
    if (_state && _state.feed) {
      try { _state.feed.stop(); } catch (e) {}
      _state.feed = null;
      _state.unsubFeed = null;
    }
  }

  function resumeFeed() {
    if (_state && !_state.feed) _startFeed();
  }

  // ── Station selection ───────────────────────────────────────────────────────

  /** Swap the displayed station without tearing the page down. */
  function setStation(station) {
    if (!_state || !station) return;
    pauseFeed();
    _state.station = station;
    _state.cards = [];
    _state.page.setTitle(station.name);
    const host = _state.page.getBody();
    if (host) host.innerHTML = '<div class="dp-loading">Loading departures…</div>';
    _startFeed();
  }

  function getStation() { return _state ? _state.station : null; }

  // ── Public: open / close ────────────────────────────────────────────────────

  /**
   * @param {object} opts
   *   station     normalised station from StationConfig (required)
   *   onTitleTap  called when the title is tapped (opens the station switcher)
   */
  function open(opts) {
    opts = opts || {};
    if (_state) close();
    const station = opts.station;

    const page = ListPageTemplate.createListPage({
      id: 'station',
      root: true,                 // tab destination: no back button, no slide-in
      title: station ? station.name : 'Station',
      onTitleTap: opts.onTitleTap,
      items: [],
      itemClass: '',              // cards are self-contained — no .lp-item wrapper
      bodyClass: 'hm-cards',      // 8px card stack + bottom clearance for the toggle
      renderItem: c => CardRender.renderCard(c),
      emptyState: 'Nothing scheduled here in the next 90 minutes.',
      onDestroy() {
        if (_state) {
          if (_state.unsubFeed) { try { _state.unsubFeed(); } catch (e) {} }
          if (_state.unsubPins) { try { _state.unsubPins(); } catch (e) {} }
          if (_state.unbindPress) { try { _state.unbindPress(); } catch (e) {} }
          if (_state.feed) { try { _state.feed.stop(); } catch (e) {} }
        }
        _state = null;
      },
    });

    _state = {
      page, station,
      feed: null, unsubFeed: null, unsubPins: null, unbindPress: null,
      cards: [], _seeded: false,
    };

    page.mount(document.body);

    // Pins are global — a pin toggled on the Nearby board re-orders this list too.
    if (typeof PinStore !== 'undefined') {
      _state.unsubPins = PinStore.onChange(() => _rerender());
    }

    _renderCards(null);   // "Loading departures…" until the first tick lands
    _startFeed();
    return page;
  }

  function close() {
    if (!_state) return;
    if (_state.page) _state.page.unmount();
  }

  function isOpen() { return !!_state; }
  function setVisible(v) { if (_state && _state.page) _state.page.setVisible(v); }

  return {
    open, close, isOpen, setVisible,
    pauseFeed, resumeFeed,
    setStation, getStation,
  };
})();
