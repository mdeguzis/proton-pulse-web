/**
 * #427: ProtonDB CDN mirror emits Capitalized ratings ("Borked", "Gold")
 * while Supabase submissions use lowercase. Every scoring helper keys
 * against lowercase tier tables, so without normalization capitalized
 * ratings never hit the score map / tier order and every game with only
 * CDN reports rendered the wrong tier. Real repro: app 203140 (Hitman:
 * Absolution) has 14 Borked + 2 Gold from ~7 years ago; game page badge
 * showed silver (the 0.5 fallback average) while cards + search index
 * correctly showed borked.
 */

const {
  tierFromReports, pulseTierFromReports, ratingMix,
} = require('../js/shared/scoring.js');

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

// A 203140-shaped fixture: 14 borked + 2 gold, all ~7 years old. Repeated
// twice, once fully lowercase (Supabase-shaped) and once Capitalized
// (ProtonDB CDN-shaped). Both must produce the same tier.
function fixture(caseFn) {
  const oldTs = NOW - 2600 * DAY; // ~7 yrs
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push({ rating: caseFn('borked'), timestamp: oldTs - i * DAY });
  for (let i = 0; i < 2;  i++) rows.push({ rating: caseFn('gold'),   timestamp: oldTs - (14 + i) * DAY });
  return rows;
}
const lower = fixture(s => s);
const caps  = fixture(s => s.charAt(0).toUpperCase() + s.slice(1));

describe('scoring: rating case normalization (#427)', () => {
  describe('pulseTierFromReports', () => {
    test('capitalized ratings produce the same tier as lowercase', () => {
      expect(pulseTierFromReports(caps).tier).toBe(pulseTierFromReports(lower).tier);
    });

    test('203140-shaped fixture (14 Borked + 2 Gold, ~7yr) computes borked, not silver', () => {
      // With the bug, every capitalized rating fell through to the ??0.5
      // fallback and the weighted average landed at exactly 0.5 -> silver.
      // Correct math for this fixture: 14 * 0.0 + 2 * 0.8 all * 0.02 recency
      // -> avg 0.10 -> borked.
      const out = pulseTierFromReports(caps);
      expect(out.tier).toBe('borked');
      expect(out.count).toBe(16);
    });

    test('mixed-case within one input is handled', () => {
      const mixed = [
        { rating: 'BORKED', timestamp: NOW - 10 * DAY },
        { rating: 'Borked', timestamp: NOW - 20 * DAY },
        { rating: 'borked', timestamp: NOW - 30 * DAY },
      ];
      expect(pulseTierFromReports(mixed).tier).toBe('borked');
    });

    test('unknown ratings still fall through to the 0.5 midpoint', () => {
      // Defense against silent behavior change: normalization only lowercases,
      // it does NOT reject unknown ratings. Weird rating strings still count
      // as neutral (avoids losing reports on typo/experimental new tiers).
      const weird = [{ rating: 'awesome', timestamp: NOW - 10 * DAY }];
      expect(pulseTierFromReports(weird).tier).toBe('silver'); // 0.5 -> silver
    });
  });

  describe('tierFromReports', () => {
    test('capitalized ratings register in counts (was returning pending)', () => {
      expect(tierFromReports([{ rating: 'Borked' }])).toBe('borked');
      expect(tierFromReports([{ rating: 'Gold' }])).toBe('gold');
    });

    test('mixed capitalization picks the highest-tier present', () => {
      const rows = [{ rating: 'Borked' }, { rating: 'gold' }, { rating: 'BORKED' }];
      // gold > borked in canonical order
      expect(tierFromReports(rows)).toBe('gold');
    });
  });

  describe('ratingMix', () => {
    test('capitalized ratings bucket into the same lowercase tier', () => {
      const rows = [
        { rating: 'Borked' }, { rating: 'borked' }, { rating: 'BORKED' },
        { rating: 'Gold' },
      ];
      expect(ratingMix(rows)).toEqual([
        { tier: 'gold', count: 1 },
        { tier: 'borked', count: 3 },
      ]);
    });
  });
});
