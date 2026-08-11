// router (entry) for the app page. Relocated from app.js.

import { pcgwSlugToPwId } from '../lib/app-id.js?v=6159afa9';
import { renderGamePage } from './components/game-page.js?v=62bf4b28';
import { renderHomePage } from './components/home.js?v=5c701273';
import { renderSearchPage } from './components/search.js?v=091f940b';

export function getRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  // Steam ids are bare digits; catalog (non-Steam) ids are prefixed
  // (gog:<productId>, epic:<namespace>, pw_<hash>, legacy pgwiki:<slug>).
  // Match all so stub pages are reachable. pgwiki slugs may contain
  // colons of their own, hence the [^/?#]+ tail rather than a strict
  // per-store shape. Stop at the next path/query separator.
  const m = h.match(/^app\/((?:gog:|epic:)?[^/?#]+)/);
  const q = new URLSearchParams(location.search).get('q')?.trim() || '';
  if (m) return { page: 'app', appId: decodeURIComponent(m[1]), query: q };
  if (q) return { page: 'search', query: q };
  return { page: 'home', query: '' };
}


export async function route() {
  const r = getRoute();
  // #406: PCGW games moved from pgwiki:<slug> ids to short pw_<hash> ids.
  // Old bookmarks / shared links still carry the slug form -- hash it
  // client-side (same sha256/base36 derivation as the pipeline) and
  // replace the URL so the page loads under the canonical id.
  if (r.page === 'app' && r.appId.startsWith('pgwiki:')) {
    const pwId = await pcgwSlugToPwId(r.appId.slice('pgwiki:'.length));
    console.debug('[router] legacy pgwiki: URL redirected', { from: r.appId, to: pwId, source: 'pcgwSlugToPwId' });
    location.replace(`${location.pathname}${location.search}#/app/${pwId}`);
    return;
  }
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
