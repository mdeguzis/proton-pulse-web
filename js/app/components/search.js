// search (components) for the app page. Relocated from app.js/app-search.js.

import { estimateScore } from '../../shared/scoring.js?v=0dae1257';
import { fetchMatchingPulseConfigs, fetchMatchingPulseReportAppIds } from '../api/reports.js?v=003f23c0';
import { renderGamePage } from './game-page.js?v=35326c22';
import { STEAM_IMG, SITE_ROOT, USES_PROD_DATA, storeLabelFromAppId } from '../config.js?v=df5b5024';
import { daysAgo, esc, withTimeout } from '../utils.js?v=c7e1268c';
import { renderGameCard } from '../lib/card.js?v=754da47b';
import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';
import { filterAdultEntries, isAdultEntry } from '../../lib/adult-filter.js?v=e4e9d845';

// Search index + results UX -- factored out of app.js.
// Loaded as a classic script BEFORE app.js so its globals
// (searchIndex, searchFocusIdx, loadSearchIndex, searchIndexMatches,
// renderSearchPage, renderSearchResults, closeSearch, etc.) are
// available when app.js runs. Depends on app-scoring.js for
// estimateScore (not currently called from here but available).

// --- search index state vars ---
export let searchIndex            = null;   // primary: [[appId, title, tier, pdb, pulse, appType, releaseYear?, delisted?], ...]
export let extendedSteamIndex     = null;   // lazy: [[appId, title, "", 0, 0, "steam"], ...]
export let extendedSteamLoadingP  = null;   // in-flight Promise so concurrent searches share one fetch
export let searchFocusIdx         = -1;

// --- _matchEntries (pure filter, shared between primary and extended) ---
function _matchEntries(entries, query, limit) {
  if (!entries || !entries.length) return [];
  const ql = query.toLowerCase();
  const isNum = /^\d+$/.test(query);
  return entries.filter(([id, title]) =>
    isNum ? String(id).startsWith(query) : (String(title).toLowerCase().includes(ql) || String(id).startsWith(query))
  ).slice(0, limit);
}

// --- searchIndexMatches ---
export function searchIndexMatches(query, limit) {
  const q = query.trim();
  // Drop adult-flagged rows unless the user's "Show adult games" pref is on.
  // filterAdultEntries is a no-op for rows without the adult column so
  // pre-pipeline-run indices stay visible.
  return filterAdultEntries(_matchEntries(searchIndex, q, limit));
}

// --- searchExtendedSteamMatches ---
// Synchronous match against the already-loaded extended index. Call
// loadExtendedSteamIndex() first when you want the long-tail Steam catalog.
export function searchExtendedSteamMatches(query, limit) {
  const q = query.trim();
  return filterAdultEntries(_matchEntries(extendedSteamIndex, q, limit));
}

// --- renderPulseSearchResult ---
export function renderPulseSearchResult(row) {
  const age = daysAgo(Math.floor(new Date(row.updatedAt).getTime() / 1000));
  const sub = `${row.profileName ? esc(row.profileName) : ''}${row.protonVersion ? ' \u00b7 ' + esc(row.protonVersion) : ''} \u00b7 ${age}`;
  return renderGameCard({ href: `#/app/${row.appId}`, appId: row.appId, title: row.appName, sub, badge: 'Pulse', storePill: storeLabelFromAppId(row.appId) });
}

// --- renderIndexSearchResult ---
export function renderIndexSearchResult(entry, displayTitleOverride) {
  // search-index entries: [appId, title, tier, protondbCount, pulseCount, appType, releaseYear, delisted]
  // Destructure defensively so older deploys keep rendering
  const [appId, title, tier, protondbCount, pulseCount, appType] = entry;
  // Build a counts subline only when at least one count is present
  const counts = [];
  if (protondbCount) counts.push(`${protondbCount} ProtonDB`);
  if (pulseCount) counts.push(`${pulseCount} Pulse`);
  const meta = counts.length
    ? counts.join(' + ') + ' report' + ((protondbCount + pulseCount) === 1 ? '' : 's')
    : `ProtonDB data indexed for app ${esc(appId)}.`;
  // Prefer the appType column from the index; fall back to deriving from the id
  // so legacy 5-tuple entries still get a store pill.
  const store = appType === 'gog' ? 'GOG' : appType === 'epic' ? 'Epic' : appType === 'steam' ? 'Steam' : storeLabelFromAppId(appId);
  const displayTitle = displayTitleOverride || title;
  return renderGameCard({ href: `#/app/${appId}`, appId, title: displayTitle, sub: meta, tier: tier || undefined, storePill: store });
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
  // Issue #134: load the extended Steam catalog alongside the primary index
  // so long-tail Steam games (apps that ProtonDB knows about but the curated
  // signal export does not) are findable from the grouped results page. The
  // extended file is large, so it stays out of the dropdown (onSearchInput)
  // and only loads on this deliberate Enter-to-search path.
  await Promise.all([loadSearchIndex(), loadExtendedSteamIndex()]);
  const pulseResults = await withTimeout(fetchMatchingPulseConfigs(q), 2500, []);
  // Count adult-hidden hits so the summary line can call them out. Runs
  // the raw match once to get the unfiltered set, then applies the
  // filter for display. showAdultAllowed()=true means nothing is hidden.
  const primaryRaw = _matchEntries(searchIndex, q, 24);
  const primaryResults = filterAdultEntries(primaryRaw);
  const primaryIds = new Set(primaryResults.map(([id]) => String(id)));
  const extendedRoom = Math.max(0, 48 - primaryResults.length);
  const extendedRaw = extendedRoom
    ? _matchEntries(extendedSteamIndex, q, extendedRoom + primaryIds.size)
        .filter(([id]) => !primaryIds.has(String(id)))
        .slice(0, extendedRoom)
    : [];
  const extendedResults = filterAdultEntries(extendedRaw);
  const hiddenAdultCount = (primaryRaw.length - primaryResults.length)
                         + (extendedRaw.length - extendedResults.length);
  const indexResults = [...primaryResults, ...extendedResults];
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
  el.innerHTML = `
    <div class="search-summary">
      Search results for <strong>${esc(q)}</strong> - ${total} grouped hit${total === 1 ? '' : 's'}${pulseResults.length === 0 && indexResults.length > 0 ? ' - Proton Pulse config search may still be catching up' : ''}
    </div>
    ${adultNote}
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
        ${indexResults.length
          ? `<div class="search-result-list">${indexResults.map((entry, i) => renderIndexSearchResult(entry, indexOverrides.get(i))).join('')}</div>`
          : '<div class="search-group-empty">No static index entries matched this query.</div>'}
      </section>
    </div>`;

  // #143: track which result card was clicked + which group + position.
  // Tells us whether the extended Steam index (group=extended) actually
  // earns its keep on the long-tail catalog. Uses a delegated handler
  // so it stays in O(1) DOM listeners regardless of result count.
  const primaryIdSet = new Set(primaryResults.map(([id]) => String(id)));
  const pulseIdSet = new Set(pulseResults.map((r) => String(r.appId)));
  el.addEventListener('click', (ev) => {
    const card = ev.target instanceof Element ? ev.target.closest('a[href^="#/app/"]') : null;
    if (!card) return;
    const m = card.getAttribute('href').match(/^#\/app\/(.+)$/);
    if (!m) return;
    const clickedId = String(m[1]);
    let group = 'extended';
    if (pulseIdSet.has(clickedId)) group = 'pulse';
    else if (primaryIdSet.has(clickedId)) group = 'primary';
    // Position is the index of the card among rendered result anchors.
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

// --- loadSearchIndex ---
export async function loadSearchIndex() {
  if (searchIndex !== null) return;
  try {
    // Localhost and staging (.github.io) have no pipeline data of their own, so
    // pull the production search-index just like CDN/data do (USES_PROD_DATA).
    // On the real domain this stays relative.
    // dataUrl appends ?v=<content-hash> from data-versions.json so a new
    // pipeline run invalidates the browser/CDN cache for this file only.
    // Staging/local resolves through USES_PROD_DATA on the host pattern.
    const bustedName = await dataUrl('search-index.json');
    const SEARCH_URL = USES_PROD_DATA
      ? `${SITE_ROOT}/${bustedName}`
      : bustedName;
    const r = await fetch(SEARCH_URL);
    searchIndex = r.ok ? await r.json() : [];
  } catch { searchIndex = []; }
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
      const url = USES_PROD_DATA ? `${SITE_ROOT}/${bustedName}` : bustedName;
      const r = await fetch(url);
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
export async function onSearchInput() {
  const q = searchInput.value.trim();
  if (!q) { closeSearch(); return; }
  await loadSearchIndex();
  positionSearchResults();
  const MAX = 8;

  // Filter: numeric queries match only on app ID prefix; text matches title or ID
  const matches = searchIndexMatches(q, MAX);
  // Check which matched apps have Pulse configs AND/OR Pulse reports. Either
  // one is enough to earn the Pulse badge in the dropdown
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
