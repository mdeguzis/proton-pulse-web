// search (components) for the app page. Relocated from app.js/app-search.js.

import { estimateScore } from '../../shared/scoring.js?v=852c9d97';
import { fetchMatchingPulseConfigs, fetchMatchingPulseReportAppIds } from '../api/reports.js?v=003f23c0';
import { renderGamePage } from './game-page.js?v=62bf4b28';
import { STEAM_IMG, SITE_ROOT, USES_PROD_DATA, storeLabelFromAppId, fetchDataWithProdFallback } from '../config.js?v=a75604f5';
import { daysAgo, esc, withTimeout } from '../utils.js?v=4630c3d5';
import { renderGameCard } from '../lib/card.js?v=db950b95';
import { dataUrl } from '../../lib/data-url.js?v=0de73aed';
import { filterAdultEntries, isAdultEntry } from '../../lib/adult-filter.js?v=e4e9d845';
import { filterDelistedEntries, countHiddenDelisted, showDelistedAllowed } from '../../lib/delisted-filter.js?v=42858e22';
import { showAdultAllowed } from '../../lib/adult-filter.js?v=e4e9d845';
import { matchEntries } from '../lib/search-match.js?v=dd1b70b2';
import { searchGames } from '../api/search-games.js?v=0e14d3ff';

// Search index + results UX -- factored out of app.js.
// Loaded as a classic script BEFORE app.js so its exports
// (searchFocusIdx, renderSearchPage, renderSearchResults, closeSearch,
// etc.) are available when app.js runs. Depends on app-scoring.js for
// estimateScore (not currently called from here but available).
//
// #437: the primary search-index.json blob loader (loadSearchIndex,
// searchIndex, searchIndexMatches) was removed once every consumer moved
// to the search-games edge fn. Search UX is API-only; the only remaining
// blob reader is the admin box-art tool, which needs the full catalog.
// The lazy extended-Steam index below is a separate, smaller file still
// used by the game page for long-tail stub lookups.

// --- search index state vars ---
export let extendedSteamIndex     = null;   // lazy: [[appId, title, "", 0, 0, "steam"], ...]
export let extendedSteamLoadingP  = null;   // in-flight Promise so concurrent searches share one fetch
export let searchFocusIdx         = -1;

// --- _matchEntries (pure filter, shared between primary and extended) ---
// Delegates to the pure module in js/app/lib/search-match.js so the
// matching rules can be unit-tested without pulling this whole search
// component + its DOM / Supabase transitive imports.
const _matchEntries = matchEntries;

// --- searchExtendedSteamMatches ---
// LEGACY. Deprecated with #434 -- the API now hits the full Postgres
// index so the extended-steam blob file no longer earns its keep.
// Retained for the transition window; safe to delete once nothing
// references it.
export function searchExtendedSteamMatches(query, limit) {
  const q = query.trim();
  return filterDelistedEntries(filterAdultEntries(_matchEntries(extendedSteamIndex, q, limit)));
}

// --- searchGamesAPI ---
// #434: API-backed search returning array-shape rows (matching the
// search-index.json blob shape) so existing renderers can consume the
// result without a shape change. Applies the same adult/delisted gates
// on the API side so hidden counts come back accurate.
export async function searchGamesAPI(query, { limit = 24, store = 'all' } = {}) {
  const body = await searchGames(query, {
    limit,
    store,
    includeDelisted: showDelistedAllowed(),
    includeAdult: showAdultAllowed(),
  });
  // Coerce API rows back to the legacy array shape so existing
  // renderIndexSearchResult / _lookupTrend / etc. keep working.
  const asRows = body.results.map((r) => [
    r.appId,
    r.title,
    r.tier,
    r.protondbCount,
    r.pulseCount,
    r.source,
    r.releaseYear,
    r.delisted,
    r.adult,
    '',
    r.replacedBy,
    r.steamType,
  ]);
  return {
    rows: asRows,
    hiddenDelisted: body.hiddenDelisted,
    hiddenAdult: body.hiddenAdult,
    tookMs: body.tookMs,
  };
}

// --- renderPulseSearchResult ---
export function renderPulseSearchResult(row) {
  const age = daysAgo(Math.floor(new Date(row.updatedAt).getTime() / 1000));
  const sub = `${row.profileName ? esc(row.profileName) : ''}${row.protonVersion ? ' \u00b7 ' + esc(row.protonVersion) : ''} \u00b7 ${age}`;
  return renderGameCard({ href: `#/app/${row.appId}`, appId: row.appId, title: row.appName, sub, badge: 'Pulse', storePill: storeLabelFromAppId(row.appId) });
}

// --- renderIndexSearchResult ---
export function renderIndexSearchResult(entry, displayTitleOverride) {
  // search-index entries: [appId, title, tier, protondbCount, pulseCount, appType, releaseYear, delisted, adult, trend, replacedBy, ...]
  // Destructure defensively so older deploys keep rendering.
  const [appId, title, tier, protondbCount, pulseCount, appType] = entry;
  const delisted = entry.length > 7 && entry[7] === true;
  // col 10 replaced_by carries "steam:<appid>" for PCGW-only rows the
  // cross-check flagged (#434). Non-steam-prefixed values are the
  // Steam-side replaced_by (#199 follow-up) and stay in that lane.
  const rbRaw = entry.length > 10 ? entry[10] : null;
  const delistedSteamAppId = (typeof rbRaw === 'string' && rbRaw.startsWith('steam:'))
    ? rbRaw.slice(6)
    : '';
  const counts = [];
  if (protondbCount) counts.push(`${protondbCount} ProtonDB`);
  if (pulseCount) counts.push(`${pulseCount} Pulse`);
  const meta = counts.length
    ? counts.join(' + ') + ' report' + ((protondbCount + pulseCount) === 1 ? '' : 's')
    : delisted
      ? `Delisted from Steam${delistedSteamAppId ? ` (was app ${esc(delistedSteamAppId)})` : ''} - no ProtonDB reports.`
      : `ProtonDB data indexed for app ${esc(appId)}.`;
  // #434 followup: a pgwiki-source row that carries a delisted-steam
  // appid was ORIGINALLY a Steam listing; PCGWiki is just where the
  // metadata came from. Show STEAM as the store tag so the card reads
  // "Steam + Delisted" (accurate: the game was on Steam, now it is
  // not). Non-delisted pgwiki rows keep the PCGWiki store label.
  let store;
  if (appType === 'gog') store = 'GOG';
  else if (appType === 'epic') store = 'Epic';
  else if (appType === 'steam') store = 'Steam';
  else if (appType === 'pgwiki' && delistedSteamAppId) store = 'Steam';
  else store = storeLabelFromAppId(appId);
  const displayTitle = displayTitleOverride || title;
  return renderGameCard({
    href: `#/app/${appId}`, appId, title: displayTitle, sub: meta,
    tier: tier || undefined, storePill: store,
    delisted, delistedSteamAppId,
  });
}

// #434 followup: single flat Index Data Hits list with an inline store
// filter chip row at the top. Grouping into per-store sections was
// distracting; a filter that hides everything but the chosen store
// gives the same "focus on Steam only" outcome without breaking the
// results into loose wells. A pgwiki row whose replaced_by=steam:
// <appid> counts as Steam so it stays visible under the Steam filter.
const _STORE_FILTER_ORDER = ['steam', 'gog', 'epic', 'pgwiki'];
const _STORE_FILTER_LABEL = { steam: 'Steam', gog: 'GOG', epic: 'Epic', pgwiki: 'PCGWiki' };
function _effectiveStoreForFilter(entry) {
  const src = entry[5];
  const rb  = entry.length > 10 ? entry[10] : null;
  if (src === 'pgwiki' && typeof rb === 'string' && rb.startsWith('steam:')) return 'steam';
  return src || 'other';
}
function _renderStoreFilterRow(indexResults) {
  if (!indexResults.length) return '';
  const counts = { steam: 0, gog: 0, epic: 0, pgwiki: 0 };
  for (const entry of indexResults) {
    const s = _effectiveStoreForFilter(entry);
    if (s in counts) counts[s]++;
  }
  const chips = [
    `<button type="button" class="search-store-chip search-store-chip--active" data-store="all">All <span class="search-store-chip-n">${indexResults.length}</span></button>`,
    ..._STORE_FILTER_ORDER
      .filter(s => counts[s] > 0)
      .map(s => `<button type="button" class="search-store-chip" data-store="${s}">${esc(_STORE_FILTER_LABEL[s])} <span class="search-store-chip-n">${counts[s]}</span></button>`),
  ];
  return `<div class="search-store-filter">${chips.join('')}</div>`;
}

// --- renderSearchPage ---
export async function renderSearchPage(query) {
  const el = document.getElementById('content');
  const q = query.trim();
  el.innerHTML = '<div class="state-box">Searching Proton Pulse and index data...</div>';
  // #143: track the query so the admin chart can show what people search
  // for. Anonymous events from signed-out visitors still count -- the
  // chart aggregates by q value, not by user.
  if (q && typeof window.ppTrack === 'function') {
    void window.ppTrack('search_query', { q: q.slice(0, 120), source: 'app' });
  }
  // #434: search UX now hits the search-games edge function. Server does
  // FTS + adult/delisted gate + store filter in one round trip, returns
  // ~2KB per query instead of the pre-#434 12MB blob download. Extended
  // Steam index no longer needed -- the API queries the full Postgres
  // catalog directly. Fires in parallel with the User Configs lookup.
  const [pulseResults, apiResp] = await Promise.all([
    withTimeout(fetchMatchingPulseConfigs(q), 2500, []),
    searchGamesAPI(q, { limit: 48 }),
  ]);
  const indexResults = apiResp.rows;
  const hiddenAdultCount = apiResp.hiddenAdult;
  const hiddenDelistedCount = apiResp.hiddenDelisted;
  // Disambiguate same-name games (e.g. Prey 2006 vs Prey 2017) with a "(YEAR)"
  // suffix when the pipeline supplied a releaseYear (column 7 of search-index).
  // window.__buildTitleOverrides is registered globally by topbar.js.
  const indexShaped = indexResults.map(([appId, title, , , , , releaseYear]) => ({ appId, title, releaseYear }));
  const indexOverrides = (typeof window.__buildTitleOverrides === 'function')
    ? window.__buildTitleOverrides(indexShaped)
    : new Map();
  const total = pulseResults.length + indexResults.length;

  const adultNote = hiddenAdultCount > 0
    ? `<div class="search-adult-note">${hiddenAdultCount} adult result${hiddenAdultCount === 1 ? '' : 's'} hidden by your <a href="options.html#opt-show-adult">Show adult games</a> preference.</div>`
    : '';
  // Delisted notice mirrors the adult one. Includes a one-shot button
  // that flips the pp:show-delisted pref on and re-renders so the user
  // can see the hidden matches without leaving the page (#434).
  const delistedNote = hiddenDelistedCount > 0
    ? `<div class="search-delisted-note">${hiddenDelistedCount} delisted game${hiddenDelistedCount === 1 ? '' : 's'} matching "<strong>${esc(q)}</strong>" hidden. <button type="button" class="search-note-action" id="search-show-delisted">Show delisted</button> or update your <a href="options.html#opt-show-delisted">preference</a> to always show them.</div>`
    : '';
  el.innerHTML = `
    <div class="search-summary">
      Search results for <strong>${esc(q)}</strong> - ${total} grouped hit${total === 1 ? '' : 's'}${pulseResults.length === 0 && indexResults.length > 0 ? ' - Proton Pulse config search may still be catching up' : ''}
    </div>
    ${adultNote}
    ${delistedNote}
    <div class="search-groups">
      <section class="search-group">
        <div class="search-group-head">
          <span class="search-group-title">User Configs</span>
          <span class="search-group-count">${pulseResults.length} app${pulseResults.length === 1 ? '' : 's'}</span>
        </div>
        ${pulseResults.length
          ? `<div class="search-result-list">${pulseResults.map(renderPulseSearchResult).join('')}</div>`
          : '<div class="search-group-empty">No Proton Pulse user configs matched this query.</div>'}
      </section>

      <section class="search-group">
        <div class="search-group-head">
          <span class="search-group-title">Index Data Hits</span>
          <span class="search-group-count">${indexResults.length} app${indexResults.length === 1 ? '' : 's'}</span>
        </div>
        ${_renderStoreFilterRow(indexResults)}
        ${indexResults.length
          ? `<div class="search-result-list" id="search-index-list">${indexResults.map((entry, i) => `<div class="search-result-item" data-store="${_effectiveStoreForFilter(entry)}">${renderIndexSearchResult(entry, indexOverrides.get(i))}</div>`).join('')}</div>`
          : '<div class="search-group-empty">No static index entries matched this query.</div>'}
      </section>
    </div>`;

  // #434 followup: store-filter chip row above Index Data Hits. Toggles
  // per-item visibility via data-store rather than re-rendering, so it
  // stays cheap on long result lists.
  const filterRow = el.querySelector('.search-store-filter');
  if (filterRow) {
    filterRow.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('.search-store-chip') : null;
      if (!btn) return;
      const store = btn.getAttribute('data-store') || 'all';
      filterRow.querySelectorAll('.search-store-chip').forEach(c => {
        c.classList.toggle('search-store-chip--active', c === btn);
      });
      el.querySelectorAll('.search-result-item').forEach(item => {
        item.hidden = store !== 'all' && item.getAttribute('data-store') !== store;
      });
    });
  }

  // "Show delisted" one-shot from the delisted notice (#434). Flips the
  // pp:show-delisted pref on locally then re-renders the same query so
  // the hidden matches appear inline. We deliberately do NOT sync this
  // to the account -- it is an ad-hoc reveal; the site option page is
  // where the durable preference lives.
  const showDelistedBtn = document.getElementById('search-show-delisted');
  if (showDelistedBtn) {
    showDelistedBtn.addEventListener('click', () => {
      try { localStorage.setItem('pp:show-delisted', 'on'); } catch {}
      renderSearchPage(q);
    });
  }

  // #143: track which result card was clicked + which group + position.
  // Since #434 the API returns a single unified result set (no primary vs
  // extended distinction), so group is 'index' for anything not from the
  // User Configs section. Delegated handler stays O(1) in DOM listeners.
  const indexIdSet = new Set(indexResults.map(([id]) => String(id)));
  const pulseIdSet = new Set(pulseResults.map((r) => String(r.appId)));
  el.addEventListener('click', (ev) => {
    const card = ev.target instanceof Element ? ev.target.closest('a[href^="#/app/"]') : null;
    if (!card) return;
    const m = card.getAttribute('href').match(/^#\/app\/(.+)$/);
    if (!m) return;
    const clickedId = String(m[1]);
    let group = 'other';
    if (pulseIdSet.has(clickedId)) group = 'pulse';
    else if (indexIdSet.has(clickedId)) group = 'index';
    const cards = Array.from(el.querySelectorAll('a[href^="#/app/"]'));
    const position = cards.indexOf(card);
    if (typeof window.ppTrack === 'function') {
      void window.ppTrack('search_result_click', {
        appId: clickedId,
        q: q.slice(0, 120),
        position,
        group,
      });
    }
  });
}

// --- loadExtendedSteamIndex ---
// Lazy-loaded long-tail Steam catalog stubs (#134). Only fetched when the
// primary search-index has no hit for a query. Concurrent callers share one
// in-flight promise so the multi-megabyte payload is fetched at most once.
export async function loadExtendedSteamIndex() {
  if (extendedSteamIndex !== null) return;
  if (extendedSteamLoadingP) { await extendedSteamLoadingP; return; }
  extendedSteamLoadingP = (async () => {
    try {
      const bustedName = await dataUrl('search-index-steam-extended.json');
      const r = await fetchDataWithProdFallback(bustedName);
      extendedSteamIndex = r.ok ? await r.json() : [];
    } catch (err) {
      // Network failure or 404 -- log once and degrade to empty so we don't
      // spin on retries. The primary index still works.
      try { console.warn('[search] extended Steam index unavailable:', err); } catch {}
      extendedSteamIndex = [];
    }
  })();
  await extendedSteamLoadingP;
  extendedSteamLoadingP = null;
}

// --- closeSearch ---
export function closeSearch() {
  searchResults.classList.remove('open');
  searchResults.innerHTML = '';
  searchFocusIdx = -1;
}

// --- positionSearchResults ---
export function positionSearchResults() {
  const rect = searchInput.getBoundingClientRect();
  const desiredWidth = Math.max(rect.width, 620);
  const maxWidth = Math.min(desiredWidth, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - maxWidth - 12));
  searchResults.style.top = `${Math.round(rect.bottom + 4)}px`;
  searchResults.style.left = `${Math.round(left)}px`;
  searchResults.style.width = `${Math.round(maxWidth)}px`;
}

// --- renderSearchResults ---
export function renderSearchResults(q) {
  const items = searchResults.querySelectorAll('a.search-item');
  searchFocusIdx = Math.max(-1, Math.min(searchFocusIdx, items.length - 1));
  items.forEach((a, i) => a.classList.toggle('focused', i === searchFocusIdx));
}

// --- onSearchInput ---
// #434: dropdown quick-match now hits the search-games edge fn instead of
// the pre-#434 blob load + local substring scan. Debounced by the caller
// (input event is fired per keystroke, but the abort signal cancels the
// previous in-flight request so we never render stale results on top of
// fresh ones).
let _dropdownAbortCtrl = null;
export async function onSearchInput() {
  const q = searchInput.value.trim();
  if (!q) { closeSearch(); return; }
  positionSearchResults();
  const MAX = 8;

  // Abort any in-flight dropdown fetch so keystroke N+1 supersedes N.
  if (_dropdownAbortCtrl) _dropdownAbortCtrl.abort();
  _dropdownAbortCtrl = new AbortController();
  const signal = _dropdownAbortCtrl.signal;

  // Kick off the three fetches in parallel: API index match, matching
  // Pulse configs, matching Pulse report app-ids. All time-bounded so a
  // slow backend does not lock the dropdown into a permanent "..." state.
  let apiRows = [];
  try {
    const apiResp = await searchGames(q, {
      limit: MAX,
      includeDelisted: showDelistedAllowed(),
      includeAdult: showAdultAllowed(),
      signal,
    });
    apiRows = apiResp.results;
  } catch (err) {
    if (err && err.name === 'AbortError') return; // superseded, drop silently
    console.warn('[search] dropdown API failed:', err);
  }
  const matches = apiRows.map((r) => [
    r.appId, r.title, r.tier, r.protondbCount, r.pulseCount, r.source,
    r.releaseYear, r.delisted, r.adult, '', r.replacedBy, r.steamType,
  ]);
  const [pulseResults, pulseReportAppIds] = await Promise.all([
    withTimeout(fetchMatchingPulseConfigs(q), 1500, []),
    withTimeout(fetchMatchingPulseReportAppIds(q), 1500, new Set()),
  ]);
  const pulseAppIds = new Set([
    ...pulseResults.map(r => String(r.appId)),
    ...pulseReportAppIds,
  ]);

  if (!matches.length && !pulseAppIds.size) {
    searchResults.innerHTML = `<div class="search-no-results">No quick matches — press Enter to open grouped search results.</div>`;
    searchResults.classList.add('open');
    searchFocusIdx = -1;
    return;
  }

  // Merge: index matches + pulse-only apps not in index
  const seenIds = new Set(matches.map(([id]) => String(id)));
  const pulseOnly = pulseResults.filter(r => !seenIds.has(String(r.appId))).slice(0, MAX - matches.length);
  const allItems = [
    ...matches.map(([id, title, , , , , releaseYear]) => ({ id, title, releaseYear, hasIndex: true, hasPulse: pulseAppIds.has(String(id)) })),
    ...pulseOnly.map(r => ({ id: r.appId, title: r.appName, releaseYear: null, hasIndex: false, hasPulse: true })),
  ];
  // Append " (YEAR)" to colliding titles when a year is known. Falls back to
  // the raw title (no override) when the helper hasn't been registered yet.
  const dropdownOverrides = (typeof window.__buildTitleOverrides === 'function')
    ? window.__buildTitleOverrides(allItems.map(it => ({ title: it.title, releaseYear: it.releaseYear })))
    : new Map();

  const rows = allItems.map(({ id, title, hasIndex, hasPulse }, i) => {
    const display = dropdownOverrides.get(i) || title;
    const img = STEAM_IMG(id);
    const store = storeLabelFromAppId(id);
    return `<a class="search-item" href="#/app/${id}" data-id="${id}">
      <img src="${img}" data-appid="${id}" alt="" loading="lazy" onerror="window.__steamImgLoad(this)">
      <div class="search-result-info">
        <div class="search-result-title">${esc(display)}</div>
        <div class="search-result-badges">
          <span class="game-card-store-pill game-card-store-pill--${store.toLowerCase()}">${store}</span>
          ${hasIndex ? '<span class="badge badge-reports">ProtonDB</span>' : ''}
          ${hasPulse ? '<span class="badge badge-pulse">Pulse</span>' : ''}
        </div>
      </div>
    </a>`;
  }).join('');

  const footer = `<a class="search-footer" href="app.html?q=${encodeURIComponent(q)}">Open grouped search results →</a>`;
  searchResults.innerHTML = rows + footer;
  searchResults.classList.add('open');
  searchFocusIdx = -1;

  // Close when a result is clicked
  searchResults.querySelectorAll('a.search-item').forEach(a => {
    a.addEventListener('click', () => { closeSearch(); searchInput.value = ''; });
  });
}



// topbar.js injects #search at DOMContentLoaded, so these can be null at
// script-load time. Defer wiring until the DOM is ready so we don't throw
// "addEventListener of null" and break renderGamePage.

export let searchInput   = document.getElementById('search');
export let searchResults = document.getElementById('search-results');

export function wireSearch() {
  searchInput   = searchInput   || document.getElementById('search');
  searchResults = searchResults || document.getElementById('search-results');
  if (!searchInput) return;


searchInput.addEventListener('input', onSearchInput);

searchInput.addEventListener('keydown', e => {
  const items = [...searchResults.querySelectorAll('a.search-item')];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchFocusIdx = Math.min(searchFocusIdx + 1, items.length - 1);
    renderSearchResults(searchInput.value.trim());
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchFocusIdx = Math.max(searchFocusIdx - 1, -1);
    renderSearchResults(searchInput.value.trim());
    return;
  }
  if (e.key === 'Escape') { closeSearch(); return; }
  if (e.key === 'Enter') {
    const focused = items[searchFocusIdx];
    if (focused) { focused.click(); return; }
    const q = searchInput.value.trim();
    if (!q) return;
    closeSearch();
    searchInput.value = '';
    if (/^\d+$/.test(q)) {
      location.hash = '#/app/' + q;
    } else {
      window.location.href = 'app.html?q=' + encodeURIComponent(q);
    }
  }
});

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) closeSearch();
});

window.addEventListener('resize', () => {
  if (searchResults && searchResults.classList.contains('open')) positionSearchResults();
});
} // end wireSearch
