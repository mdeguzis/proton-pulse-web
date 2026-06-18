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

describe('index page popular games unrated toggle', () => {
  test('index.html renders the unrated toggle button and count', () => {
    expect(indexHtml).toContain('id="pg-unrated-toggle"');
    expect(indexHtml).toContain('id="pg-unrated-count"');
    expect(indexHtml).toContain('Not rated yet');
  });

  test('main.js splits rated vs unrated using KNOWN_TIERS', () => {
    expect(indexSrc).toContain("const KNOWN_TIERS = new Set(['platinum', 'gold', 'silver', 'bronze', 'borked'])");
    expect(indexSrc).toContain('const ratedGames = games.filter((g) => KNOWN_TIERS.has(String(g.rating || \'\').toLowerCase()))');
    expect(indexSrc).toContain('const unratedGames = games.filter((g) => !KNOWN_TIERS.has(String(g.rating || \'\').toLowerCase()))');
  });

  test('only rated games render by default', () => {
    expect(indexSrc).toContain('list.innerHTML = ratedGames.map(pgCardHtml).join(\'\')');
  });

  test('toggle reveals unrated games and is disabled when none exist', () => {
    expect(indexSrc).toContain("toggle.disabled = unratedGames.length === 0");
    expect(indexSrc).toContain("showingUnrated ? [...ratedGames, ...unratedGames] : ratedGames");
    expect(indexSrc).toContain("toggle.classList.toggle('unrated-toggle--active', showingUnrated)");
  });
});
