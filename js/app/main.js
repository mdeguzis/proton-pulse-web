// Entry point for the app page: bootstraps routing and search wiring.
// (Replaces the inline bootstrap that lived at the top/bottom of app.js.)
import { route } from './router.js?v=c341edb8';
import { wireSearch } from './components/search.js?v=6322780f';

window.addEventListener('hashchange', () => route());
window.addEventListener('popstate', () => route());

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireSearch);
} else {
  wireSearch();
}

route();

// Dismiss signal popup and filter panel when clicking outside them.
document.addEventListener('click', function (e) {
  if (!e.target.closest('.signal-icon')) {
    document.getElementById('__signal_popup')?.classList.remove('visible');
  }
  if (!e.target.closest('.filter-wrap')) {
    document.getElementById('filterPanel')?.classList.remove('open');
  }
});
