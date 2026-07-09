// home (components) for the app page. Relocated from app.js.

import { fetchRecentPulseReports } from '../api/reports.js?v=003f23c0';
import { loadSearchIndex, searchIndex } from './search.js?v=598aaad1';
import { SB_KEY, SB_URL, isNonSteamAppId, appTypeFromAppId, storeLabel } from '../config.js?v=f9591262';
import { daysAgo, latestPerApp } from '../utils.js?v=c7e1268c';
import { renderGameCard } from '../lib/card.js?v=5642a459';
import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';
import { padTileRows, watchTileRerender, pageSizeForFullRows, targetRowsForViewport } from '../../lib/tile-pad.js?v=ec823ae7';
import { filterAdult } from '../../lib/adult-filter.js?v=e4e9d845';
import { readActive as _readPillGroup, wireGroup as _wirePillGroup } from '../lib/filter-group.js?v=dc2c1e0a';
import { renderHomeLibraryChart } from './home-library-chart.js?v=c7e8a2d8';
import { getMyLibraryAppIds } from '../lib/user-library.js?v=1d8e72df';
import { pageNavHtml, wirePageNav } from '../lib/page-nav.js?v=2cdc55e4';
import { synthesizeMyLibrary } from '../lib/my-library-synth.js?v=58a32db3';

const LOAD_COUNT_KEY = 'pp:load-count';
const LOAD_COUNTS = [50, 100, 150, 200];
// How many report cards to preload per section before "Load more". Set on the
// site options (gear) page; defaults to 50.
function _loadCount() {
  const n = parseInt(localStorage.getItem(LOAD_COUNT_KEY) || '', 10);
  return LOAD_COUNTS.includes(n) ? n : 50;
}
const KNOWN_TIERS = new Set(['platinum', 'gold', 'silver', 'bronze', 'borked']);
const TIER_SCORE = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Card tier prop: only pass a real rated tier. Unrated/pending returns undefined
// so the card shows the "No Rating" badge instead of an ugly "PENDING" pill.
function _cardTier(t) {
  const x = String(t || '').toLowerCase();
  return KNOWN_TIERS.has(x) ? x : undefined;
}

function _sortReports(reports, sort) {
  const copy = [...reports];
  if (sort === 'best') {
    copy.sort((a, b) =>
      (TIER_SCORE[b.tier] || 0) - (TIER_SCORE[a.tier] || 0) ||
      (b.lastReportDate || '').localeCompare(a.lastReportDate || ''));
  } else if (sort === 'worst') {
    copy.sort((a, b) =>
      (TIER_SCORE[a.tier] || 99) - (TIER_SCORE[b.tier] || 99) ||
      (b.lastReportDate || '').localeCompare(a.lastReportDate || ''));
  } else if (sort === 'count') {
    copy.sort((a, b) =>
      ((b.protondbCount || 0) + (b.pulseCount || 0)) -
      ((a.protondbCount || 0) + (a.pulseCount || 0)));
  } else if (sort === 'alpha') {
    copy.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
  } else if (sort === 'alpha_desc') {
    copy.sort((a, b) => String(b.title || '').localeCompare(String(a.title || ''), undefined, { sensitivity: 'base' }));
  }
  return copy;
}

// Tier filter is multi-select. `sel` is a Set of chosen values. An empty set or
// one containing 'all' means no filtering. Within the set values are OR'd:
// 'rated' matches any KNOWN_TIER, 'unrated' matches anything that is not a known
// tier (pending / no reports), and a specific tier matches that tier exactly.
function _filterByTier(reports, sel) {
  if (!sel || sel.size === 0 || sel.has('all')) return reports;
  return reports.filter(r => {
    const t = r.tier;
    const isRated = KNOWN_TIERS.has(t);
    for (const v of sel) {
      if (v === 'rated' && isRated) return true;
      if (v === 'unrated' && !isRated) return true;
      if (v === t) return true;
    }
    return false;
  });
}

// Source filter is multi-select. `sel` is a Set of chosen values. Empty or 'all'
// means no filtering. Values are OR'd: a report passes if it has any of the
// selected sources.
function _filterByType(reports, sel) {
  if (!sel || sel.size === 0 || sel.has('all')) return reports;
  return reports.filter(r => {
    for (const v of sel) {
      if (v === 'protondb' && (r.protondbCount || 0) > 0) return true;
      if (v === 'pulse' && (r.pulseCount || 0) > 0) return true;
    }
    return false;
  });
}

// Store filter is multi-select. `sel` is a Set of chosen values ('steam' / 'gog'
// / 'epic'). Empty or 'all' means no filtering. A game's store comes from its
// appType field (pipeline) or is derived from the canonical app id prefix.
function _filterByStore(reports, sel) {
  if (!sel || sel.size === 0 || sel.has('all')) return reports;
  return reports.filter(r => sel.has(r.appType || appTypeFromAppId(r.appId)));
}

// Library filter (#199 follow-up). When "mine" is selected, only include
// entries whose appId is in the signed-in user's cached Steam library.
// libraryAppIds is a Set<number>. Empty / null means no filtering.
function _filterByLibrary(reports, sel, libraryAppIds) {
  if (!sel || sel.size === 0 || sel.has('all')) return reports;
  if (!libraryAppIds || libraryAppIds.size === 0) return [];
  return reports.filter(r => libraryAppIds.has(Number(r.appId)));
}

// Text filter: case-insensitive substring match on the game title. Empty/blank
// text means no filtering. Trims so a stray space does not hide everything.
function _filterByText(reports, text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return reports;
  return reports.filter(r => String(r.title || '').toLowerCase().includes(q));
}

// Pill-group helpers (mutual-exclusion Active + a11y) live in
// js/app/lib/filter-group.js so index/main.js and any future page can
// reuse them. #96.

function _popularSub(g) {
  const total = (g.protondbCount || 0) + (g.pulseCount || 0);
  const countPart = total > 0 ? `${total.toLocaleString()} report${total === 1 ? '' : 's'}` : '';
  const datePart = g.lastReportDate ? `latest: ${g.lastReportDate}` : '';
  return [countPart, datePart].filter(Boolean).join(' \u00b7 ');
}

function _loadMoreBtn(sectionId) {
  return `<button class="load-more-btn" data-section="${sectionId}">Load more</button>`;
}

function _allShownNote(count) {
  return `<p class="home-results-note">Showing all ${count} result${count === 1 ? '' : 's'}</p>`;
}

// Trend direction lookup by appId. Populated from search-index column 9
// after loadSearchIndex resolves. Empty for older payloads that predate the
// trend column so cards render neutral (no arrow) until the pipeline catches up.
let _trendByAppId = null;
function _lookupTrend(appId) {
  if (!_trendByAppId || appId == null) return '';
  return _trendByAppId.get(String(appId)) || '';
}
function _buildTrendMap() {
  if (_trendByAppId) return;
  _trendByAppId = new Map();
  if (!Array.isArray(searchIndex)) return;
  for (const row of searchIndex) {
    if (!Array.isArray(row) || row.length < 10) continue;
    const t = row[9];
    if (t === 'improving' || t === 'declining') _trendByAppId.set(String(row[0]), t);
  }
}

// Replaced-by lookup by appId. Search-index column 10 (added by
// enrich_search_index_with_delisted); empty for older payloads or games that
// were never replaced. Powers the REPLACED badge on cards (#199 follow-up).
let _replacedByAppId = null;
function _lookupReplacedBy(appId) {
  if (!_replacedByAppId || appId == null) return '';
  return _replacedByAppId.get(String(appId)) || '';
}
function _buildReplacedByMap() {
  if (_replacedByAppId) return;
  _replacedByAppId = new Map();
  if (!Array.isArray(searchIndex)) return;
  for (const row of searchIndex) {
    if (!Array.isArray(row) || row.length < 11) continue;
    const rb = row[10];
    if (rb) _replacedByAppId.set(String(row[0]), String(rb));
  }
}

function _recentCardHtml(r) {
  // recent-reports.json carries appType ('gog'|'epic'|'steam') from the pipeline.
  // Fall back to deriving it from the id so non-Steam games are labeled even on
  // older payloads that predate the appType field.
  const appType = r.appType || appTypeFromAppId(r.appId);
  return renderGameCard({
    href: `#/app/${r.appId}`,
    appId: r.appId,
    title: r.title,
    sub: _popularSub(r),
    tier: _cardTier(r.tier),
    storePill: storeLabel(appType),
    trend: _lookupTrend(r.appId),
    replacedBy: _lookupReplacedBy(r.appId),
  });
}

export async function renderHomePage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading recent reports...</div>';
  // Row target is viewport-aware: 4 rows on desktop, 5 on mobile (see
  // targetRowsForViewport in lib/tile-pad.js). The old fixed preload
  // count setting (LOAD_COUNTS) is retained in localStorage for
  // backwards compat but no longer drives paging.
  console.debug('[browse] preload target rows', { rows: targetRowsForViewport() });
  try {
    const [recentUrl, mostPlayedUrl] = await Promise.all([
      dataUrl('recent-reports.json'),
      dataUrl('most_played.json'),
    ]);
    const [recentResp, mostPlayedResp] = await Promise.all([
      fetch(recentUrl).catch(() => null),
      fetch(mostPlayedUrl).catch(() => null),
      loadSearchIndex().catch(() => null),
    ]);

    // searchIndex is available now that loadSearchIndex resolved (Promise.all
     // above). Build the appId -> trend map once so every card renderer below
     // gets the arrow via a single Map.get instead of re-scanning the array.
    _trendByAppId = null;
    _replacedByAppId = null;
    _buildTrendMap();
    _buildReplacedByMap();

    let allRecentReports = [];
    if (recentResp && recentResp.ok) {
      allRecentReports = await recentResp.json().catch(() => []);
    }

    const seenIds = new Set(allRecentReports.map(r => String(r.appId)));
    let ratedGames = [], unratedGames = [];
    if (mostPlayedResp && mostPlayedResp.ok) {
      const all = (await mostPlayedResp.json().catch(() => [])).filter(g => !seenIds.has(String(g.appId)));
      ratedGames = all.filter(g => KNOWN_TIERS.has(String(g.rating || '').toLowerCase()));
      unratedGames = all.filter(g => ['pending', 'catalog'].includes(String(g.rating || '').toLowerCase()));
    }

    // When the profile "View my games" link deep-links here it lands with
    // ?filter=mine. Detect that up front so the page can identify itself
    // as "My Library" instead of the generic browse view. The filter pill
    // itself is still activated below in _restoreFilters.
    const _urlFilter = new URLSearchParams(window.location.search).get('filter');
    const _isMyLibrary = _urlFilter === 'mine';
    // The app.html shell owns a static "Game Reports" page-header. Hide it
    // in library mode so the only visible title is our own "My Library"
    // header injected below; otherwise the page shows two competing titles.
    const _appPageHeader = document.querySelector('.main-inner > .page-header');
    if (_appPageHeader) _appPageHeader.hidden = _isMyLibrary;
    el.innerHTML = `
      ${_isMyLibrary ? `
        <div class="home-page-header" id="home-page-header">
          <div class="home-page-eyebrow">Your Steam library</div>
          <h1 class="home-page-title">My Library</h1>
        </div>` : ''}
      <div class="home-filter-bar">
        <div class="home-filter-left">
        <div class="filter-wrap" id="home-filter-wrap">
          <button class="filter-toggle-btn" id="home-filter-toggle" type="button" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.72-4.8 5.74-7.39C20.25 4.95 19.8 4 18.95 4H5.04C4.2 4 3.74 4.95 4.25 5.61z"/></svg>
            Filters<span class="filter-badge" id="home-filter-badge" hidden></span>
          </button>
          <div class="filter-panel filter-panel--stack" id="home-filter-panel">
            <div class="filter-item filter-item--mobile-only">
              <label class="home-filter-label" for="home-text-filter-mobile">Filter loaded list</label>
              <input id="home-text-filter-mobile" class="home-filter-text home-filter-text--in-panel" type="search" placeholder="Type to filter" autocomplete="off" />
            </div>
            <div class="filter-item">
              <label class="home-filter-label" for="home-sort-select">Sort</label>
              <select id="home-sort-select" class="home-filter-select">
                <option value="recent">Recent</option>
                <option value="best">Best Tier</option>
                <option value="worst">Worst Tier</option>
                <option value="count">Most Reported</option>
                <option value="alpha">A-Z (Title)</option>
                <option value="alpha_desc">Z-A (Title)</option>
              </select>
            </div>
            <div class="pg-filter-group" id="home-store-checks">
              <span class="pg-filter-group-label">Store</span>
              <button class="pg-filter pg-filter--active" type="button" data-value="all">All</button>
              <button class="pg-filter" type="button" data-value="steam">Steam</button>
              <button class="pg-filter" type="button" data-value="gog">GOG</button>
              <button class="pg-filter" type="button" data-value="epic">Epic</button>
            </div>
            <div class="pg-filter-group" id="home-tier-checks">
              <span class="pg-filter-group-label">Tier</span>
              <button class="pg-filter pg-filter--active" type="button" data-value="all">All</button>
              <button class="pg-filter" type="button" data-value="rated">Rated</button>
              <button class="pg-filter" type="button" data-value="unrated">Not Rated Yet</button>
              <button class="pg-filter" type="button" data-value="platinum">Platinum</button>
              <button class="pg-filter" type="button" data-value="gold">Gold</button>
              <button class="pg-filter" type="button" data-value="silver">Silver</button>
              <button class="pg-filter" type="button" data-value="bronze">Bronze</button>
              <button class="pg-filter" type="button" data-value="borked">Borked</button>
            </div>
            <div class="pg-filter-group" id="home-source-checks">
              <span class="pg-filter-group-label">Source</span>
              <button class="pg-filter pg-filter--active" type="button" data-value="all">All</button>
              <button class="pg-filter" type="button" data-value="protondb">ProtonDB</button>
              <button class="pg-filter" type="button" data-value="pulse">Pulse</button>
            </div>
            <div class="pg-filter-group" id="home-library-checks">
              <span class="pg-filter-group-label">Library</span>
              <button class="pg-filter pg-filter--active" type="button" data-value="all">All</button>
              <button class="pg-filter" type="button" data-value="mine" title="Only games in your Steam library (requires sign-in and a synced library)">My games</button>
            </div>
            <div class="filter-panel-footer filter-panel-footer--stack">
              <button class="filter-save-btn" id="home-filter-persist" type="button" aria-pressed="false">Save filters</button>
              <button class="filter-clear-btn" id="home-filter-clear" type="button">Clear filters</button>
            </div>
          </div>
        </div>
        <input id="home-text-filter" class="home-filter-text" type="search" placeholder="Filter loaded list" autocomplete="off" />
        </div>
        <div class="home-view-controls">
          <div class="home-view-controls-row">
            <div class="home-size-toggle" id="home-size-toggle" title="Card size">
              <button class="home-size-btn" data-size="sm" type="button" title="Small cards">S</button>
              <button class="home-size-btn" data-size="md" type="button" title="Medium cards">M</button>
              <button class="home-size-btn" data-size="lg" type="button" title="Large cards">L</button>
              <button class="home-size-btn home-size-btn--desktop-only" data-size="xl" type="button" title="Extra large cards">XL</button>
            </div>
            <div class="home-layout-toggle">
              <button class="home-layout-btn" data-layout="list" title="List of horizontal cards">List</button>
              <button class="home-layout-btn active" data-layout="grid" title="Grid of Steam-style tiles (default)">Grid</button>
            </div>
          </div>
        </div>
      </div>
      <div id="home-library-chart-mount"></div>
      <div id="recent-section">
        <div class="section-label-row" style="margin-bottom:10px">
          <span class="section-label" id="recent-section-label" style="margin:0">${_isMyLibrary ? 'My Library -- Recent Reports' : 'Recent Reports'}</span>
          <span class="section-count" id="recent-count"></span>
        </div>
        <div class="page-nav" id="page-nav-recent" hidden></div>
        <div class="cards" id="cards-recent"></div>
        <div id="load-more-recent"></div>
      </div>
      <div class="section-label-row" style="margin-top:24px;margin-bottom:10px">
        <span class="section-label" id="popular-section-label" style="margin:0">${_isMyLibrary ? 'My Library -- Popular' : 'Popular on Steam'}</span>
        <span class="section-count" id="popular-count"></span>
      </div>
      <div class="page-nav" id="page-nav-popular" hidden></div>
      <div class="cards" id="cards-popular"></div>
      <div id="load-more-popular"></div>`;

    let currentSort = 'recent';
    let textFilter = '';       // title substring filter; '' => no text filtering
    let tierSel = new Set();   // empty => all tiers
    let sourceSel = new Set(); // empty => all sources
    let storeSel = new Set();  // empty => all stores
    let librarySel = new Set(); // empty => all; 'mine' => only owned games (#199)
    let libraryAppIds = null;  // cached Set<number>; lazily loaded on first "mine" use
    let currentLayout = 'grid';

    // The previous super-condensed list-row renderer is gone -- the two
    // layouts now are 'list' (horizontal cards from _recentCardHtml /
    // popular item) and 'grid' (the same cards re-flowed into Steam-
    // style vertical tiles by CSS via .home-cards-tile-mode).

    function _popularSectionLabel(sel) {
      if (!sel || sel.size === 0 || sel.has('all') || sel.has('steam')) return 'Popular on Steam';
      if (sel.size === 1 && sel.has('gog')) return 'Popular GOG Games';
      if (sel.size === 1 && sel.has('epic')) return 'Popular Epic Games';
      return 'Popular Games';
    }

    function applyPopularFilters() {
      const labelEl = document.getElementById('popular-section-label');
      if (labelEl) labelEl.textContent = _popularSectionLabel(storeSel);

      // When filtering to non-Steam stores only, pull from the search index (which
      // covers GOG/Epic catalog entries) instead of most_played.json (Steam only).
      const wantNonSteamOnly = storeSel.size > 0 && !storeSel.has('all') && !storeSel.has('steam');
      let asReports;
      if (wantNonSteamOnly) {
        // Build a title->peak map from the Steam most-played list so we can rank
        // non-Steam titles by Steam popularity when the name matches.
        const steamPeakByTitle = new Map(
          [...ratedGames, ...unratedGames].map(g => [normTitle(g.title), g.peak || 0])
        );
        asReports = (searchIndex || [])
          .filter(row => row[5] && storeSel.has(row[5]))
          .sort((a, b) => {
            const peakA = steamPeakByTitle.get(normTitle(a[1])) || 0;
            const peakB = steamPeakByTitle.get(normTitle(b[1])) || 0;
            if (peakB !== peakA) return peakB - peakA;
            const countA = (a[3] || 0) + (a[4] || 0);
            const countB = (b[3] || 0) + (b[4] || 0);
            if (countB !== countA) return countB - countA;
            return (a[1] || '').localeCompare(b[1] || '');
          })
          .map(row => {
            const t = String(row[2] || '').toLowerCase();
            return {
              appId: row[0], title: row[1],
              tier: KNOWN_TIERS.has(t) ? t : 'pending',
              protondbCount: row[3] || 0, pulseCount: row[4] || 0, appType: row[5],
            };
          });
      } else {
        // Build the candidate pool from the tier selection. Rated games show by
        // default; the unrated catalog games (no reports yet) only appear when
        // "Not Rated Yet" (or "All") is selected, so they stay hidden otherwise.
        const wantUnrated = tierSel.has('all') || tierSel.has('unrated');
        const onlyUnrated = tierSel.size === 1 && tierSel.has('unrated');
        const pool = [
          ...(onlyUnrated ? [] : ratedGames),
          ...(wantUnrated ? unratedGames : []),
        ];
        // Map rating -> tier ('pending' for unrated) so the shared Set-based tier
        // filter treats them consistently with recent reports.
        asReports = pool.map(g => {
          const t = String(g.rating || '').toLowerCase();
          return { ...g, tier: KNOWN_TIERS.has(t) ? t : 'pending' };
        });
      }
      const filtered = filterAdult(_filterByText(_filterByLibrary(_filterByStore(_filterByType(_filterByTier(asReports, tierSel), sourceSel), storeSel), librarySel, libraryAppIds), textFilter));
      const cardsEl = document.getElementById('cards-popular');
      const loadMoreEl = document.getElementById('load-more-popular');
      if (!cardsEl) return;
      if (!filtered.length) {
        cardsEl.innerHTML = '<div class="state-box">No games match the current filters.</div>';
        _updateShownCount('popular-count', cardsEl, 0);
        if (loadMoreEl) loadMoreEl.innerHTML = '';
        return;
      }
      let popularPage = 1;
      let popularPageSize = pageSizeForFullRows(cardsEl, targetRowsForViewport());
      const renderPopular = () => {
        popularPageSize = pageSizeForFullRows(cardsEl, targetRowsForViewport());
        const totalPages = Math.max(1, Math.ceil(filtered.length / Math.max(1, popularPageSize)));
        if (popularPage > totalPages) popularPage = totalPages;
        if (popularPage < 1) popularPage = 1;
        const start = (popularPage - 1) * popularPageSize;
        const end = start + popularPageSize;
        const windowRows = filtered.slice(start, end);
        cardsEl.innerHTML = windowRows.map(_popularItemHtml).join('');
        const isLastPage = popularPage >= totalPages;
        padTileRows(cardsEl, { tileSelector: '.game-card', hasMore: !isLastPage });
        _updateShownCount('popular-count', cardsEl, filtered.length);
        _renderPageNavFor('page-nav-popular', popularPage, totalPages, (n) => {
          if (n === popularPage) return;
          popularPage = n;
          renderPopular();
        });
        if (loadMoreEl) loadMoreEl.innerHTML = '';
      };
      renderPopular();
      requestAnimationFrame(() => {
        const nextSize = pageSizeForFullRows(cardsEl, targetRowsForViewport());
        if (nextSize !== popularPageSize) renderPopular();
      });
      watchTileRerender(cardsEl, renderPopular);
    }

    // Render a popular game as a card. Both layouts use the same markup;
    // CSS reshapes it for the tile grid mode.
    function _popularItemHtml(g) {
      return renderGameCard({
        href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
        title: g.title,
        sub: g.tier === 'pending' ? 'No reports yet · be the first' : _popularSub(g),
        tier: _cardTier(g.tier), storePill: storeLabel(g.appType || appTypeFromAppId(g.appId)),
        trend: _lookupTrend(g.appId),
      });
    }

    // Section count next to the label, e.g. "50 of 714". Reads only real
    // tiles (skipping fillers) so the number lines up with what the user
    // sees. Hidden when there is nothing to show.
    function _updateShownCount(countId, cardsEl, total) {
      const c = document.getElementById(countId);
      if (!c) return;
      const loaded = cardsEl ? cardsEl.querySelectorAll(':scope .game-card:not(.tile-filler)').length : 0;
      c.textContent = total ? `${loaded} of ${total}` : '';
    }
    function _renderPageNavFor(navId, currentPage, totalPages, onJump) {
      const nav = document.getElementById(navId);
      if (!nav) return;
      const html = pageNavHtml(currentPage, totalPages);
      nav.innerHTML = html;
      nav.hidden = !html;
      wirePageNav(nav, onJump);
    }

    function applyRecentFilters() {
      const filtered = filterAdult(_filterByText(_filterByLibrary(_filterByStore(_filterByType(_filterByTier(_sortReports(allRecentReports, currentSort), tierSel), sourceSel), storeSel), librarySel, libraryAppIds), textFilter));
      console.debug('[browse] applyRecentFilters filtered', {
        source: 'applyRecentFilters',
        allRecentReports: allRecentReports.length,
        filtered: filtered.length,
        librarySelSize: librarySel.size,
        librarySelValues: [...librarySel],
        libraryAppIdsSize: libraryAppIds ? libraryAppIds.size : null,
        tierSelSize: tierSel.size,
        sourceSelSize: sourceSel.size,
        storeSelSize: storeSel.size,
        textFilterLen: textFilter.length,
        currentSort,
      });
      const sectionEl = document.getElementById('recent-section');
      const cardsEl = document.getElementById('cards-recent');
      const loadMoreEl = document.getElementById('load-more-recent');
      // Hide the whole recent section when empty so there's no blank state box.
      if (sectionEl) sectionEl.hidden = !filtered.length;
      if (!filtered.length) { if (cardsEl) cardsEl.innerHTML = ''; _updateShownCount('recent-count', cardsEl, 0); return; }
      // Windowed pagination: page N shows tiles N*pageSize .. (N+1)*pageSize
      // (traditional page turner -- clicking page N replaces the visible set
      // instead of cumulatively adding more below). Load More is retired.
      let recentPage = 1;
      let recentPageSize = pageSizeForFullRows(cardsEl, targetRowsForViewport());
      const renderRecent = () => {
        recentPageSize = pageSizeForFullRows(cardsEl, targetRowsForViewport());
        const totalPages = Math.max(1, Math.ceil(filtered.length / Math.max(1, recentPageSize)));
        if (recentPage > totalPages) recentPage = totalPages;
        if (recentPage < 1) recentPage = 1;
        const start = (recentPage - 1) * recentPageSize;
        const end = start + recentPageSize;
        const windowRows = filtered.slice(start, end);
        cardsEl.innerHTML = windowRows.map(_recentCardHtml).join('');
        // hasMore=false on the last page (pad with fillers so the row stays
        // aligned); true elsewhere (trim orphans so the row stays flush).
        const isLastPage = recentPage >= totalPages;
        padTileRows(cardsEl, { tileSelector: '.game-card', hasMore: !isLastPage });
        _updateShownCount('recent-count', cardsEl, filtered.length);
        _renderPageNavFor('page-nav-recent', recentPage, totalPages, (n) => {
          if (n === recentPage) return;
          recentPage = n;
          renderRecent();
        });
        if (loadMoreEl) loadMoreEl.innerHTML = '';
      };
      renderRecent();
      // Belt-and-suspenders: if the initial pageSize was computed before
      // the grid finished laying out, the first render can ship a partial
      // row. Re-run once on the next frame so the second read gets the
      // resolved column count. No-op when the first render was already flush.
      requestAnimationFrame(() => {
        const nextSize = pageSizeForFullRows(cardsEl, targetRowsForViewport());
        if (nextSize !== recentPageSize) renderRecent();
      });
      watchTileRerender(cardsEl, renderRecent);
    }

    document.getElementById('home-sort-select')?.addEventListener('change', e => {
      currentSort = e.target.value;
      applyRecentFilters();
      _saveFiltersIfEnabled();
    });

    // Text filter: filters both sections by title substring as the user types.
    // Two inputs share one state -- the bar input is desktop-only, the panel
    // input is mobile-only (CSS-toggled), so keep them in sync both ways.
    const _textInputs = ['home-text-filter', 'home-text-filter-mobile']
      .map(id => document.getElementById(id))
      .filter(Boolean);
    const _onTextInput = (val) => {
      textFilter = val;
      for (const inp of _textInputs) { if (inp.value !== val) inp.value = val; }
      updateFilterBadge();
      applyRecentFilters();
      applyPopularFilters();
      _saveFiltersIfEnabled();
    };
    for (const inp of _textInputs) {
      inp.addEventListener('input', e => _onTextInput(e.target.value));
    }

    // Filters popover: toggle open, close on outside click.
    const filterWrap = document.getElementById('home-filter-wrap');
    const filterToggle = document.getElementById('home-filter-toggle');
    const filterPanel = document.getElementById('home-filter-panel');
    const filterBadge = document.getElementById('home-filter-badge');
    filterToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = filterPanel.classList.toggle('open');
      filterToggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (filterPanel?.classList.contains('open') && filterWrap && !filterWrap.contains(e.target)) {
        filterPanel.classList.remove('open');
        filterToggle.setAttribute('aria-expanded', 'false');
      }
    });

    // Save filters: when the "Save filters" box is checked, persist the full
    // filter state to localStorage and restore it on the next visit. Unchecking
    // clears the saved state. The box itself reflects whether a save is active.
    const FILTERS_KEY = 'pp:browse-filters';
    function _persistOn() { return document.getElementById('home-filter-persist')?.getAttribute('aria-pressed') === 'true'; }
    function _setPersist(on) {
      const btn = document.getElementById('home-filter-persist');
      if (!btn) return;
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('is-active', on);
    }
    function _saveFilters() {
      try {
        localStorage.setItem(FILTERS_KEY, JSON.stringify({
          sort: currentSort, text: textFilter,
          tier: [...tierSel], source: [...sourceSel], store: [...storeSel],
          library: [...librarySel],
        }));
      } catch { /* ignore */ }
    }
    // Call after any filter change; only writes when the box is checked.
    function _saveFiltersIfEnabled() { if (_persistOn()) _saveFilters(); }
    function _applyPillSelection(groupEl, values) {
      if (!groupEl) return;
      groupEl.querySelectorAll('.pg-filter').forEach(b => b.classList.remove('pg-filter--active'));
      const set = new Set(values || []);
      if (set.size === 0) {
        groupEl.querySelector('.pg-filter[data-value="all"]')?.classList.add('pg-filter--active');
      } else {
        set.forEach(v => groupEl.querySelector(`.pg-filter[data-value="${v}"]`)?.classList.add('pg-filter--active'));
      }
    }
    // Restore a previously saved filter set on load. Returns true if restored.
    function _restoreFilters() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null'); } catch { saved = null; }
      if (!saved) return false;
      _setPersist(true);
      currentSort = saved.sort || 'recent';
      const sortSel = document.getElementById('home-sort-select');
      if (sortSel) sortSel.value = currentSort;
      textFilter = saved.text || '';
      for (const id of ['home-text-filter', 'home-text-filter-mobile']) {
        const inp = document.getElementById(id);
        if (inp) inp.value = textFilter;
      }
      tierSel = new Set(saved.tier || []);
      sourceSel = new Set(saved.source || []);
      storeSel = new Set(saved.store || []);
      librarySel = new Set(saved.library || []);
      _applyPillSelection(tierGroup, saved.tier);
      _applyPillSelection(sourceGroup, saved.source);
      _applyPillSelection(storeGroup, saved.store);
      _applyPillSelection(libraryGroup, saved.library);
      updateFilterBadge();
      console.debug('[browse-filters] restored saved filters', { source: FILTERS_KEY, sort: currentSort, tiers: [...tierSel], sources: [...sourceSel], stores: [...storeSel], library: [...librarySel], text: textFilter });
      return true;
    }
    document.getElementById('home-filter-persist')?.addEventListener('click', () => {
      const on = !_persistOn();
      _setPersist(on);
      if (on) _saveFilters();
      else { try { localStorage.removeItem(FILTERS_KEY); } catch { /* ignore */ } }
    });

    // Active-filter badge: count specific tier + source + store selections.
    function updateFilterBadge() {
      const n = tierSel.size + sourceSel.size + storeSel.size + librarySel.size + (textFilter.trim() ? 1 : 0);
      filterToggle?.classList.toggle('has-filters', n > 0);
      if (filterBadge) {
        filterBadge.textContent = String(n);
        filterBadge.hidden = n === 0;
      }
    }

    const tierGroup = document.getElementById('home-tier-checks');
    const sourceGroup = document.getElementById('home-source-checks');
    const storeGroup = document.getElementById('home-store-checks');
    const libraryGroup = document.getElementById('home-library-checks');
    if (tierGroup) _wirePillGroup(tierGroup, { onChange: sel => {
      tierSel = sel; updateFilterBadge(); applyRecentFilters(); applyPopularFilters(); _saveFiltersIfEnabled();
    }});
    if (sourceGroup) _wirePillGroup(sourceGroup, { onChange: sel => {
      sourceSel = sel; updateFilterBadge(); applyRecentFilters(); applyPopularFilters(); _saveFiltersIfEnabled();
    }});
    if (storeGroup) _wirePillGroup(storeGroup, { onChange: sel => {
      storeSel = sel; updateFilterBadge(); applyRecentFilters(); applyPopularFilters(); _saveFiltersIfEnabled();
    }});
    if (libraryGroup) _wirePillGroup(libraryGroup, { onChange: async sel => {
      librarySel = sel;
      if (sel.has('mine') && !libraryAppIds) {
        libraryAppIds = await getMyLibraryAppIds().catch(() => new Set());
      }
      updateFilterBadge(); applyRecentFilters(); applyPopularFilters(); _saveFiltersIfEnabled();
    }});

    // Clear filters: reset every group back to "All", sort back to Recent.
    document.getElementById('home-filter-clear')?.addEventListener('click', () => {
      [tierGroup, sourceGroup, storeGroup, libraryGroup].forEach(g => {
        if (!g) return;
        g.querySelectorAll('.pg-filter').forEach(b => b.classList.remove('pg-filter--active'));
        const allBtn = g.querySelector('.pg-filter[data-value="all"]');
        if (allBtn) allBtn.classList.add('pg-filter--active');
      });
      const sortSel = document.getElementById('home-sort-select');
      if (sortSel) sortSel.value = 'recent';
      currentSort = 'recent';
      for (const id of ['home-text-filter', 'home-text-filter-mobile']) {
        const inp = document.getElementById(id);
        if (inp) inp.value = '';
      }
      textFilter = '';
      tierSel = new Set();
      sourceSel = new Set();
      storeSel = new Set();
      librarySel = new Set();
      updateFilterBadge();
      applyRecentFilters();
      applyPopularFilters();
      // Persist the cleared state too so a saved set does not come back on reload.
      _saveFiltersIfEnabled();
    });

    // S/M/L only make sense for the card (grid) view; disable them in list mode.
    function _setSizeEnabled(enabled) {
      document.querySelectorAll('.home-size-btn').forEach(b => { b.disabled = !enabled; });
      document.getElementById('home-size-toggle')?.classList.toggle('home-size-toggle--disabled', !enabled);
    }

    // Layout: 'list' (horizontal cards, default) or 'grid' (Steam-style
    // vertical tile grid). Both layouts use the same card markup; CSS
    // reshapes the container into a tile grid for 'grid' mode. Shared
    // storage key with the home page.
    const LAYOUT_KEY = 'pp:grid-layout';
    function _savedLayout() {
      try { const l = localStorage.getItem(LAYOUT_KEY); return (l === 'list' || l === 'grid') ? l : 'grid'; } catch { return 'grid'; }
    }
    function applyLayout(layout) {
      currentLayout = layout;
      const isTile = layout === 'grid';
      document.querySelectorAll('.home-layout-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
      const recentEl = document.getElementById('cards-recent');
      const popularEl = document.getElementById('cards-popular');
      recentEl?.classList.toggle('home-cards-tile-mode', isTile);
      popularEl?.classList.toggle('home-cards-tile-mode', isTile);
      // S/M/L/XL stay enabled in both modes -- in tile mode the size
      // controls the column width, in list mode it controls row height.
      _setSizeEnabled(true);
      // Resize re-render is wired inside applyRecent/PopularFilters via
      // watchTileRerender -- nothing to hook here beyond triggering the
      // caller's applyRecent/PopularFilters which runs on layout change.
    }
    document.querySelectorAll('.home-layout-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        try { localStorage.setItem(LAYOUT_KEY, btn.dataset.layout); } catch { /* ignore */ }
        applyLayout(btn.dataset.layout);
        applyRecentFilters();
        applyPopularFilters();
      });
    });

    // Card size (S/M/L) is a saved user preference. Applies the cards--<size>
    // class to both card lists; default medium.
    const SIZE_KEY = 'pp:grid-size';
    const SIZES = ['sm', 'md', 'lg', 'xl'];
    // Desktop has the room for larger cards, so the default steps up to 'lg'
    // there; mobile stays on 'md' to keep more rows on screen.
    const _DEFAULT_SIZE = window.matchMedia('(min-width: 760px)').matches ? 'lg' : 'md';
    function _savedSize() {
      try { const s = localStorage.getItem(SIZE_KEY); return SIZES.includes(s) ? s : _DEFAULT_SIZE; } catch { return _DEFAULT_SIZE; }
    }
    function applyGridSize(size) {
      ['cards-recent', 'cards-popular'].forEach(id => {
        const el2 = document.getElementById(id);
        if (el2) { SIZES.forEach(s => el2.classList.remove(`cards--${s}`)); el2.classList.add(`cards--${size}`); }
      });
      document.querySelectorAll('.home-size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === size));
      // The size class changes the column count, so re-render both grids to
      // refill whole rows for the new width. Without this the last row goes
      // ragged on a size change until the next full re-render.
      applyRecentFilters();
      applyPopularFilters();
    }
    document.querySelectorAll('.home-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const size = btn.dataset.size;
        try { localStorage.setItem(SIZE_KEY, size); } catch { /* ignore */ }
        applyGridSize(size);
      });
    });
    applyGridSize(_savedSize());
    applyLayout(_savedLayout()); // restore saved list/grid before first render

    _restoreFilters(); // re-apply a saved filter set (if any) before first render

    // #199: honor ?filter=mine so the profile "View my games" button lands
    // here with the pill pre-activated. Overrides any restored library set
    // for this visit so the deep-link intent wins.
    const urlFilter = new URLSearchParams(window.location.search).get('filter');
    if (urlFilter === 'mine') {
      librarySel = new Set(['mine']);
      _applyPillSelection(libraryGroup, ['mine']);
      libraryAppIds = await getMyLibraryAppIds().catch(() => new Set());
      updateFilterBadge();

      // The default view is capped to recent-reports.json (~100 rows) and
      // most_played.json (~50 rows). Intersecting that with a real Steam
      // library dropped 200+ owned games to a handful. When ?filter=mine
      // is active, synthesize a comprehensive library dataset from search-
      // index so every owned game shows up -- and hide the Popular section
      // because it would just repeat the same rows.
      if (libraryAppIds && libraryAppIds.size > 0) {
        const synth = synthesizeMyLibrary(libraryAppIds, allRecentReports, searchIndex);
        allRecentReports = synth.rows;
        console.debug('[my-library] synthesized library dataset', {
          source: 'search-index+stubs',
          fromRecentReports: synth.fromRecentReports,
          fromSearchIndex: synth.fromSearchIndex,
          bareStubs: synth.bareStubs,
          libraryTotal: libraryAppIds.size,
          rowTotal: allRecentReports.length,
        });
        const popularSection = document.getElementById('cards-popular')?.parentElement;
        const popularLabel = document.getElementById('popular-section-label');
        // Hide the entire popular section header + grid so we present one
        // unambiguous library list instead of splitting the view.
        if (popularLabel && popularLabel.parentElement) popularLabel.parentElement.style.display = 'none';
        const popCards = document.getElementById('cards-popular');
        if (popCards) popCards.style.display = 'none';
        const popNav = document.getElementById('page-nav-popular');
        if (popNav) popNav.hidden = true;
        const popMore = document.getElementById('load-more-popular');
        if (popMore) popMore.style.display = 'none';
        // Rename the visible section header to just "My Library" (no
        // sub-heading) since it's the only section.
        const recentLabel = document.getElementById('recent-section-label');
        if (recentLabel) recentLabel.textContent = 'My Library';
      }
    }

    applyRecentFilters();
    applyPopularFilters();

    // Signed-in library breakdown chart. No-op when signed out (#199).
    void renderHomeLibraryChart(document.getElementById('home-library-chart-mount'));
  } catch {
    el.innerHTML = '<div class="state-box">Search for a game above or navigate to <code>#/app/{appId}</code></div>';
  }
}

export async function renderHomeFallback() {
  const [pulseReports] = await Promise.all([
    fetchRecentPulseReports(),
    loadSearchIndex(),
  ]);
  const popularIds = ['730', '570', '440', '292030', '1245620', '1091500', '1174180', '413150'];
  const titleById = new Map((searchIndex || []).map(([id, title]) => [String(id), title]));
  _trendByAppId = null;
  _replacedByAppId = null;
  _buildTrendMap();
  _buildReplacedByMap();
  const popularCards = popularIds
    .map((appId) => ({ appId, title: titleById.get(appId) || `App ${appId}` }))
    .filter((row) => row.title)
    .map((row) => renderGameCard({ href: `#/app/${row.appId}`, appId: row.appId, title: row.title, sub: 'ProtonDB data available', trend: _lookupTrend(row.appId) }))
    .join('');

  const pulseCards = renderPulseReportCards(pulseReports);

  return `
    ${pulseCards ? `
      <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Reports</p>
      <div class="cards" style="margin-bottom:16px">
        ${pulseCards}
      </div>` : ''}
    <p class="section-label" style="margin-bottom:10px">Popular ProtonDB Reports</p>
    <div class="cards">
      ${popularCards}
    </div>`;
}

// Unified activity card used by the merged "Recent Activity" feed on the
// home page. `kind` drives the small REPORT/CONFIG pill on the right plus
// which fields show in the body. Single renderer means both kinds share
// the same hover/click target shape, so the layout is consistent down
// the list instead of two visually separate sections
export function renderActivityCard(kind, row, counts = {}) {
  const isReport = kind === 'report';
  const appId = row.app_id;
  let title, sub, isNonSteam = false;
  if (isReport) {
    title = row.title || `App ${appId}`;
    isNonSteam = isNonSteamAppId(appId);
    const total = (counts.protondbCount || 0) + (counts.pulseCount || 0);
    const countPart = total > 0 ? `${total.toLocaleString()} report${total === 1 ? '' : 's'}` : '';
    const date = row.created_at ? String(row.created_at).slice(0, 10) : '';
    const datePart = date ? `latest: ${date}` : '';
    sub = [countPart, datePart].filter(Boolean).join(' \u00b7 ');
  } else {
    const cfg = row.config || {};
    title = row.app_name || cfg.appName || `App ${appId}`;
    const hwLine = [cfg.protonVersion || '', cfg.profileName || ''].filter(Boolean).join(' | ');
    const d = Math.round((Date.now() / 1000 - new Date(row.updated_at).getTime() / 1000) / 86400);
    const age = d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
    sub = `${hwLine}${hwLine && age ? ' \u00b7 ' : ''}${age}`;
    isNonSteam = cfg.isNonSteam === true || isNonSteamAppId(appId);
  }
  const rating = isReport ? String(row.rating || '').toLowerCase() : '';
  // Prefer the canonical store from the id prefix (gog:/epic:); otherwise fall
  // back to the legacy CRC32 non-Steam shortcut heuristic.
  const at = appTypeFromAppId(appId);
  const storePillLabel = at !== 'steam' ? storeLabel(at) : (isNonSteam ? 'Non-Steam' : 'Steam');
  return renderGameCard({
    href: `#/app/${appId}`,
    appId,
    title,
    sub,
    tier: rating || undefined,
    storePill: storePillLabel,
    trend: _lookupTrend(appId),
  });
}

export function renderPulseReportCards(rows) {
  return rows.map((row) => {
    const rating = String(row.rating || '').toLowerCase();
    const sub = [row.proton_version, daysAgo(Math.floor(new Date(row.created_at).getTime() / 1000))].filter(Boolean).join(' \u00b7 ');
    return renderGameCard({
      href: `#/app/${row.app_id}`,
      appId: row.app_id,
      title: row.title || `App ${row.app_id}`,
      sub,
      tier: rating || undefined,
      trend: _lookupTrend(row.app_id),
    });
  }).join('');
}
