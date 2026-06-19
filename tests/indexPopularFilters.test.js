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

  test('render shows whichever single filter is active', () => {
    expect(indexSrc).toContain('...(state.rated ? ratedGames : [])');
    expect(indexSrc).toContain('...(state.unrated ? unratedGames : [])');
  });

  test('Rated / Not Rated are mutually exclusive (selecting one deselects the other)', () => {
    expect(indexSrc).toContain("state.rated = key === 'rated'");
    expect(indexSrc).toContain("state.unrated = key === 'unrated'");
    expect(indexSrc).toContain("ratedBtn?.addEventListener('click', () => selectFilter('rated'))");
    expect(indexSrc).toContain("unratedBtn?.addEventListener('click', () => selectFilter('unrated'))");
    // old independent-toggle behavior is gone
    expect(indexSrc).not.toContain('state[key] = !state[key]');
  });

  test('popular list pages with a load more button', () => {
    expect(indexHtml).toContain('id="pg-load-more"');
    expect(indexSrc).toContain('const PAGE_SIZE = 12');
    expect(indexSrc).toContain('all.slice(0, shownCount)');
    expect(indexSrc).toContain('id="pg-load-more-btn"');
    expect(indexSrc).toContain('shownCount += PAGE_SIZE');
  });

  test('changing a filter restarts paging', () => {
    expect(indexSrc).toContain('shownCount = PAGE_SIZE; // restart paging when the filter changes');
  });
});
