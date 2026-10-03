/**
 * long-press.js — long-press + tap gesture binding (main-next)
 *
 * Extracted from Main/home.js `attachLongPress()` so every list (nearby,
 * station, future boards) gets identical behaviour from one implementation.
 *
 * WHY THIS IS FIDDLY — three problems it solves, all learned the hard way in v1:
 *
 * 1. SCROLL vs PRESS. A finger resting on a card while scrolling would fire the
 *    long-press. Fix: any vertical movement over MOVE_TOLERANCE px cancels the
 *    pending timer.
 *
 * 2. LONG-PRESS ALSO FIRING TAP. After a long-press the `touchend`/`click` would
 *    still run and open the detail page on top of the pin action (this was the
 *    v6.3.1 bug). Fix: a `fired` flag suppresses the tap that follows.
 *
 * 3. DOUBLE-FIRING ON TOUCH DEVICES. Mobile browsers emit BOTH `touchend` and a
 *    synthetic `click`, so a single tap opened the detail page twice. Fix: after
 *    handling a touch tap, ignore synthetic clicks for CLICK_SUPPRESS_MS.
 *
 * Usage — bind once per element:
 *   LongPress.bind(el, {
 *     onTap:       () => openDetail(card),
 *     onLongPress: () => PinStore.toggle(card),
 *   });
 *
 * Or bind a whole container at once:
 *   LongPress.bindAll(host, '.card', i => ({ onTap: …, onLongPress: … }));
 */

const LongPress = (function () {
  'use strict';

  const HOLD_MS = 500;              // matches v1 — long enough not to fire on a tap
  const MOVE_TOLERANCE = 10;        // px of vertical travel that means "scrolling"
  const CLICK_SUPPRESS_MS = 500;    // ignore the synthetic click after a touch tap
  const HAPTIC_MS = 30;

  /**
   * @param {HTMLElement} el
   * @param {{onTap?:function, onLongPress?:function, haptic?:boolean}} opts
   * @returns {function} unbind
   */
  function bind(el, opts) {
    if (!el) return () => {};
    const onTap = opts && opts.onTap;
    const onLongPress = opts && opts.onLongPress;
    const haptic = !opts || opts.haptic !== false;

    let timer = null;
    let fired = false;        // long-press fired → swallow the following tap
    let moved = false;        // finger scrolled → cancel everything
    let startY = 0;
    let touchHandled = false; // a touch tap just ran → ignore synthetic click

    function start(e) {
      fired = false;
      moved = false;
      if (e.touches && e.touches[0]) startY = e.touches[0].clientY;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (moved) return;
        fired = true;
        if (haptic && navigator.vibrate) { try { navigator.vibrate(HAPTIC_MS); } catch (err) {} }
        if (onLongPress) onLongPress();
      }, HOLD_MS);
    }
    function stop() { clearTimeout(timer); }
    function cancel() { clearTimeout(timer); moved = true; }

    function onTouchMove(e) {
      if (e.touches && e.touches[0] && Math.abs(e.touches[0].clientY - startY) > MOVE_TOLERANCE) {
        moved = true;
        clearTimeout(timer);
      }
    }
    function onTouchEnd() {
      const wasLongPress = fired;
      stop();
      if (moved) return;              // that was a scroll, not a tap
      if (wasLongPress) return;       // pin already handled it
      touchHandled = true;
      setTimeout(() => { touchHandled = false; }, CLICK_SUPPRESS_MS);
      if (onTap) onTap();
    }
    function onClick() {
      clearTimeout(timer);
      if (fired) return;              // long-press already handled it
      if (touchHandled) return;       // synthetic click echoing a touch tap
      if (onTap) onTap();
    }
    function onContextMenu(e) { e.preventDefault(); } // long-press shouldn't open the OS menu

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', stop);
    el.addEventListener('mouseleave', cancel);
    el.addEventListener('click', onClick);
    el.addEventListener('contextmenu', onContextMenu);

    return function unbind() {
      clearTimeout(timer);
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', cancel);
      el.removeEventListener('mousedown', start);
      el.removeEventListener('mouseup', stop);
      el.removeEventListener('mouseleave', cancel);
      el.removeEventListener('click', onClick);
      el.removeEventListener('contextmenu', onContextMenu);
    };
  }

  /**
   * Bind every match inside a container. `handlersFor(index, el)` returns the
   * same opts object `bind` takes.
   * @returns {function} unbind-all
   */
  function bindAll(host, selector, handlersFor) {
    if (!host) return () => {};
    const unbinds = Array.from(host.querySelectorAll(selector))
      .map((el, i) => bind(el, handlersFor(i, el)));
    return function unbindAll() { unbinds.forEach(u => { try { u(); } catch (e) {} }); };
  }

  return { bind, bindAll, HOLD_MS, MOVE_TOLERANCE };
})();
