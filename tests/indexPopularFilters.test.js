const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'index', 'main.js'),
  'utf8'
);
const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', 'index.html'),
  'utf8'
);

describe('index page popular games rating filters', () => {
  test('index.html renders two distinct Rated / Not Rated filter buttons', () => {
    expect(indexHtml).toContain('id="pg-filter-rated"');
    expect(indexHtml).toContain('id="pg-filter-unrated"');
    // Exact button labels requested by the user
    expect(indexHtml).toMatch(/id="pg-filter-rated"[^>]*>Rated /);
    expect(indexHtml).toMatch(/id="pg-filter-unrated"[^>]*>Not Rated /);
  });

  test('Not Rated is active (pressed) by default, Rated is not (#474)', () => {
    // Flipped from rated -> unrated after the ProtonDB decouple. With
    // Pulse-only rating, every popular Steam game starts under Not Rated,
    // so the default active pill has to be Not Rated or the grid renders
    // empty on first visit.
    expect(indexHtml).toMatch(/id="pg-filter-rated"[^>]*aria-pressed="false"/);
    expect(indexHtml).toMatch(/id="pg-filter-unrated"[^>]*aria-pressed="true"/);
    expect(indexHtml).toMatch(/pg-filter pg-filter--active" id="pg-filter-unrated"/);
  });

  test('main.js splits rated vs unrated using KNOWN_TIERS', () => {
    expect(indexSrc).toContain("const KNOWN_TIERS = new Set(['platinum', 'gold', 'silver', 'bronze', 'borked'])");
    expect(indexSrc).toContain('const ratedGames = games.filter((g) => KNOWN_TIERS.has(String(g.rating || \'\').toLowerCase()))');
    expect(indexSrc).toContain('const unratedGames = games.filter((g) => !KNOWN_TIERS.has(String(g.rating || \'\').toLowerCase()))');
  });

  test('default state shows unrated and hides rated (#474)', () => {
    expect(indexSrc).toContain('const state = { rated: false, unrated: true }');
  });

  test('store is multi-select via a Set, not a single currentStore string', () => {
    expect(indexSrc).toContain("let storeSel = new Set(['steam'])");
    expect(indexSrc).not.toContain('let currentStore');
    // store buttons toggle membership instead of replacing the selection
    expect(indexSrc).toContain('storeSel.delete(store);');
    expect(indexSrc).toContain("btn.addEventListener('click', () => toggleStore(btn.dataset.store))");
  });

  test('store group has an All pill that clears the specific selections', () => {
    expect(indexHtml).toContain('data-store="all"');
    expect(indexSrc).toContain("if (store === 'all') {");
    expect(indexSrc).toContain('storeSel.clear();');
    // All is active when no specific store is selected (empty set == all stores)
    expect(indexSrc).toContain('const allActive = storeSel.size === 0;');
    expect(indexSrc).toContain("function effectiveStores()");
    expect(indexSrc).toContain("return storeSel.size === 0 ? ['steam', 'gog', 'epic'] : [...storeSel];");
  });

  test('currentList merges Steam most_played with non-Steam browse rows (#437)', () => {
    expect(indexSrc).toContain("if (stores.includes('steam'))");
    expect(indexSrc).toContain("const nonSteam = stores.filter(s => s !== 'steam')");
    // Non-Steam rows now come from the browse API cache, not a blob scan.
    expect(indexSrc).toContain('nonSteamRows');
    expect(indexSrc).toContain('.filter(r => nonSteam.includes(r.appType))');
    expect(indexSrc).not.toContain('.filter(row => nonSteam.includes(row[5]))');
  });

  test('rating chip counts reflect the selected stores, not just Steam (#437)', () => {
    expect(indexSrc).toContain('function updateRatingCounts()');
    expect(indexSrc).toContain("if (stores.includes('steam')) { rated += ratedGames.length; unrated += unratedGames.length; }");
    // Non-Steam counts use the browse true total per store, not a blob scan.
    expect(indexSrc).toContain('nonSteamTotals.get(s)');
    expect(indexSrc).not.toContain('if (KNOWN_TIERS.has(String(row[2]');
    // counts refresh when the store selection changes
    expect(indexSrc).toContain('updateRatingCounts();');
  });

  test('Rated / Not Rated are independent toggles (multi-select)', () => {
    expect(indexSrc).toContain('state[key] = !state[key]');
    expect(indexSrc).toContain("ratedBtn?.addEventListener('click', () => toggleRating('rated'))");
    expect(indexSrc).toContain("unratedBtn?.addEventListener('click', () => toggleRating('unrated'))");
    // both-or-neither means show all
    expect(indexSrc).toContain('if (state.rated && !state.unrated) return rated;');
    // old mutually-exclusive behavior is gone
    expect(indexSrc).not.toContain("state.rated = key === 'rated'");
  });

  test('selecting any non-Steam store fetches its browse data once (#437)', () => {
    expect(indexSrc).toContain("effectiveStores().some(s => s !== 'steam')");
    expect(indexSrc).toContain('await _ensureNonSteamData(effectiveStores())');
    // The full-blob loader is gone.
    expect(indexSrc).not.toContain('loadSearchIndex');
    expect(indexSrc).not.toContain('searchIndexCache');
  });

  test('popular list pages with a load more button', () => {
    expect(indexHtml).toContain('id="pg-load-more"');
    // Page size is computed off the current column count so the initial
    // render always shows roughly TARGET_ROWS full rows.
    // Row target is now viewport-aware (5 mobile / 4 desktop) via
    // targetRowsForViewport() in lib/tile-pad.js; no local const.
    expect(indexSrc).toContain('pageSizeForFullRows(list, targetRowsForViewport())');
    expect(indexSrc).toContain('all.slice(0, shown)');
    expect(indexSrc).toContain('id="pg-load-more-btn"');
    // Load more picks up from the actual rendered count (not stale
    // shownCount) because trimming orphans mutates the DOM under it.
    expect(indexSrc).toContain('shownCount = rendered + pageSizeForFullRows(list, targetRowsForViewport())');
  });

  test('changing a filter restarts paging', () => {
    // Filter change resets shownCount to the current row-based page size,
    // not a hardcoded PAGE_SIZE constant.
    expect(indexSrc).toContain('shownCount = pageSizeForFullRows(list, targetRowsForViewport());');
  });
});
