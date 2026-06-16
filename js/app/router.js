// router (entry) for the app page. Relocated from app.js.

import { renderGamePage } from './components/game-page.js?v=c9a5ca1b';
import { renderHomePage } from './components/home.js?v=3d28de72';
import { renderSearchPage } from './components/search.js?v=992c02ad';

export function getRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const m = h.match(/^app\/(\d+)/);
  const q = new URLSearchParams(location.search).get('q')?.trim() || '';
  if (m) return { page: 'app', appId: m[1], query: q };
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
