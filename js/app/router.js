// router (entry) for the app page. Relocated from app.js.

import { renderGamePage } from './components/game-page.js?v=295dabbd';
import { renderHomePage } from './components/home.js?v=20b49339';
import { renderSearchPage } from './components/search.js?v=598aaad1';

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
  // Hide the app.html page-header on individual game pages -- the game
  // hero already carries the title, boxart, and app id, and repeating
  // "Game Reports / Search a Steam game..." above it just wastes space.
  // Keep it visible on the landing (home) and search views where the
  // page context isn't otherwise obvious.
  const pageHeader = document.querySelector('.main-inner > .page-header');
  if (pageHeader) pageHeader.hidden = (r.page === 'app');
  if (r.page === 'app') await renderGamePage(r.appId);
  else if (r.page === 'search') await renderSearchPage(r.query);
  else await renderHomePage();
}
