/**
 * #361/#376 regression guard: every surface that shows a per-game confidence
 * number (game-page headline, confidence.html breakdown, game-stats.html)
 * must route through computeConfidence in js/lib/scoring/gameStats.js with
 * the same inputs. Two formulas is how 9860 read 92% vs 39% and 277430 read
 * 95% vs 66% -- there must be exactly one.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const GAME = read('js/app/components/game-page.js');
const CONF = read('js/confidence/main.js');
const STATS = read('js/game-stats/main.js');
const { computeConfidence } = require('../js/lib/scoring/gameStats.js');

describe('confidence single-source (#361, #376)', () => {
  test('game page imports computeConfidence from the canonical module', () => {
    expect(GAME).toMatch(/computeConfidence[\s\S]{0,120}from ['"]\.\.\/\.\.\/lib\/scoring\/gameStats\.js/);
  });

  test('game page headline routes through computeConfidence with liveExcess', () => {
    expect(GAME).toMatch(/const overallConfidencePct = computeConfidence\(allReportsForTier, _liveExcess\)\.confidencePct;/);
  });

  test('game page has NO fallback log formula for the headline', () => {
    // The old fallback (30 + log2(n) * 18 inline) is how the two pages
    // diverged. computeConfidence handles the summary-only case itself.
    const headlineRegion = GAME.slice(GAME.indexOf('overallConfidencePct'));
    expect(headlineRegion.slice(0, 500)).not.toContain('Math.log2');
  });

  test('confidence.html breakdown imports and calls computeConfidence', () => {
    expect(CONF).toMatch(/computeConfidence[\s\S]{0,120}from ['"]\.\.\/lib\/scoring\/gameStats\.js/);
    expect(CONF).toContain('computeConfidence(reports, liveExcess)');
  });

  test('confidence.html loads the same inputs as the game page (native + live)', () => {
    expect(CONF).toContain('fetchNativeReports');
    expect(CONF).toContain('fetchProtonDbLive');
  });

  test('confidence.html has no independent log formula for the aggregate', () => {
    // renderGameBreakdown must not recompute 30 + log2(n) * 18.
    const breakdown = CONF.slice(CONF.indexOf('function renderGameBreakdown'));
    expect(breakdown).not.toMatch(/30 \+ Math\.log2/);
  });

  test('game-stats page passes liveExcess into computeGameStats and does not override confidencePct', () => {
    expect(STATS).toContain('computeGameStats(allReports, configs, liveExcess)');
    expect(STATS).not.toContain('stats.confidencePct = combinedTier.confidencePct');
  });
});

describe('computeConfidence behavior (#361)', () => {
  const now = Math.floor(Date.now() / 1000);
  const fresh = (rating) => ({ rating, timestamp: now - 10 * 86400 });

  test('summary-only game (zero held reports) is capped below high confidence', () => {
    // 37 ProtonDB reports known to exist but none mirrored: sample evidence
    // only. Must never reach the >= 80 "high" bucket (#361: 95% vs 66%).
    const { confidencePct, confFactors } = computeConfidence([], 37);
    expect(confidencePct).toBeGreaterThan(0);
    expect(confidencePct).toBeLessThan(80);
    expect(confFactors.some(f => f.label === 'ProtonDB aggregate only')).toBe(true);
  });

  test('zero evidence of any kind scores 0', () => {
    expect(computeConfidence([], 0).confidencePct).toBe(0);
  });

  test('held reports beat a same-size live aggregate', () => {
    const held = computeConfidence([fresh('gold'), fresh('gold'), fresh('gold')], 0);
    const summaryOnly = computeConfidence([], 3);
    expect(held.confidencePct).toBeGreaterThan(summaryOnly.confidencePct);
  });

  test('old reports get staleness-capped', () => {
    const old = [{ rating: 'gold', timestamp: now - 6 * 365 * 86400 },
                 { rating: 'gold', timestamp: now - 6 * 365 * 86400 }];
    const capped = computeConfidence(old, 0);
    const freshRes = computeConfidence([fresh('gold'), fresh('gold')], 0);
    expect(capped.confidencePct).toBeLessThan(freshRes.confidencePct);
    expect(capped.confFactors.some(f => f.label === 'Staleness cap')).toBe(true);
  });

  test('liveExcess raises confidence for a thin mirrored pool', () => {
    const thin = computeConfidence([fresh('gold')], 0);
    const withLive = computeConfidence([fresh('gold')], 100);
    expect(withLive.confidencePct).toBeGreaterThan(thin.confidencePct);
  });
});
