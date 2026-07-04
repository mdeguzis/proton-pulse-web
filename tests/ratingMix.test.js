/**
 * #193: ratingMix is the shared "why this rating" derivation. It returns data
 * (not markup) so the web confidence page and the plugin render the same mix
 * from one canonical helper.
 */
const { ratingMix, RATING_TIER_ORDER } = require('../js/shared/scoring.js');

describe('ratingMix', () => {
  test('non-zero tiers in canonical order with counts', () => {
    const reports = [
      { rating: 'gold' }, { rating: 'platinum' }, { rating: 'gold' },
      { rating: 'borked' }, { rating: 'gold' },
    ];
    expect(ratingMix(reports)).toEqual([
      { tier: 'platinum', count: 1 },
      { tier: 'gold', count: 3 },
      { tier: 'borked', count: 1 },
    ]);
  });

  test('omits zero-count tiers and ignores bad rows', () => {
    const reports = [{ rating: 'silver' }, null, {}, { rating: 'silver' }];
    expect(ratingMix(reports)).toEqual([{ tier: 'silver', count: 2 }]);
  });

  test('empty / missing input yields an empty mix', () => {
    expect(ratingMix([])).toEqual([]);
    expect(ratingMix(undefined)).toEqual([]);
  });

  test('canonical tier order is platinum..borked', () => {
    expect(RATING_TIER_ORDER).toEqual(['platinum', 'gold', 'silver', 'bronze', 'borked']);
  });
});
