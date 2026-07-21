// Entry point for the app page: bootstraps routing and search wiring.
// (Replaces the inline bootstrap that lived at the top/bottom of app.js.)
import { route } from './router.js?v=e6357594';
import { wireSearch } from './components/search.js?v=598aaad1';

// Reset scroll on every hash navigation so a click on a card from
// halfway down a long browse list (My Library / My Wishlist) doesn't
// leave the game details view stranded mid-page. The initial page load
// runs route() below without this so browser scroll restoration wins.
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
window.addEventListener('popstate',  () => { window.scrollTo(0, 0); route(); });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireSearch);
} else {
  wireSearch();
}

route();

let __signalTooltipTimer = null;

window.__showSignalTooltip = function (icon) {
  clearTimeout(__signalTooltipTimer);
  const state = icon.getAttribute('data-tip-state') || '';
  const desc  = icon.getAttribute('data-tip-desc')  || '';
  if (!state) return;
  let t = document.getElementById('__signal_tooltip');
  if (!t) {
    t = document.createElement('div');
    t.id = '__signal_tooltip';
    t.className = 'signal-tooltip';
    document.body.appendChild(t);
  }
  t.innerHTML = `<span class="st-state">${state}</span>${desc ? `<span class="st-desc"><strong>Explanation:</strong> ${desc}</span>` : ''}`;
  t.style.display = 'block';
  const rect = icon.getBoundingClientRect();
  const vw = window.innerWidth;
  const tw = t.offsetWidth || 300;
  const th = t.offsetHeight || 48;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, vw - tw - 8));
  const topBelow = rect.bottom + 6;
  t.style.left = left + 'px';
  t.style.top  = (topBelow + th > window.innerHeight ? rect.top - th - 6 : topBelow) + 'px';
};

window.__hideSignalTooltip = function () {
  __signalTooltipTimer = setTimeout(() => {
    const t = document.getElementById('__signal_tooltip');
    if (t) t.style.display = 'none';
  }, 80);
};

// Dismiss filter panel when clicking outside it.
//
// On mobile (<= 720px) the shared modal observer in js/lib/topbar.js
// portals #filterPanel to <body> so it can rise above the topbar stacking
// context. Once portalled, the panel is no longer inside .filter-wrap --
// so a tap on the panel's own X button (or ANY of its selects, pills, or
// buttons) technically clicks "outside" .filter-wrap and this handler
// would strip .open BEFORE the X's own click handler in topbar.js could
// run. The X handler then saw portaled=false because the observer had
// already restored the panel back to el (#358 follow-up).
//
// Same fix pattern as home.js: also allow the click when it lands inside
// the panel itself. Now the panel only closes on a truly-outside click
// (tapping the report cards, the topbar, empty space, etc.).
document.addEventListener('click', function (e) {
  const panel = document.getElementById('filterPanel');
  if (!panel || !panel.classList.contains('open')) return;
  if (e.target.closest('.filter-wrap')) return;
  if (panel.contains(e.target)) return;
  panel.classList.remove('open');
});
