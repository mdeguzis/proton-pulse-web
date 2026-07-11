/**
 * Tests for lib/scoring/gameStats.js -- compute confidence, trend, working status,
 * freshness, monthly buckets, and settings tips from synthetic report data.
 *
 * Loaded as a CommonJS module since gameStats.js exports via module.exports
 * when available (otherwise it just leaks globals for the browser script tag).
 */

// gameStats.js is now an ES module; load it into a vm scope (pure compute, only
// needs standard globals) and pull the named exports off the context.
const { loadEsm } = require('./_esm-vm.js');
const {
  computeGameStats,
  computeMonthlyReports,
  computeWorkingStatus,
  computeFreshness,
  computeSettingsTips,
  isPositive,
  isNegative,
  computeCompatTrend,
} = loadEsm(['js/lib/scoring/gameStats.js'], { Math, Object, Array, Date, JSON, console });

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function rpt(rating, daysAgo, extras = {}) {
  return { rating, timestamp: NOW - daysAgo * DAY, ...extras };
}

describe('isPositive / isNegative', () => {
  test('positive tiers', () => {
    ['platinum', 'gold', 'silver'].forEach(t => expect(isPositive(t)).toBe(true));
    ['bronze', 'borked'].forEach(t => expect(isPositive(t)).toBe(false));
  });
  test('negative tiers', () => {
    ['bronze', 'borked'].forEach(t => expect(isNegative(t)).toBe(true));
    ['platinum', 'gold', 'silver'].forEach(t => expect(isNegative(t)).toBe(false));
  });
});

describe('computeWorkingStatus', () => {
  test('all positive recent => working', () => {
    const reports = [rpt('platinum', 5), rpt('gold', 10), rpt('gold', 30)];
    const ws = computeWorkingStatus(reports, NOW);
    expect(ws.status).toBe('working');
  });

  test('all negative recent => not_working', () => {
    const reports = [rpt('borked', 5), rpt('borked', 10), rpt('bronze', 20)];
    const ws = computeWorkingStatus(reports, NOW);
    expect(ws.status).toBe('not_working');
  });

  test('half-and-half => mixed', () => {
    const reports = [rpt('gold', 5), rpt('borked', 10), rpt('gold', 20), rpt('borked', 30)];
    const ws = computeWorkingStatus(reports, NOW);
    expect(ws.status).toBe('mixed');
  });

  test('no recent => unknown', () => {
    const reports = [rpt('gold', 200), rpt('platinum', 300)];
    const ws = computeWorkingStatus(reports, NOW);
    expect(ws.status).toBe('unknown');
    expect(ws.confidence).toBe('low');
  });

  test('recently_broken: was OK, recent reports flipped to borked', () => {
    const reports = [
      // older recent window: mostly positive
      rpt('gold', 60), rpt('gold', 70), rpt('gold', 80),
      // last 30d: very negative
      rpt('borked', 5), rpt('borked', 10),
    ];
    const ws = computeWorkingStatus(reports, NOW);
    expect(ws.recently_broken).toBe(true);
  });

  test('last_positive_report_age is reported when available', () => {
    const reports = [rpt('gold', 15), rpt('borked', 5)];
    const ws = computeWorkingStatus(reports, NOW);
    expect(ws.last_positive_report_age).toBe(15);
  });

  test('sample size drives confidence', () => {
    const big = Array.from({ length: 12 }, (_, i) => rpt('gold', i + 1));
    expect(computeWorkingStatus(big, NOW).confidence).toBe('high');
    const med = Array.from({ length: 5 }, (_, i) => rpt('gold', i + 1));
    expect(computeWorkingStatus(med, NOW).confidence).toBe('medium');
    const sml = [rpt('gold', 1)];
    expect(computeWorkingStatus(sml, NOW).confidence).toBe('low');
  });
});

describe('computeFreshness', () => {
  test('very fresh', () => {
    const r = [rpt('gold', 10)];
    const f = computeFreshness(r, NOW);
    expect(f.label).toBe('Very fresh');
    expect(f.is_stale).toBe(false);
  });

  test('fresh band (30-90 days)', () => {
    const f = computeFreshness([rpt('gold', 50)], NOW);
    expect(f.label).toBe('Fresh');
    expect(f.is_stale).toBe(false);
  });

  test('aging band', () => {
    const f = computeFreshness([rpt('gold', 120)], NOW);
    expect(f.label).toBe('Aging');
  });

  test('old band (180-365 days)', () => {
    const f = computeFreshness([rpt('gold', 250)], NOW);
    expect(f.label).toBe('Old');
    expect(f.is_stale).toBe(false);
  });

  test('stale beyond a year', () => {
    const r = [rpt('gold', 400)];
    const f = computeFreshness(r, NOW);
    expect(f.label).toBe('Stale');
    expect(f.is_stale).toBe(true);
  });

  test('no data', () => {
    const f = computeFreshness([], NOW);
    expect(f.is_stale).toBe(true);
    expect(f.latest_report_age).toBeNull();
  });
});

describe('computeMonthlyReports', () => {
  test('buckets by YYYY-MM', () => {
    // Use synthetic timestamps for two specific months
    const t1 = Math.floor(new Date('2025-01-15').getTime() / 1000);
    const t2 = Math.floor(new Date('2025-01-25').getTime() / 1000);
    const t3 = Math.floor(new Date('2025-02-10').getTime() / 1000);
    const reports = [
      { rating: 'gold', timestamp: t1 },
      { rating: 'borked', timestamp: t2 },
      { rating: 'platinum', timestamp: t3 },
    ];
    const monthly = computeMonthlyReports(reports);
    expect(monthly).toHaveLength(2);
    expect(monthly[0].month).toBe('2025-01');
    expect(monthly[0].positive).toBe(1);
    expect(monthly[0].negative).toBe(1);
    expect(monthly[1].positive).toBe(1);
  });

  test('skips reports without timestamps', () => {
    const monthly = computeMonthlyReports([{ rating: 'gold' }]);
    expect(monthly).toEqual([]);
  });

  test('neutral/unknown rating counts in bucket but not positive or negative', () => {
    const t1 = Math.floor(new Date('2025-03-10').getTime() / 1000);
    const monthly = computeMonthlyReports([
      { rating: 'gold', timestamp: t1 },
      { rating: 'unknown', timestamp: t1 },
    ]);
    expect(monthly).toHaveLength(1);
    expect(monthly[0].positive).toBe(1);
    expect(monthly[0].negative).toBe(0);
  });
});

describe('computeSettingsTips', () => {
  test('aggregates launch options from positive reports + all configs', () => {
    const reports = [
      rpt('platinum', 5, { launchOptions: 'PROTON_NO_ESYNC=1 -dx11' }),
      rpt('gold', 10, { launchOptions: '-dx11 %command%' }),
      rpt('borked', 5, { launchOptions: 'should-not-count -broken' }),  // negative
    ];
    const configs = [{ launchOptions: 'PROTON_NO_ESYNC=1 %command%' }];
    const tips = computeSettingsTips(reports, configs);
    const flags = tips.map(t => t.flag);
    expect(flags).toContain('-dx11');
    expect(flags).toContain('PROTON_NO_ESYNC=1');
    expect(flags).toContain('%command%');
    expect(flags).not.toContain('-broken');  // came from a borked report
  });

  test('no launch options => empty list', () => {
    const tips = computeSettingsTips([rpt('gold', 5)], []);
    expect(tips).toEqual([]);
  });
});

describe('computeGameStats end-to-end', () => {
  test('combined output structure', () => {
    const reports = [
      rpt('platinum', 5, { protonVersion: 'GE-Proton9-1' }),
      rpt('gold', 30, { protonVersion: 'GE-Proton9-1' }),
      rpt('gold', 60, { protonVersion: 'Proton 9.0' }),
      rpt('borked', 200, { protonVersion: 'Proton 8.0' }),
    ];
    const configs = [{ launchOptions: 'PROTON_NO_ESYNC=1' }];
    const stats = computeGameStats(reports, configs);

    expect(stats.totalReports).toBe(4);
    expect(stats.ratingCounts.platinum).toBe(1);
    expect(stats.ratingCounts.gold).toBe(2);
    expect(stats.ratingCounts.borked).toBe(1);
    expect(stats.versionStats.length).toBeGreaterThan(0);
    expect(stats.workingStatus.status).toBe('working');
    expect(stats.freshness.label).toBe('Very fresh');
    expect(stats.monthly.length).toBeGreaterThan(0);
    expect(stats.confFactors).toHaveLength(3);
  });

  test('confidence is bounded 0-95', () => {
    const reports = Array.from({ length: 100 }, (_, i) => rpt('gold', i + 1));
    const stats = computeGameStats(reports, []);
    expect(stats.confidencePct).toBeLessThanOrEqual(95);
    expect(stats.confidencePct).toBeGreaterThanOrEqual(0);
  });

  test('empty input produces zero confidence', () => {
    const stats = computeGameStats([], []);
    expect(stats.confidencePct).toBe(0);
    expect(stats.totalReports).toBe(0);
  });

  test('trend: declining when recent worse than prior', () => {
    const reports = [
      // prior window (90-270d): all positive
      ...Array.from({ length: 5 }, (_, i) => rpt('platinum', 100 + i * 10)),
      // recent window (<90d): all borked
      ...Array.from({ length: 5 }, (_, i) => rpt('borked', 10 + i * 10)),
    ];
    const stats = computeGameStats(reports, []);
    expect(stats.trendDir).toBe('declining');
  });

  test('trend: improving when recent better than prior', () => {
    const reports = [
      // prior window (90-270d): all borked
      ...Array.from({ length: 5 }, (_, i) => rpt('borked', 100 + i * 10)),
      // recent window (<90d): all platinum
      ...Array.from({ length: 5 }, (_, i) => rpt('platinum', 10 + i * 10)),
    ];
    const stats = computeGameStats(reports, []);
    expect(stats.trendDir).toBe('improving');
  });

  test('trend: platinum -> gold reads as stable, not declining (both playable)', () => {
    // The misleading case this fixes: a drift between two playable tiers must
    // not be a decline. The playable share is unchanged, so it is stable.
    const reports = [
      ...Array.from({ length: 6 }, (_, i) => rpt('platinum', 100 + i * 10)), // prior
      ...Array.from({ length: 6 }, (_, i) => rpt('gold', 5 + i * 5)),         // recent
    ];
    const stats = computeGameStats(reports, []);
    expect(stats.trendDir).toBe('stable');
  });

  test('trend: insufficient when the prior window has too few reports (Stardew case)', () => {
    // A game with 40+ recent playable reports but only 2 old ones must not
    // produce any trend verdict -- 2 reports is not a baseline.
    const reports = [
      rpt('platinum', 200), rpt('platinum', 210),                     // only 2 in the prior window
      ...Array.from({ length: 40 }, (_, i) => rpt('gold', 5 + i)),     // 40 recent, playable
      rpt('borked', 20), rpt('borked', 30),                           // a couple recent borked
    ];
    const stats = computeGameStats(reports, []);
    expect(stats.trendDir).toBe('insufficient');
    expect(stats.recentPositiveRatio).toBeNull();
  });

  describe('computeCompatTrend (playable-share based)', () => {
    const mk = (rating, n) => Array.from({ length: n }, () => ({ rating }));
    test('insufficient below the minimum bucket size in either window', () => {
      const t = computeCompatTrend(mk('gold', 4), mk('gold', 10));
      expect(t.dir).toBe('insufficient');
      expect(t.recentPositiveRatio).toBeNull();
    });
    test('platinum vs gold is stable (playable share unchanged)', () => {
      const t = computeCompatTrend(mk('gold', 8), mk('platinum', 8));
      expect(t.dir).toBe('stable');
      expect(t.delta).toBe(0);
    });
    test('declining when the playable share drops past the threshold', () => {
      const t = computeCompatTrend([...mk('gold', 4), ...mk('borked', 4)], mk('gold', 8));
      expect(t.dir).toBe('declining');
    });
    test('a dip smaller than the threshold stays stable', () => {
      // 7/8 playable (0.875) vs 8/8 (1.0) => -0.125, under the 0.15 threshold
      const t = computeCompatTrend([...mk('gold', 7), ...mk('borked', 1)], mk('gold', 8));
      expect(t.dir).toBe('stable');
    });
    test('improving when the playable share rises past the threshold', () => {
      const t = computeCompatTrend(mk('gold', 8), [...mk('gold', 4), ...mk('borked', 4)]);
      expect(t.dir).toBe('improving');
    });
  });

  test('unknown rating in ratingCounts is ignored gracefully', () => {
    const reports = [
      rpt('gold', 10),
      { rating: 'unknown', timestamp: NOW - 5 * 86400 },
    ];
    const stats = computeGameStats(reports, []);
    expect(stats.ratingCounts.gold).toBe(1);
    expect(stats.totalReports).toBe(2);
  });

  describe('staleness cap', () => {
    test('two very old reports get a low confidence and expose the cap', () => {
      // 2 reports ~2877 days old (~7.9 years) with the same rating.
      // Before: 48% -- consistency was masking the staleness.
      // After: cap kicks in at 40% multiplier for median >= 5-8yr window.
      const reports = [rpt('gold', 2877), rpt('gold', 2877)];
      const stats = computeGameStats(reports, []);
      expect(stats.confidencePct).toBeLessThan(25);
      const stalenessRow = stats.confFactors.find(f => f.label === 'Staleness cap');
      expect(stalenessRow).toBeDefined();
      expect(stalenessRow.detail).toMatch(/years/);
    });

    test('fresh reports do not add a staleness cap row', () => {
      const reports = [rpt('gold', 10), rpt('gold', 20), rpt('platinum', 5)];
      const stats = computeGameStats(reports, []);
      const stalenessRow = stats.confFactors.find(f => f.label === 'Staleness cap');
      expect(stalenessRow).toBeUndefined();
    });

    test('an 8yr+ report scores far worse than a 1yr report of the same rating', () => {
      const fresh = computeGameStats([rpt('gold', 300)], []);
      const ancient = computeGameStats([rpt('gold', 3000)], []);
      expect(ancient.confidencePct).toBeLessThan(fresh.confidencePct);
    });
  });
});
