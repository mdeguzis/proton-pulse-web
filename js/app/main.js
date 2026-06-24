// Entry point for the app page: bootstraps routing and search wiring.
// (Replaces the inline bootstrap that lived at the top/bottom of app.js.)
import { route } from './router.js?v=422a5ed0';
import { wireSearch } from './components/search.js?v=36738329';

window.addEventListener('hashchange', () => route());
window.addEventListener('popstate', () => route());

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
document.addEventListener('click', function (e) {
  if (!e.target.closest('.filter-wrap')) {
    document.getElementById('filterPanel')?.classList.remove('open');
  }
});
