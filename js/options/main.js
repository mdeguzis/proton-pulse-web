// Entry module for options.html. Browser-local site preferences saved to
// localStorage (not tied to an account). First option: animations on/off,
// applied live here and honored site-wide by js/lib/topbar.js on every page.

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
    document.documentElement.removeAttribute('data-motion');
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

// Store pill position. Values:
//   'right'       - inline with the rating pill in the right column
//   'art'         - overlaid on the thumbnail corner
//   'bar-right'   - chip pinned to the trailing edge of the bottom-bar layout
//   'bar-segment' - last 1/4 of the bottom bar in store color (two-tone with tier)
// bar-* values only have an effect when card-layout is 'strip'.
const STORE_PILL_POS_KEY = 'pp:store-pill-pos';
const STORE_PILL_POS_VALUES = ['right', 'art', 'art-corner', 'bar-segment'];
// One-time migration from the dropped 'bar-right' chip variant to the split.
if (localStorage.getItem(STORE_PILL_POS_KEY) === 'bar-right') {
  localStorage.setItem(STORE_PILL_POS_KEY, 'bar-segment');
}
function applyStorePillPos(pos) {
  if (pos && pos !== 'right') {
    document.documentElement.setAttribute('data-store-pill-pos', pos);
  } else {
    document.documentElement.removeAttribute('data-store-pill-pos');
  }
}
const storePillGroup = document.getElementById('opt-store-pill-pos');
if (storePillGroup) {
  let stored = localStorage.getItem(STORE_PILL_POS_KEY) || 'right';
  if (!STORE_PILL_POS_VALUES.includes(stored)) stored = 'right';
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
  const stored = localStorage.getItem(STORE_DISPLAY_KEY) || 'text';
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
function applyCardLayout(pos) {
  if (pos === 'strip') {
    document.documentElement.setAttribute('data-card-layout', 'strip');
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
  const stored = localStorage.getItem(CARD_LAYOUT_KEY) || 'right';
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
