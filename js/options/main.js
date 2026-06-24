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

// Store pill preference: show/hide the store badge on game cards site-wide.
const STORE_PILL_KEY = 'pp:store-pill';
function applyStorePill(on) {
  if (on) {
    document.documentElement.removeAttribute('data-store-pill');
  } else {
    document.documentElement.setAttribute('data-store-pill', 'off');
  }
}
const storePillToggle = document.getElementById('opt-store-pill');
if (storePillToggle) {
  const stored = localStorage.getItem(STORE_PILL_KEY);
  const on = stored !== 'off';
  storePillToggle.checked = on;
  applyStorePill(on);
  storePillToggle.addEventListener('change', () => {
    const val = storePillToggle.checked ? 'on' : 'off';
    localStorage.setItem(STORE_PILL_KEY, val);
    applyStorePill(storePillToggle.checked);
    console.log('[options] store-pill:', val);
  });
}
