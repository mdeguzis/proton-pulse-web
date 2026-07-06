/**
 * Tests for js/app/components/home-stats-teaser.js summarizeStats (#210).
 *
 * The render side hits fetch + dataUrl; those are integration-tested via
 * smoke. Unit tests here focus on the pure summarizer.
 */

const { summarizeStats } = require('../js/app/components/home-stats-teaser.js');

describe('summarizeStats', () => {
  test('returns null for missing / bad input', () => {
    expect(summarizeStats(null)).toBeNull();
    expect(summarizeStats(undefined)).toBeNull();
    expect(summarizeStats({})).toBeNull();                    // no total_reports
    expect(summarizeStats({ total_reports: 0 })).toBeNull();  // zero total is not useful
  });

  test('computes percentages against total reports (not just rated)', () => {
    const s = summarizeStats({
      total_reports: 1000,
      total_games:   200,
      by_rating: { platinum: 300, gold: 200, silver: 100, bronze: 50, borked: 50 },
    });
    // Rated share: (300+200+100+50+50) / 1000 = 70%
    expect(s.ratedShare).toBe(70);
    expect(s.platinumPct).toBe(30);
    expect(s.borkedPct).toBe(5);
    expect(s.totalReports).toBe(1000);
    expect(s.totalGames).toBe(200);
  });

  test('missing rating buckets treated as zero', () => {
    const s = summarizeStats({
      total_reports: 100,
      by_rating: { platinum: 10 }, // gold/silver/bronze/borked missing
    });
    expect(s.platinumPct).toBe(10);
    expect(s.borkedPct).toBe(0);
    expect(s.ratedShare).toBe(10);
  });

  test('totalGames comes through as null when missing so the render can skip the hint', () => {
    const s = summarizeStats({ total_reports: 50, by_rating: { platinum: 5 } });
    expect(s.totalGames).toBeNull();
  });

  test('rounds percentages to one decimal', () => {
    const s = summarizeStats({
      total_reports: 333,
      by_rating: { platinum: 100, gold: 0, silver: 0, bronze: 0, borked: 33 },
    });
    // 100 / 333 = 30.030...% -> 30
    expect(s.platinumPct).toBe(30);
    // 33 / 333 = 9.909...% -> 9.9
    expect(s.borkedPct).toBe(9.9);
  });
});
