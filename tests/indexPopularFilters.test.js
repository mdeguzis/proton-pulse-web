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

  test('Rated is active (pressed) by default, Not Rated is not', () => {
    expect(indexHtml).toMatch(/id="pg-filter-rated"[^>]*aria-pressed="true"/);
    expect(indexHtml).toMatch(/id="pg-filter-unrated"[^>]*aria-pressed="false"/);
    expect(indexHtml).toMatch(/pg-filter pg-filter--active" id="pg-filter-rated"/);
  });

  test('main.js splits rated vs unrated using KNOWN_TIERS', () => {
    expect(indexSrc).toContain("const KNOWN_TIERS = new Set(['platinum', 'gold', 'silver', 'bronze', 'borked'])");
    expect(indexSrc).toContain('const ratedGames = games.filter((g) => KNOWN_TIERS.has(String(g.rating || \'\').toLowerCase()))');
    expect(indexSrc).toContain('const unratedGames = games.filter((g) => !KNOWN_TIERS.has(String(g.rating || \'\').toLowerCase()))');
  });

  test('default state shows rated and hides unrated', () => {
    expect(indexSrc).toContain('const state = { rated: true, unrated: false }');
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

  test('currentList merges Steam most_played with non-Steam search-index rows', () => {
    expect(indexSrc).toContain("if (stores.includes('steam'))");
    expect(indexSrc).toContain("const nonSteam = stores.filter(s => s !== 'steam')");
    expect(indexSrc).toContain('.filter(row => nonSteam.includes(row[5]))');
  });

  test('rating chip counts reflect the selected stores, not just Steam', () => {
    expect(indexSrc).toContain('function updateRatingCounts()');
    expect(indexSrc).toContain("if (stores.includes('steam')) { rated += ratedGames.length; unrated += unratedGames.length; }");
    expect(indexSrc).toContain('if (KNOWN_TIERS.has(String(row[2] || \'\').toLowerCase())) rated++; else unrated++;');
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

  test('selecting any non-Steam store loads the search index once', () => {
    expect(indexSrc).toContain("effectiveStores().some(s => s !== 'steam') && !searchIndexCache");
    expect(indexSrc).toContain('await loadSearchIndex()');
  });

  test('popular list pages with a load more button', () => {
    expect(indexHtml).toContain('id="pg-load-more"');
    expect(indexSrc).toContain('const PAGE_SIZE = 12');
    expect(indexSrc).toContain('all.slice(0, shownCount)');
    expect(indexSrc).toContain('id="pg-load-more-btn"');
    expect(indexSrc).toContain('shownCount += PAGE_SIZE');
  });

  test('changing a filter restarts paging', () => {
    expect(indexSrc).toContain('shownCount = PAGE_SIZE;');
  });
});
