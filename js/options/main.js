// Entry module for options.html. Browser-local site preferences saved to
// localStorage (not tied to an account). First option: animations on/off,
// applied live here and honored site-wide by js/lib/topbar.js on every page.

import { setShowAdult, pullShowAdult, readShowAdultLocal } from '../lib/user-prefs.js?v=7b5675ef';
import { getPageSizePref, setPageSizePref, PAGE_SIZE_KEY } from '../lib/pagination-prefs.js?v=15d0747d';

const MOTION_KEY = 'proton-pulse:motion';

// Current animations state: explicit choice wins; otherwise default to ON
// unless the OS asks to reduce motion.
function animationsOn() {
  const stored = localStorage.getItem(MOTION_KEY); // 'on' | 'off' | null
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Apply live: data-motion gates CSS animations/transitions; SMIL (<animateMotion>)
// is paused/unpaused directly since CSS cannot stop it.
function applyAnimations(on) {
  const svgs = document.querySelectorAll('svg');
  console.log('[options] applyAnimations: on=' + on + ' SVGs found=' + svgs.length + ' data-motion before=' + (document.documentElement.getAttribute('data-motion') || 'unset'));
  if (on) {
    document.documentElement.setAttribute('data-motion', 'on');
    svgs.forEach((s) => { try { s.unpauseAnimations && s.unpauseAnimations(); } catch (e) { /* ignore */ } });
  } else {
    document.documentElement.setAttribute('data-motion', 'off');
    svgs.forEach((s) => { try { s.pauseAnimations && s.pauseAnimations(); } catch (e) { /* ignore */ } });
  }
  console.log('[options] applyAnimations: data-motion after=' + (document.documentElement.getAttribute('data-motion') || 'unset'));
}

const toggle = document.getElementById('opt-animations');
if (toggle) {
  const initial = animationsOn();
  console.log('[options] init: stored=' + localStorage.getItem(MOTION_KEY) + ' animationsOn=' + initial);
  toggle.checked = initial;
  toggle.addEventListener('change', () => {
    const val = toggle.checked ? 'on' : 'off';
    console.log('[options] toggle changed: saving ' + MOTION_KEY + '=' + val);
    localStorage.setItem(MOTION_KEY, val);
    applyAnimations(toggle.checked);
    console.log('[options] localStorage now:', localStorage.getItem(MOTION_KEY));
  });
}

// Trend arrow visibility. On by default. Attribute-based swap on <html>
// (data-trend-arrow="off") so every card view responds without a re-render.
const TREND_ARROW_KEY = 'pp:trend-arrow';
function applyTrendArrow(on) {
  if (on) {
    document.documentElement.removeAttribute('data-trend-arrow');
  } else {
    document.documentElement.setAttribute('data-trend-arrow', 'off');
  }
}
const trendToggle = document.getElementById('opt-trend-arrow');
if (trendToggle) {
  const stored = localStorage.getItem(TREND_ARROW_KEY);
  const initial = stored !== 'off';
  trendToggle.checked = initial;
  applyTrendArrow(initial);
  trendToggle.addEventListener('change', () => {
    const val = trendToggle.checked ? 'on' : 'off';
    localStorage.setItem(TREND_ARROW_KEY, val);
    applyTrendArrow(trendToggle.checked);
    console.log('[options] trend-arrow:', val);
  });
}

// Adult games visibility. Off by default; when off, browse views hide
// any row whose data.adult === true. Value is a simple on/off string so
// missing/malformed keys default to off (the safer state).
const adultToggle = document.getElementById('opt-show-adult');
if (adultToggle) {
  // localStorage is the immediate (zero-flash) value; for signed-in users pull
  // the account-synced value so a change made on another device is reflected.
  adultToggle.checked = readShowAdultLocal();
  pullShowAdult().then(({ changed, value }) => { if (changed) adultToggle.checked = value; });
  adultToggle.addEventListener('change', () => {
    setShowAdult(adultToggle.checked).then(({ synced }) => {
      console.log('[options] show-adult:', adultToggle.checked, 'synced-to-account:', synced);
    });
  });
}

// Store pill position. Values:
//   'right'       - inline with the rating pill in the right column
//   'art'         - overlaid on the thumbnail corner
//   'bar-right'   - chip pinned to the trailing edge of the bottom-bar layout
//   'bar-segment' - last 1/4 of the bottom bar in store color (two-tone with tier)
// bar-* values only have an effect when card-layout is 'strip'.
const STORE_PILL_POS_KEY = 'pp:store-pill-pos';
const STORE_PILL_POS_VALUES = ['right', 'art', 'art-corner', 'bar-inline', 'bar-segment'];
// Migrations: the old 'bar-right' chip variant collapsed into 'bar-segment';
// 'bar-icon' was renamed to 'bar-inline' once it learned to honor the
// store-display preference instead of always rendering the icon.
{
  const cur = localStorage.getItem(STORE_PILL_POS_KEY);
  if (cur === 'bar-right') localStorage.setItem(STORE_PILL_POS_KEY, 'bar-segment');
  else if (cur === 'bar-icon') localStorage.setItem(STORE_PILL_POS_KEY, 'bar-inline');
}
function applyStorePillPos(pos) {
  if (pos && pos !== 'right') {
    document.documentElement.setAttribute('data-store-pill-pos', pos);
  } else {
    document.documentElement.removeAttribute('data-store-pill-pos');
  }
}
// Store badge placement default is viewport-aware: desktop has room for a
// card-corner tag, mobile would lose too much title width so the bar-inline
// badge next to the rating reads better. Display defaults to text on both
// (matches topbar.js) until the round brand glyphs read consistently
// across stores.
const _IS_DESKTOP = window.matchMedia('(min-width: 760px)').matches;
const _DEFAULT_STORE_PILL_POS = _IS_DESKTOP ? 'art-corner' : 'bar-inline';
const _DEFAULT_STORE_DISPLAY  = 'text';

const storePillGroup = document.getElementById('opt-store-pill-pos');
if (storePillGroup) {
  let stored = localStorage.getItem(STORE_PILL_POS_KEY) || _DEFAULT_STORE_PILL_POS;
  if (!STORE_PILL_POS_VALUES.includes(stored)) stored = _DEFAULT_STORE_PILL_POS;
  storePillGroup.querySelectorAll('input[type="radio"]').forEach(r => {
    r.checked = r.value === stored;
    r.addEventListener('change', () => {
      if (r.checked) {
        localStorage.setItem(STORE_PILL_POS_KEY, r.value);
        applyStorePillPos(r.value);
        console.log('[options] store-pill-pos:', r.value);
      }
    });
  });
  applyStorePillPos(stored);
}

// Store display: 'text' shows the store name as a pill; 'icon' shows a small
// round monogram icon instead. Either choice combines with store-pill-pos to
// pick where the badge sits.
const STORE_DISPLAY_KEY = 'pp:store-display';
function applyStoreDisplay(mode) {
  if (mode === 'icon') {
    document.documentElement.setAttribute('data-store-display', 'icon');
  } else {
    document.documentElement.removeAttribute('data-store-display');
  }
}
const storeDisplayGroup = document.getElementById('opt-store-display');
if (storeDisplayGroup) {
  const stored = localStorage.getItem(STORE_DISPLAY_KEY) || _DEFAULT_STORE_DISPLAY;
  storeDisplayGroup.querySelectorAll('input[type="radio"]').forEach(r => {
    r.checked = r.value === stored;
    r.addEventListener('change', () => {
      if (r.checked) {
        localStorage.setItem(STORE_DISPLAY_KEY, r.value);
        applyStoreDisplay(r.value);
        console.log('[options] store-display:', r.value);
      }
    });
  });
  applyStoreDisplay(stored);
}

// Card layout: 'right' (rating pill in right column) or 'strip' (rating row
// beneath the title so long names get the full card width). Mirrors the
// store-pill-pos pattern: a single attribute on <html> drives the CSS swap.
const CARD_LAYOUT_KEY = 'pp:card-layout';
const CARD_LAYOUTS_WITH_ATTR = new Set(['strip', 'combo']);
function applyCardLayout(pos) {
  if (CARD_LAYOUTS_WITH_ATTR.has(pos)) {
    document.documentElement.setAttribute('data-card-layout', pos);
  } else {
    document.documentElement.removeAttribute('data-card-layout');
  }
  updateConditionalOptions();
}
// Disable any option labeled data-requires="card-layout=strip" when the card
// layout is not 'strip'. If the user had a bar-* store position chosen and
// switches back to the right layout, fall back to 'right' so the rendered
// card stays consistent.
function updateConditionalOptions() {
  const layout = document.documentElement.getAttribute('data-card-layout') || 'right';
  document.querySelectorAll('.option-radio[data-requires]').forEach(label => {
    const req = label.getAttribute('data-requires');
    const [key, val] = req.split('=');
    let active = false;
    if (key === 'card-layout') active = layout === val;
    label.classList.toggle('option-radio--disabled', !active);
    const input = label.querySelector('input[type="radio"]');
    if (input) input.disabled = !active;
  });
  if (layout !== 'strip') {
    const cur = localStorage.getItem(STORE_PILL_POS_KEY);
    if (cur && cur.startsWith('bar-')) {
      localStorage.setItem(STORE_PILL_POS_KEY, 'right');
      applyStorePillPos('right');
      const right = document.querySelector('#opt-store-pill-pos input[value="right"]');
      if (right) right.checked = true;
    }
  }
}
const cardLayoutGroup = document.getElementById('opt-card-layout');
if (cardLayoutGroup) {
  const stored = localStorage.getItem(CARD_LAYOUT_KEY) || 'strip';
  cardLayoutGroup.querySelectorAll('input[type="radio"]').forEach(r => {
    r.checked = r.value === stored;
    r.addEventListener('change', () => {
      if (r.checked) {
        localStorage.setItem(CARD_LAYOUT_KEY, r.value);
        applyCardLayout(r.value);
        console.log('[options] card-layout:', r.value);
      }
    });
  });
  applyCardLayout(stored);
}

// Default layout: 'list' (horizontal cards) or 'grid' (Steam-style tile
// grid). Each browse page also has its own quick toggle, but this radio
// is the persistent baseline. Shared storage key with the browse pages.
const GRID_LAYOUT_KEY = 'pp:grid-layout';
const GRID_LAYOUT_VALUES = ['list', 'grid'];
const gridLayoutGroup = document.getElementById('opt-grid-layout');
if (gridLayoutGroup) {
  let stored = localStorage.getItem(GRID_LAYOUT_KEY) || 'grid';
  if (!GRID_LAYOUT_VALUES.includes(stored)) stored = 'grid';
  gridLayoutGroup.querySelectorAll('input[type="radio"]').forEach(r => {
    r.checked = r.value === stored;
    r.addEventListener('change', () => {
      if (r.checked) {
        localStorage.setItem(GRID_LAYOUT_KEY, r.value);
        console.log('[options] grid-layout:', r.value);
      }
    });
  });
}

// Reports per page: how many cards app.html preloads per section before "Load
// more". Stored as a string number; app.html reads it on load. Default 50.
const LOAD_COUNT_KEY = 'pp:load-count';
const LOAD_COUNTS = ['50', '100', '150', '200'];
const loadCountGroup = document.getElementById('opt-load-count');
if (loadCountGroup) {
  const stored = LOAD_COUNTS.includes(localStorage.getItem(LOAD_COUNT_KEY)) ? localStorage.getItem(LOAD_COUNT_KEY) : '50';
  loadCountGroup.querySelectorAll('input[type="radio"]').forEach(r => {
    r.checked = r.value === stored;
    r.addEventListener('change', () => {
      if (r.checked) {
        localStorage.setItem(LOAD_COUNT_KEY, r.value);
        console.log('[options] load-count:', r.value);
      }
    });
  });
}

// Home library pagination: mobile/desktop tiles-per-page and auto-load.
// All three fields live under one JSON key so the pref module can read
// them coherently. Changes take effect on the next home render.
const pageSizeMobile = document.getElementById('opt-page-size-mobile');
const pageSizeDesktop = document.getElementById('opt-page-size-desktop');
const pageSizeAutoLoad = document.getElementById('opt-page-size-auto-load');
if (pageSizeMobile && pageSizeDesktop && pageSizeAutoLoad) {
  const cur = getPageSizePref();
  pageSizeMobile.value = String(cur.mobile);
  pageSizeDesktop.value = String(cur.desktop);
  pageSizeAutoLoad.checked = cur.autoLoad;
  const commitMobile = () => {
    const n = parseInt(pageSizeMobile.value, 10);
    if (Number.isFinite(n) && n > 0) setPageSizePref({ mobile: n });
  };
  const commitDesktop = () => {
    const n = parseInt(pageSizeDesktop.value, 10);
    if (Number.isFinite(n) && n > 0) setPageSizePref({ desktop: n });
  };
  pageSizeMobile.addEventListener('change', commitMobile);
  pageSizeDesktop.addEventListener('change', commitDesktop);
  pageSizeAutoLoad.addEventListener('change', () => {
    setPageSizePref({ autoLoad: pageSizeAutoLoad.checked });
  });
}

// Reset to defaults: drop every browser-local preference key this page owns
// then reload, so the controls and the page re-evaluate from system
// defaults (OS reduced-motion, no card-layout attribute, etc). The stale
// pp:card-badges key from the earlier "Game page tags" toggle is included
// so a reset clears it too; the app no longer reads it.
const resetBtn = document.getElementById('opt-reset');
if (resetBtn) {
  const RESET_KEYS = [MOTION_KEY, STORE_PILL_POS_KEY, STORE_DISPLAY_KEY, CARD_LAYOUT_KEY, GRID_LAYOUT_KEY, LOAD_COUNT_KEY, PAGE_SIZE_KEY, 'pp:card-badges'];
  resetBtn.addEventListener('click', () => {
    if (!confirm('Reset all site preferences on this device to their defaults?')) return;
    RESET_KEYS.forEach(k => localStorage.removeItem(k));
    console.log('[options] cleared preferences:', RESET_KEYS);
    window.location.reload();
  });
}
