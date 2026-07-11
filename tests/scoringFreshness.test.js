/**
 * Tiered freshness penalties for per-report scoring. Reports lose confidence
 * sharply as they age -- Proton and game patches move fast enough that a
 * 5+ year old rating tells you almost nothing about the current state.
 */
const { estimateScoreBreakdown, recencyTier, formatAgeHuman } = require('../js/shared/scoring.js');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

describe('recencyTier', () => {
  test('fresh (<90d) is a boost', () => {
    expect(recencyTier(30).value).toBe(15);
    expect(recencyTier(30).label).toMatch(/fresh/);
  });
  test('mid (90-365d) is a small boost', () => {
    expect(recencyTier(200).value).toBe(5);
  });
  test('~1yr old is a small penalty', () => {
    expect(recencyTier(500).value).toBe(-10);
  });
  test('~2yr old is a bigger penalty', () => {
    expect(recencyTier(800).value).toBe(-20);
  });
  test('3-5yr old is a substantial penalty', () => {
    expect(recencyTier(1500).value).toBe(-30);
  });
  test('5-8yr old drops further', () => {
    expect(recencyTier(2000).value).toBe(-40);
  });
  test('8yr+ is the floor penalty', () => {
    expect(recencyTier(3000).value).toBe(-50);
  });
});

describe('formatAgeHuman', () => {
  test('under 30 days -> "N days"', () => {
    expect(formatAgeHuman(5)).toBe('5 days');
    expect(formatAgeHuman(1)).toBe('1 day');
  });
  test('under 365 days -> "N months"', () => {
    expect(formatAgeHuman(90)).toMatch(/months/);
    expect(formatAgeHuman(30)).toBe('1 month');
  });
  test('365+ days -> "N.N years"', () => {
    expect(formatAgeHuman(365)).toBe('1.0 years');
    expect(formatAgeHuman(2877)).toBe('7.9 years');
  });
  test('bad input is guarded', () => {
    expect(formatAgeHuman(-1)).toBe('unknown');
    expect(formatAgeHuman(NaN)).toBe('unknown');
  });
});

describe('estimateScoreBreakdown', () => {
  test('fresh gold: base+recency stays high, detail includes human age', () => {
    const r = { rating: 'gold', timestamp: NOW - 10 * DAY };
    const b = estimateScoreBreakdown(r);
    expect(b.total).toBe(48 + 15);
    const rec = b.factors.find(f => f.label === 'Recency');
    expect(rec.value).toBe(15);
    expect(rec.detail).toMatch(/10 days old/);
  });

  test('2877-day-old gold gets a heavy penalty in the 5-8yr tier', () => {
    // The screenshot case from the user: 2 reports 2877 days old were rendering
    // as 48% confidence -- unreasonable for 8-year-old data. Recency alone now
    // costs 40 points off a 48-point gold baseline.
    const r = { rating: 'gold', timestamp: NOW - 2877 * DAY };
    const b = estimateScoreBreakdown(r);
    const rec = b.factors.find(f => f.label === 'Recency');
    expect(rec.value).toBe(-40);
    expect(rec.detail).toMatch(/7\.9 years/);
    expect(b.total).toBe(48 - 40);
  });

  test('8yr+ report clamps to zero for a low base rating', () => {
    const r = { rating: 'bronze', timestamp: NOW - 3000 * DAY };
    const b = estimateScoreBreakdown(r);
    const rec = b.factors.find(f => f.label === 'Recency');
    expect(rec.value).toBe(-50);
    expect(b.total).toBe(0);
    expect(b.meta.cappedAtZero).toBe(true);
    expect(b.meta.raw).toBeLessThan(0);
  });

  test('unknown rating falls back to the neutral base', () => {
    const r = { rating: 'weird', timestamp: NOW - 5 * DAY };
    const b = estimateScoreBreakdown(r);
    expect(b.factors[0].value).toBe(30);
  });
});
