const fs = require('fs');
const path = require('path');

const homeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'),
  'utf8'
);

describe('home page tier filter', () => {
  test('Tier select includes "Rated only" option', () => {
    expect(homeSrc).toContain('value="rated"');
    expect(homeSrc).toContain('Rated only');
  });

  test('_filterByTier handles "rated" value by checking KNOWN_TIERS', () => {
    expect(homeSrc).toContain("if (tier === 'rated') return reports.filter(r => KNOWN_TIERS.has(r.tier))");
  });

  test('unrated toggle always rendered regardless of unratedGames length', () => {
    // The toggle must not be gated behind a length check that hides it entirely
    expect(homeSrc).not.toMatch(/unratedGames\.length\s*\?\s*`<button[^`]+unrated-toggle/);
    expect(homeSrc).toContain('id="unrated-toggle"');
  });

  test('applyPopularFilters treats "rated" same as "all" for rated games list', () => {
    expect(homeSrc).toContain("currentTier !== 'all' && currentTier !== 'rated'");
  });
});
