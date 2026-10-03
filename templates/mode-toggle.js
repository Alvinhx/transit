/**
 * mode-toggle.js — floating segmented pill for switching root views (main-next)
 *
 * BEHAVES like a bottom nav (peer destinations, instant switching, each view
 * keeps its own state, no back stack) but LOOKS like a floating control: a
 * two-segment pill overlaid bottom-right.
 *
 * WHY A SEGMENTED PILL AND NOT A SINGLE FAB
 * A FAB that swaps its icon is ambiguous for a two-state switch — a map icon can
 * read either as "you are on the map" or "tap to go to the map", and people guess
 * wrong. Showing both destinations with the active one highlighted removes the
 * ambiguity, and the tap target is unmistakable.
 *
 * WHY IT FLOATS INSTEAD OF BEING A REAL BOTTOM BAR
 * A real bar would consume viewport height, and the detail page's phase-3 map
 * framing is built on viewport height (its focus band is [H/6, H/2], whose bottom
 * edge is meant to coincide with the sheet's top edge). Overlaying keeps H
 * unchanged, so none of that geometry has to be touched.
 *
 * LAYERING — it has to live ABOVE the sheet. In the Map+Sheet page the sheet is
 * z2 while the controls overlay is only z1, so a bottom-right control placed in
 * that overlay would be hidden behind the sheet at every snap. The toggle is
 * therefore app-level chrome at z550: above the page layer (500) but below pushed
 * pages like the alert list (600), which should cover it.
 *
 * Usage:
 *   const toggle = ModeToggle.create({
 *     value: 'nearby',
 *     segments: [
 *       { id: 'nearby',  label: 'Nearby',  icon: 'near_me' },
 *       { id: 'station', label: 'Station', icon: 'departure_board' },
 *     ],
 *     onChange: (id) => { ... },
 *   });
 *   toggle.mount(document.body);
 *   toggle.setValue('station');   // reflect external state, does NOT fire onChange
 *   toggle.setVisible(false);     // hide while a detail page is open
 */

const ModeToggle = (function () {
  'use strict';

  function create(opts) {
    opts = opts || {};
    const segments = (opts.segments || []).slice();
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    let _value = opts.value || (segments[0] && segments[0].id) || '';
    let _mounted = false;

    const root = document.createElement('div');
    root.className = 'mt-toggle';
    root.setAttribute('role', 'tablist');
    root.setAttribute('aria-label', 'View mode');

    const buttons = {};
    for (const seg of segments) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mt-seg';
      b.dataset.mode = seg.id;
      b.setAttribute('role', 'tab');
      b.innerHTML =
        (seg.icon ? `<span class="material-icons mt-ico">${seg.icon}</span>` : '') +
        `<span class="mt-label">${seg.label || seg.id}</span>`;
      b.addEventListener('click', () => {
        if (_value === seg.id) return;      // already here — don't churn
        setValue(seg.id);
        onChange(seg.id);
      });
      root.appendChild(b);
      buttons[seg.id] = b;
    }

    function _paint() {
      for (const id in buttons) {
        const on = id === _value;
        buttons[id].classList.toggle('is-active', on);
        buttons[id].setAttribute('aria-selected', on ? 'true' : 'false');
        // Only the active tab stays in the tab order (standard tablist pattern).
        buttons[id].tabIndex = on ? 0 : -1;
      }
    }

    /** Set the shown value WITHOUT firing onChange (for syncing to app state). */
    function setValue(id) {
      if (!buttons[id]) return;
      _value = id;
      _paint();
    }

    function getValue() { return _value; }
    function setVisible(v) { root.classList.toggle('mt-hidden', !v); }

    function mount(parent) {
      if (_mounted) return api;
      _mounted = true;
      _paint();
      (parent || document.body).appendChild(root);
      return api;
    }

    function unmount() {
      if (root.parentNode) root.remove();
      _mounted = false;
    }

    const api = { root, setValue, getValue, setVisible, mount, unmount };
    return api;
  }

  return { create };
})();
