// search (components) for the app page. Relocated from app.js/app-search.js.

import { estimateScore } from '../../shared/scoring.js?v=0dae1257';
import { fetchMatchingPulseConfigs, fetchMatchingPulseReportAppIds } from '../api/reports.js?v=a9fb53ae';
import { renderGamePage } from './game-page.js?v=90bfaf30';
import { STEAM_IMG } from '../config.js?v=4031c5fa';
import { daysAgo, esc, withTimeout } from '../utils.js?v=f5dda5b6';
import { renderGameCard } from '../lib/card.js?v=3a07c55e';

// Search index + results UX -- factored out of app.js.
// Loaded as a classic script BEFORE app.js so its globals
// (searchIndex, searchFocusIdx, loadSearchIndex, searchIndexMatches,
// renderSearchPage, renderSearchResults, closeSearch, etc.) are
// available when app.js runs. Depends on app-scoring.js for
// estimateScore (not currently called from here but available).

// --- search index state vars ---
export let searchIndex     = null;   // [[appId, title], ...]
export let searchFocusIdx  = -1;

// --- searchIndexMatches ---
export function searchIndexMatches(query, limit) {
  const q = query.trim();
  const ql = q.toLowerCase();
  const isNum = /^\d+$/.test(q);
  return (searchIndex || []).filter(([id, title]) =>
    isNum ? String(id).startsWith(q) : (String(title).toLowerCase().includes(ql) || String(id).startsWith(q))
  ).slice(0, limit);
}

// --- renderPulseSearchResult ---
export function renderPulseSearchResult(row) {
  const age = daysAgo(Math.floor(new Date(row.updatedAt).getTime() / 1000));
  const sub = `${row.profileName ? esc(row.profileName) : ''}${row.protonVersion ? ' \u00b7 ' + esc(row.protonVersion) : ''} \u00b7 ${age}`;
  return renderGameCard({ href: `#/app/${row.appId}`, appId: row.appId, title: row.appName, sub, badge: 'Pulse' });
}

// --- renderIndexSearchResult ---
export function renderIndexSearchResult(entry) {
  // search-index entries may be the legacy 2-tuple [appId, title] or the
  // extended 5-tuple [appId, title, tier, protondbCount, pulseCount].
  // Destructure defensively so older deploys keep rendering
  const [appId, title, tier, protondbCount, pulseCount] = entry;
  // Build a counts subline only when at least one count is present
  const counts = [];
  if (protondbCount) counts.push(`${protondbCount} ProtonDB`);
  if (pulseCount) counts.push(`${pulseCount} Pulse`);
  const meta = counts.length
    ? counts.join(' + ') + ' report' + ((protondbCount + pulseCount) === 1 ? '' : 's')
    : `ProtonDB data indexed for app ${esc(appId)}.`;
  return renderGameCard({ href: `#/app/${appId}`, appId, title, sub: meta, tier: tier || undefined });
}

// --- renderSearchPage ---
export async function renderSearchPage(query) {
  const el = document.getElementById('content');
  const q = query.trim();
  el.innerHTML = '<div class="state-box">Searching Proton Pulse and index data...</div>';
  await loadSearchIndex();
  const pulseResults = await withTimeout(fetchMatchingPulseConfigs(q), 2500, []);
  const indexResults = searchIndexMatches(q, 24);
  const total = pulseResults.length + indexResults.length;

  el.innerHTML = `
    <div class="search-summary">
      Search results for <strong>${esc(q)}</strong> - ${total} grouped hit${total === 1 ? '' : 's'}${pulseResults.length === 0 && indexResults.length > 0 ? ' - Proton Pulse config search may still be catching up' : ''}
    </div>
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
          ? `<div class="search-result-list">${indexResults.map(renderIndexSearchResult).join('')}</div>`
          : '<div class="search-group-empty">No static index entries matched this query.</div>'}
      </section>
    </div>`;
}

// --- loadSearchIndex ---
export async function loadSearchIndex() {
  if (searchIndex !== null) return;
  try {
    // On localhost the search-index is gitignored + missing; pull it from
    // production so dev preview can search any game without running the pipeline
    const SEARCH_URL = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname)
      ? 'https://www.proton-pulse.com/search-index.json'
      : 'search-index.json';
    const r = await fetch(SEARCH_URL);
    searchIndex = r.ok ? await r.json() : [];
  } catch { searchIndex = []; }
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
    ...matches.map(([id, title]) => ({ id, title, hasIndex: true, hasPulse: pulseAppIds.has(String(id)) })),
    ...pulseOnly.map(r => ({ id: r.appId, title: r.appName, hasIndex: false, hasPulse: true })),
  ];

  const rows = allItems.map(({ id, title, hasIndex, hasPulse }) => {
    const img = STEAM_IMG(id);
    return `<a class="search-item" href="#/app/${id}" data-id="${id}">
      <img src="${img}" data-appid="${id}" alt="" loading="lazy" onerror="window.__steamImgLoad(this)">
      <div class="search-result-info">
        <div class="search-result-title">${esc(title)}</div>
        <div class="search-result-badges">
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
