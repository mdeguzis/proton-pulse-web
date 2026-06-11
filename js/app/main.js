// Entry point for the app page: bootstraps routing and search wiring.
// (Replaces the inline bootstrap that lived at the top/bottom of app.js.)
import { route } from './router.js?v=048cb59b';
import { wireSearch } from './components/search.js?v=05aa4b5a';

window.addEventListener('hashchange', () => route());
window.addEventListener('popstate', () => route());

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireSearch);
} else {
  wireSearch();
}

route();
