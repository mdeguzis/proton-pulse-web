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

// Store pill position: 'right' (inline with rating) or 'art' (thumbnail overlay).
const STORE_PILL_POS_KEY = 'pp:store-pill-pos';
function applyStorePillPos(pos) {
  if (pos === 'art') {
    document.documentElement.setAttribute('data-store-pill-pos', 'art');
  } else {
    document.documentElement.removeAttribute('data-store-pill-pos');
  }
}
const storePillGroup = document.getElementById('opt-store-pill-pos');
if (storePillGroup) {
  const stored = localStorage.getItem(STORE_PILL_POS_KEY) || 'right';
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
