// Search index + results UX -- factored out of app.js.
// Loaded as a classic script BEFORE app.js so its globals
// (searchIndex, searchFocusIdx, loadSearchIndex, searchIndexMatches,
// renderSearchPage, renderSearchResults, closeSearch, etc.) are
// available when app.js runs. Depends on app-scoring.js for
// estimateScore (not currently called from here but available).

// --- search index state vars ---
let searchIndex     = null;   // [[appId, title], ...]
let searchFocusIdx  = -1;

// --- searchIndexMatches ---
function searchIndexMatches(query, limit) {
  const q = query.trim();
  const ql = q.toLowerCase();
  const isNum = /^\d+$/.test(q);
  return (searchIndex || []).filter(([id, title]) =>
    isNum ? String(id).startsWith(q) : (String(title).toLowerCase().includes(ql) || String(id).startsWith(q))
  ).slice(0, limit);
}

// --- renderPulseSearchResult ---
function renderPulseSearchResult(row) {
  const age = daysAgo(Math.floor(new Date(row.updatedAt).getTime() / 1000));
  const isProtonDb = (row.source || '').toLowerCase() === 'protondb';
  const alsoInIndex = !isProtonDb && (searchIndex || []).some(([id]) => String(id) === String(row.appId));
  const sourceBadge = isProtonDb
    ? '<span class="source-badge protondb">ProtonDB</span>'
    : '<span class="source-badge pulse"><img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse</span>'
      + (alsoInIndex ? ' <span class="source-badge protondb">ProtonDB</span>' : '');
  return `
    <a class="search-result-card" href="#/app/${row.appId}">
      <img src="${STEAM_IMG(row.appId)}" onerror="this.style.display='none'" alt="">
      <div class="search-result-main">
        <div class="search-result-main-title">${esc(row.appName)}</div>
        <div class="search-result-main-meta">
          Latest config: ${esc(row.profileName)}${row.protonVersion ? ` - ${esc(row.protonVersion)}` : ''}<br>
          Updated ${age}
        </div>
      </div>
      <div class="search-result-side">
        ${sourceBadge}
      </div>
    </a>`;
}

// --- renderIndexSearchResult ---
function renderIndexSearchResult(entry) {
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
  const tierBadge = tier
    ? `<span class="tier-badge tier-${esc(tier)}">${esc(tier)}</span>`
    : '';
  return `
    <a class="search-result-card" href="#/app/${appId}">
      <img src="${STEAM_IMG(appId)}" onerror="this.style.display='none'" alt="">
      <div class="search-result-main">
        <div class="search-result-main-title">${esc(title)}</div>
        <div class="search-result-main-meta">${meta}</div>
      </div>
      <div class="search-result-side">
        ${tierBadge}
        ${pulseCount ? '<span class="source-badge pulse"><img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse</span>' : ''}
        <span class="source-badge protondb">ProtonDB</span>
      </div>
    </a>`;
}

// --- renderSearchPage ---
async function renderSearchPage(query) {
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
async function loadSearchIndex() {
  if (searchIndex !== null) return;
  try {
    const r = await fetch('search-index.json');
    searchIndex = r.ok ? await r.json() : [];
  } catch { searchIndex = []; }
}

// --- closeSearch ---
function closeSearch() {
  searchResults.classList.remove('open');
  searchResults.innerHTML = '';
  searchFocusIdx = -1;
}

// --- positionSearchResults ---
function positionSearchResults() {
  const rect = searchInput.getBoundingClientRect();
  const desiredWidth = Math.max(rect.width, 620);
  const maxWidth = Math.min(desiredWidth, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - maxWidth - 12));
  searchResults.style.top = `${Math.round(rect.bottom + 4)}px`;
  searchResults.style.left = `${Math.round(left)}px`;
  searchResults.style.width = `${Math.round(maxWidth)}px`;
}

// --- renderSearchResults ---
function renderSearchResults(q) {
  const items = searchResults.querySelectorAll('a.search-item');
  searchFocusIdx = Math.max(-1, Math.min(searchFocusIdx, items.length - 1));
  items.forEach((a, i) => a.classList.toggle('focused', i === searchFocusIdx));
}

// --- onSearchInput ---
async function onSearchInput() {
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
      <img src="${img}" onerror="this.style.display='none'" alt="" loading="lazy">
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

