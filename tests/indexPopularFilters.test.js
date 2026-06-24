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
    expect(indexSrc).toContain('if (storeSel.has(store)) storeSel.delete(store);');
    expect(indexSrc).toContain("btn.addEventListener('click', () => toggleStore(btn.dataset.store))");
  });

  test('currentList merges Steam most_played with non-Steam search-index rows', () => {
    expect(indexSrc).toContain("if (storeSel.has('steam'))");
    expect(indexSrc).toContain("const nonSteam = [...storeSel].filter(s => s !== 'steam')");
    expect(indexSrc).toContain('.filter(row => nonSteam.includes(row[5]))');
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
    expect(indexSrc).toContain("[...storeSel].some(s => s !== 'steam') && !searchIndexCache");
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
