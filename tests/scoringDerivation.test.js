/**
 * #193: pulseTierDerivation / ratingMixSummary are the single source for the
 * recency-weighted tier and the confidence page's "Why <tier>?" panel.
 */
const {
  pulseTierFromReports, pulseTierDerivation, ratingMixSummary,
  RATING_SCORE, TIER_THRESHOLDS, RECENCY_BUCKETS, recencyBucket, tierForAverage,
} = require('../js/shared/scoring.js');

// Frozen copy of pulseTierFromReports before #193, for parity.
function legacyTier(reports) {
  if (!reports.length) return 'pending';
  const SCORE = { platinum: 1.0, gold: 0.8, silver: 0.6, bronze: 0.4, borked: 0.0 };
  const now = Date.now() / 1000;
  let wSum = 0, wTotal = 0;
  for (const r of reports) {
    const days = (now - (r.timestamp || 0)) / 86400;
    const recency = days < 30 ? 1.0 : days < 90 ? 0.85 : days < 180 ? 0.65 : days < 365 ? 0.40
      : days < 730 ? 0.20 : days < 1095 ? 0.10 : days < 1825 ? 0.05 : 0.02;
    const s = SCORE[String(r.rating || '').toLowerCase()] ?? 0.5;
    wSum += s * recency;
    wTotal += recency;
  }
  const avg = wTotal > 0 ? wSum / wTotal : 0;
  return avg >= 0.85 ? 'platinum' : avg >= 0.65 ? 'gold' : avg >= 0.40 ? 'silver' : avg >= 0.15 ? 'bronze' : 'borked';
}

const DAY = 86400;
const RATINGS = ['platinum', 'gold', 'silver', 'bronze', 'borked', 'Gold', 'Borked', 'weird', ''];

describe('pulseTierFromReports parity with the pre-#193 implementation', () => {
  test('identical tier over many random report sets, including bucket edges', () => {
    const now = Date.now() / 1000;
    const edges = [0, 29.9, 30, 89.9, 90, 179.9, 180, 364.9, 365, 729.9, 730, 1094.9, 1095, 1824.9, 1825, 4000];
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 3000; i += 1) {
      const n = 1 + Math.floor(rand() * 12);
      const reports = Array.from({ length: n }, () => {
        const days = rand() < 0.3 ? edges[Math.floor(rand() * edges.length)] : rand() * 3000;
        return { rating: RATINGS[Math.floor(rand() * RATINGS.length)], timestamp: now - days * DAY };
      });
      expect(pulseTierFromReports(reports).tier).toBe(legacyTier(reports));
    }
  });

  test('empty is pending; count is the report count', () => {
    expect(pulseTierFromReports([])).toEqual({ tier: 'pending', count: 0 });
    expect(pulseTierFromReports([{ rating: 'gold', timestamp: 1 }]).count).toBe(1);
  });
});

describe('pulseTierDerivation', () => {
  const now = 1_800_000_000;
  const reports = [
    { rating: 'Gold', timestamp: now - 10 * DAY, source: 'protondb' },
    { rating: 'gold', timestamp: now - 100 * DAY },
    { rating: 'borked', timestamp: now - 3000 * DAY, source: 'ProtonDB' },
  ];
  const d = pulseTierDerivation(reports, now);

  test('per-report working uses the shared constants', () => {
    expect(d.perReport.map((p) => [p.rating, p.recencyWeight, p.score])).toEqual([
      ['gold', 1.0, 0.8], ['gold', 0.65, 0.8], ['borked', 0.02, 0.0],
    ]);
    expect(d.perReport.map((p) => p.source)).toEqual(['protondb', 'pulse', 'protondb']);
  });

  test('totals, average and tier agree', () => {
    expect(d.wTotal).toBeCloseTo(1.67, 10);
    expect(d.wSum).toBeCloseTo(0.8 + 0.52, 10);
    expect(d.avg).toBeCloseTo(d.wSum / d.wTotal, 10);
    expect(d.tier).toBe('gold');
    expect(d.tier).toBe(tierForAverage(d.avg));
  });

  test('per-tier and per-recency rows only list what is present', () => {
    expect(d.perTier.map((t) => [t.tier, t.count])).toEqual([['gold', 2], ['borked', 1]]);
    expect(d.perTier[0].weightTotal).toBeCloseTo(1.65, 10);
    expect(d.perRecency.map((b) => b.label)).toEqual(['<30d', '90-180d', '5y+']);
  });

  test('bucketing uses the exact age; days is rounded for display only', () => {
    const edge = pulseTierDerivation([{ rating: 'gold', timestamp: now - 29.6 * DAY }], now);
    expect(edge.perReport[0].recencyWeight).toBe(1.0); // 29.6 < 30, even though it displays as 30
    expect(edge.perReport[0].days).toBe(30);
  });

  test('constants are the ones the tier uses', () => {
    expect(RATING_SCORE.gold).toBe(0.8);
    expect(TIER_THRESHOLDS.map((t) => t.min)).toEqual([0.85, 0.65, 0.40, 0.15, 0]);
    expect(RECENCY_BUCKETS.map((b) => b.weight)).toEqual([1.0, 0.85, 0.65, 0.40, 0.20, 0.10, 0.05, 0.02]);
    expect(recencyBucket(5000).label).toBe('5y+');
  });

  test('no reports gives a zero average', () => {
    expect(pulseTierDerivation([], now)).toMatchObject({ avg: 0, perReport: [], perTier: [] });
  });
});

describe('ratingMixSummary', () => {
  test('parts in tier order and a plain sentence', () => {
    const r = ratingMixSummary([{ rating: 'Silver' }, { rating: 'gold' }, { rating: 'gold' }]);
    expect(r.parts).toEqual([{ tier: 'gold', count: 2 }, { tier: 'silver', count: 1 }]);
    expect(r.sentence).toBe('2 Gold, 1 Silver across 3 reports');
  });

  test('custom labels, singular, unrated and empty', () => {
    expect(ratingMixSummary([{ rating: 'borked' }], { borked: 'Broken' }).sentence).toBe('1 Broken across 1 report');
    expect(ratingMixSummary([{ rating: '' }]).sentence).toBe('No rated reports across 1 report');
    expect(ratingMixSummary([]).sentence).toBe('No reports yet');
  });
});

describe('confidence page uses the shared derivation', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'js/confidence/main.js'), 'utf8');
  test('no local copies of the scoring constants', () => {
    expect(src).not.toMatch(/SCORE_MAP\s*=/);
    expect(src).not.toMatch(/const RECENCY\s*=/);
    expect(src).not.toMatch(/const THRESHOLDS\s*=/);
    expect(src).toMatch(/pulseTierDerivation\(reports\)/);
    expect(src).toMatch(/ratingMixSummary\(reports, TIER_LBL\)/);
  });
});
