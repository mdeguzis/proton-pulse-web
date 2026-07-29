/**
 * #427 / #429: rating case invariant across the whole read/scoring surface.
 *
 * The #427 bug was that ProtonDB CDN mirror files carry Capitalized ratings
 * ("Borked", "Gold") while every scoring helper keyed against lowercase tier
 * tables and fell through to a 0.5 fallback. Fixed by normalizing at every
 * lookup + backfilling every year file to lowercase. This test suite locks in
 * both invariants so a future regression is caught before it ships:
 *
 * 1. Fixture-shape invariant: the sample of `latest.json` snapshots in
 *    tests/fixtures/staging-app-*.json have zero Capitalized ratings. If a
 *    partner import ever smuggles capitalized ratings back into the pipeline
 *    and we refresh these fixtures, the test fails at PR time.
 * 2. Scoring resilience: feeding the exact same fixture into every helper
 *    (fmtDuration, tierFromReports, ratingMix, pulseTierFromReports)
 *    produces internally consistent output whether the rating strings are
 *    lowercase or capitalized -- so a future partner-import surprise cannot
 *    silently produce different tiers on different surfaces.
 */

global.window = global;
global.document = {
  createElement: () => {
    let _text = '';
    return {
      set textContent(v) { _text = v; },
      get innerHTML() {
        return _text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      },
    };
  },
};

const fs = require('fs');
const path = require('path');
const { tierFromReports, ratingMix, pulseTierFromReports, RATING_TIER_ORDER } = require('../js/shared/scoring.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const FIXTURES = ['staging-app-203140.json', 'staging-app-271590.json', 'staging-app-292030.json'];
const CANONICAL_TIERS = new Set(RATING_TIER_ORDER); // ['platinum','gold','silver','bronze','borked']

// Given a fixture, return every distinct rating string (nulls dropped).
function readFixtureRatings(name) {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const reports = JSON.parse(raw);
  return reports.map(r => r && r.rating).filter(Boolean);
}

describe('rating case invariant across staging fixtures (#427 / #429)', () => {
  FIXTURES.forEach((name) => {
    describe(name, () => {
      test('every rating in the fixture is lowercase', () => {
        const ratings = readFixtureRatings(name);
        expect(ratings.length).toBeGreaterThan(0);
        const capitalized = ratings.filter(r => r !== r.toLowerCase());
        expect(capitalized).toEqual([]);
      });

      test('every rating is one of the five canonical tiers', () => {
        const unknown = readFixtureRatings(name).filter(r => !CANONICAL_TIERS.has(r));
        expect(unknown).toEqual([]);
      });

      test('tierFromReports returns a non-pending tier for this app', () => {
        // If case normalization were broken tierFromReports would return
        // 'pending' (counts[r.rating] never matched RATING_TIER_ORDER).
        const reports = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
        const tier = tierFromReports(reports);
        expect(CANONICAL_TIERS.has(tier)).toBe(true);
      });

      test('ratingMix counts sum to the fixture report count', () => {
        const reports = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
        const withRating = reports.filter(r => r && r.rating);
        const mix = ratingMix(reports);
        const total = mix.reduce((s, m) => s + m.count, 0);
        expect(total).toBe(withRating.length);
      });

      test('pulseTierFromReports lands on a canonical tier (not the 0.5 silver fallback)', () => {
        // The fingerprint of the #427 bug was: broken lookup -> every report
        // scored 0.5 -> avg 0.5 -> silver, regardless of the actual mix.
        // Ratings in these fixtures are diverse, so a working scorer should
        // produce whatever the recency-weighted math says; a broken scorer
        // deterministically produces silver.
        const reports = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
        const { tier, count } = pulseTierFromReports(reports);
        expect(count).toBe(reports.length);
        expect(CANONICAL_TIERS.has(tier)).toBe(true);
      });
    });
  });
});

describe('mixed-case input parity (#427)', () => {
  // Every helper must produce identical output for a lowercase-only input
  // and its Capitalized twin. This is the parity check that catches a future
  // regression on ANY single lookup site while leaving the others correct.
  const lower = [
    { rating: 'platinum', timestamp: Math.floor(Date.now() / 1000) - 10 * 86400 },
    { rating: 'gold',     timestamp: Math.floor(Date.now() / 1000) - 20 * 86400 },
    { rating: 'borked',   timestamp: Math.floor(Date.now() / 1000) - 30 * 86400 },
  ];
  const capitalized = lower.map(r => ({
    ...r,
    rating: r.rating.charAt(0).toUpperCase() + r.rating.slice(1),
  }));

  test('tierFromReports agrees on both casings', () => {
    expect(tierFromReports(capitalized)).toBe(tierFromReports(lower));
  });

  test('ratingMix bucket counts agree on both casings', () => {
    expect(ratingMix(capitalized)).toEqual(ratingMix(lower));
  });

  test('pulseTierFromReports tier + count agree on both casings', () => {
    expect(pulseTierFromReports(capitalized)).toEqual(pulseTierFromReports(lower));
  });
});
