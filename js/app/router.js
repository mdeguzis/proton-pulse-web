// router (entry) for the app page. Relocated from app.js.

import { renderGamePage } from './components/game-page.js?v=03531fdb';
import { renderHomePage } from './components/home.js?v=1c0762cf';
import { renderSearchPage } from './components/search.js?v=50308c43';

export function getRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  // Steam ids are bare digits; catalog (non-Steam) ids are prefixed
  // (gog:<productId>, epic:<namespace>). Match all three so GOG/Epic stub
  // pages are reachable. Stop at the next path/query separator.
  const m = h.match(/^app\/((?:gog:|epic:)?[^/?#]+)/);
  const q = new URLSearchParams(location.search).get('q')?.trim() || '';
  if (m) return { page: 'app', appId: decodeURIComponent(m[1]), query: q };
  if (q) return { page: 'search', query: q };
  return { page: 'home', query: '' };
}


export async function route() {
  const r = getRoute();
  const routeSearchInput = document.getElementById('search');
  if (routeSearchInput) {
    routeSearchInput.value = r.page === 'search' ? r.query : '';
  }
  if (r.page === 'app') await renderGamePage(r.appId);
  else if (r.page === 'search') await renderSearchPage(r.query);
  else await renderHomePage();
}
