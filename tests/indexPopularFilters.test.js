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

  test('render combines the two filters and supports any combination', () => {
    expect(indexSrc).toContain('...(state.rated ? ratedGames : [])');
    expect(indexSrc).toContain('...(state.unrated ? unratedGames : [])');
  });

  test('each button toggles its own state independently', () => {
    expect(indexSrc).toContain("state[key] = !state[key]");
    expect(indexSrc).toContain("btn.classList.toggle('pg-filter--active', state[key])");
    expect(indexSrc).toContain("wireFilter(ratedBtn, 'rated')");
    expect(indexSrc).toContain("wireFilter(unratedBtn, 'unrated')");
  });

  test('shows an empty state when both filters are off', () => {
    expect(indexSrc).toContain("class=\"pg-empty\"");
  });
});
