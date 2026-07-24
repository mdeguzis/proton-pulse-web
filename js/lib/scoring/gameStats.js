// Per-game stats engine. Canonical source for compatibility stats math
// shared between the webui and the decky-proton-pulse plugin.
//
// Used by:
//   - game-stats.html (classic script tag, creates window globals)
//   - tests/gameStats.test.js (CommonJS require, via module.exports shim)
//   - decky-proton-pulse plugin (synced into src/lib/scoring/_synced/
//     by `make sync-scoring`, then wrapped in TypeScript shims)
//
// Inspired by protondb-decky's AnalysisModal (working_status, recently_broken,
// last_positive_age, stale, monthly chart) but our own implementation that
// fits the Pulse data model.
//
// Pure functions, no DOM, no fetch. All consumers pass in
//   allReports: array with .rating, .protonVersion, .timestamp, optional .launchOptions
//   configs:    array with optional .launchOptions / .launch_options

// --- constants ---

/** Numeric value assigned to each rating tier, used for averaging and variance calculations. */
export const RATING_VAL = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };
/** Tiers considered a successful compatibility outcome. */
export const POSITIVE_TIERS = ['platinum', 'gold', 'silver'];
/** Tiers considered a failed or degraded compatibility outcome. */
export const NEGATIVE_TIERS = ['bronze', 'borked'];

// Stale threshold: a game with no recent reports is "stale". We pick 365d
// because Proton itself ships major releases roughly yearly, so anything
// older than a year is suspect for current Proton.
export const STALE_DAYS = 365;
export const RECENT_DAYS = 90;
export const PRIOR_WINDOW_DAYS = 270;  // 90-270d is the prior bucket for trend

// --- helpers ---

/**
 * Returns true if rating is a positive compatibility outcome (platinum, gold, silver).
 * @param {string} rating
 * @returns {boolean}
 */
export function isPositive(rating) {
  return POSITIVE_TIERS.includes(rating);
}

/**
 * Returns true if rating is a negative compatibility outcome (bronze, borked).
 * @param {string} rating
 * @returns {boolean}
 */
export function isNegative(rating) {
  return NEGATIVE_TIERS.includes(rating);
}

/**
 * Compatibility trend between a recent window and a prior window.
 *
 * Based on the SHARE OF PLAYABLE reports (platinum/gold/silver via isPositive),
 * not a linear tier average. This is deliberate: a shift between two playable
 * tiers (e.g. platinum -> gold) must NOT read as a decline, because the game
 * still works fine. Only a real change in how often the game is playable moves
 * the needle. A minimum sample is required in BOTH windows, so a tiny baseline
 * (e.g. two old reports) can never drive a red "declining" verdict -- that was
 * the misleading case this replaces.
 *
 * @param {Array<{rating: string}>} recentReps reports in the recent window
 * @param {Array<{rating: string}>} priorReps reports in the prior window
 * @param {{minBucket?: number, threshold?: number}} [opts]
 *   minBucket: reports required in EACH window before a trend is claimed (default 5)
 *   threshold: playable-share change (0-1) needed to call it (default 0.15 = 15 pts)
 * @returns {{ dir: 'improving'|'declining'|'stable'|'insufficient', delta: number,
 *   recentPositiveRatio: number|null, priorPositiveRatio: number|null,
 *   recentCount: number, priorCount: number }}
 */
export function computeCompatTrend(recentReps, priorReps, opts = {}) {
  const minBucket = opts.minBucket != null ? opts.minBucket : 5;
  const threshold = opts.threshold != null ? opts.threshold : 0.15;
  const recentCount = Array.isArray(recentReps) ? recentReps.length : 0;
  const priorCount = Array.isArray(priorReps) ? priorReps.length : 0;
  // Not enough data in one (or both) windows to make an honest comparison.
  if (recentCount < minBucket || priorCount < minBucket) {
    return { dir: 'insufficient', delta: 0, recentPositiveRatio: null, priorPositiveRatio: null, recentCount, priorCount };
  }
  const ratio = arr => arr.filter(r => isPositive(r.rating)).length / arr.length;
  const recentPositiveRatio = ratio(recentReps);
  const priorPositiveRatio = ratio(priorReps);
  const delta = recentPositiveRatio - priorPositiveRatio; // + => more playable recently
  let dir = 'stable';
  if (delta >= threshold) dir = 'improving';
  else if (delta <= -threshold) dir = 'declining';
  return { dir, delta, recentPositiveRatio, priorPositiveRatio, recentCount, priorCount };
}

/**
 * Returns the age of a Unix timestamp in whole days relative to now, or null if ts is falsy.
 * @param {number|null} ts - Unix timestamp in seconds.
 * @param {number} now - Current time in seconds.
 * @returns {number|null}
 */
export function ageDays(ts, now) {
  /* istanbul ignore next */
  if (!ts) return null;
  return Math.floor((now - ts) / 86400);
}

// --- per-month report counts for the chart (positive vs negative) ---

/**
 * Buckets reports by calendar month and counts positive vs negative ratings.
 * Returns an array sorted chronologically, one entry per month that has at least one report.
 * @param {Array<{rating: string, timestamp: number}>} allReports
 * @returns {Array<{month: string, positive: number, negative: number}>}
 */
export function computeMonthlyReports(allReports) {
  // bucket YYYY-MM -> { positive, negative }
  const buckets = {};
  for (const r of allReports) {
    if (!r.timestamp) continue;
    const d = new Date(r.timestamp * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!buckets[key]) buckets[key] = { positive: 0, negative: 0 };
    if (isPositive(r.rating)) buckets[key].positive++;
    else if (isNegative(r.rating)) buckets[key].negative++;
  }
  return Object.entries(buckets)
    .map(([month, counts]) => ({ month, ...counts }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// --- working status (binary: is it working RIGHT NOW based on recent data) ---
// Heuristic: look at last RECENT_DAYS of reports. If >=60% positive => working,
// if >=60% negative => not_working, else unknown.
/**
 * Determines whether a game is currently working based on recent reports.
 * Uses the last RECENT_DAYS window (90d). Sets recently_broken if the last 30d
 * flipped negative while the broader 90d window was mostly positive.
 * @param {Array<{rating: string, timestamp: number}>} allReports
 * @param {number} now - Current time in seconds.
 * @returns {{ status: 'working'|'not_working'|'mixed'|'unknown', confidence: 'high'|'medium'|'low', recently_broken: boolean, timeframe_days: number, last_positive_report_age: number|null }}
 */
export function computeWorkingStatus(allReports, now) {
  const recent = allReports.filter(r => r.timestamp && now - r.timestamp < RECENT_DAYS * 86400);
  if (recent.length === 0) {
    return {
      status: 'unknown',
      confidence: 'low',
      recently_broken: false,
      timeframe_days: RECENT_DAYS,
      last_positive_report_age: null,
    };
  }

  const pos = recent.filter(r => isPositive(r.rating)).length;
  const neg = recent.filter(r => isNegative(r.rating)).length;
  const posRatio = pos / recent.length;
  const negRatio = neg / recent.length;

  let status, confidence;
  if (posRatio >= 0.6) { status = 'working'; }
  else if (negRatio >= 0.6) { status = 'not_working'; }
  else { status = 'mixed'; }

  // Confidence based on sample size in the recent window
  if (recent.length >= 10) confidence = 'high';
  else if (recent.length >= 4) confidence = 'medium';
  else confidence = 'low';

  // "Recently broken" = trend flipped negative in the last 30d after being
  // mostly positive in the broader RECENT_DAYS window
  const veryRecent = allReports.filter(r => r.timestamp && now - r.timestamp < 30 * 86400);
  const recently_broken = veryRecent.length >= 2
    && veryRecent.filter(r => isNegative(r.rating)).length / veryRecent.length >= 0.6
    && posRatio >= 0.5;  // older window was OK, recent flipped

  // last positive report age (across ALL reports, not just recent window)
  const lastPos = allReports
    .filter(r => isPositive(r.rating) && r.timestamp)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return {
    status,
    confidence,
    recently_broken,
    timeframe_days: RECENT_DAYS,
    last_positive_report_age: lastPos ? ageDays(lastPos.timestamp, now) : null,
  };
}

// --- freshness (how recent is the latest data) ---
/**
 * Returns a human-readable freshness label and the age of the most recent report.
 * Labels: 'Very fresh' (<30d), 'Fresh' (<90d), 'Aging' (<180d), 'Old' (<365d), 'Stale' (>=365d).
 * @param {Array<{timestamp: number}>} allReports
 * @param {number} now - Current time in seconds.
 * @returns {{ label: string, latest_report_age: number|null, is_stale: boolean }}
 */
export function computeFreshness(allReports, now) {
  const withTs = allReports.filter(r => r.timestamp).sort((a, b) => b.timestamp - a.timestamp);
  if (withTs.length === 0) {
    return { label: 'No data', latest_report_age: null, is_stale: true };
  }
  const latestAge = ageDays(withTs[0].timestamp, now);
  let label;
  if (latestAge < 30) label = 'Very fresh';
  else if (latestAge < 90) label = 'Fresh';
  else if (latestAge < 180) label = 'Aging';
  else if (latestAge < STALE_DAYS) label = 'Old';
  else label = 'Stale';
  return { label, latest_report_age: latestAge, is_stale: latestAge >= STALE_DAYS };
}

// --- settings tips: common launch options from positive reports only ---
// Different from "launch flags frequency" because we only count tokens from
// reports that are platinum/gold/silver. Surfaces the tweaks that actually work
/**
 * Extracts the most common launch option flags from positive reports and configs.
 * Only platinum/gold/silver reports are included, so the output reflects tweaks
 * that correlate with success. Returns at most 15 entries sorted by frequency.
 * @param {Array<{rating: string, launchOptions?: string}>} allReports
 * @param {Array<{launchOptions?: string, launch_options?: string}>} configs
 * @returns {Array<{flag: string, cnt: number, pct: number}>}
 */
export function computeSettingsTips(allReports, configs) {
  const positiveSources = [
    ...allReports.filter(r => isPositive(r.rating)),
    ...configs,
  ];
  const flagMap = {};
  let totalWithLaunch = 0;
  for (const item of positiveSources) {
    const lo = item.launchOptions || item.launch_options || '';
    if (!lo) continue;
    totalWithLaunch++;
    const tokens = lo.split(/\s+/).filter(t => t.startsWith('%') || t.startsWith('-') || /^[A-Z_]+=/.test(t));
    for (const tok of tokens) {
      flagMap[tok] = (flagMap[tok] || 0) + 1;
    }
  }
  return Object.entries(flagMap)
    .map(([flag, cnt]) => ({
      flag,
      cnt,
      pct: totalWithLaunch > 0 ? Math.round((cnt / totalWithLaunch) * 100) : 0,
    }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 15);  // top 15
}

// --- main entry point ---
//
// Combines the original per-game stats (confidence, trend, version stats,
// rating distribution) with protondb-decky-inspired metrics (working status,
// freshness, monthly chart, settings tips).
/**
 * Main entry point. Computes the full per-game compatibility stats object.
 * Aggregates rating distribution, confidence score (sample size + tier consistency +
 * freshness), trend direction (recent 90d vs prior 90-270d window), per-Proton-version
 * success percentages, launch flag frequency, and the new working-status/freshness/
 * monthly-chart/settings-tips metrics.
 * @param {Array<{rating: string, timestamp: number, protonVersion?: string, launchOptions?: string}>} allReports
 * @param {Array<{launchOptions?: string, launch_options?: string}>} configs
 * @returns {{ confidencePct: number, confFactors: Array, trendDir: string, trendDiff: number, recentPositiveRatio: number|null, olderPositiveRatio: number|null, recentCount: number, priorCount: number, versionStats: Array, launchFlags: Array, ratingCounts: object, totalReports: number, monthly: Array, workingStatus: object, freshness: object, settingsTips: Array }}
 */
export function computeGameStats(allReports, configs) {
  const now = Date.now() / 1000;
  const n = allReports.length;

  // --- Rating distribution ---
  const ratingCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0 };
  for (const r of allReports) {
    if (ratingCounts[r.rating] != null) ratingCounts[r.rating]++;
  }

  // --- Confidence: sample size + tier consistency + freshness ---
  const sampleFactor = n > 0 ? Math.min(1.0, Math.log2(Math.max(1, n)) / Math.log2(50)) : 0;
  let consistencyFactor = 0;
  if (n > 0) {
    const vals = allReports.map(r => RATING_VAL[r.rating] || 3);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const stdDev = Math.sqrt(variance);
    consistencyFactor = Math.max(0, 1 - stdDev / 2);
  }
  let freshnessSum = 0, freshnessTotal = 0;
  const ageDaysList = [];
  for (const r of allReports) {
    const days = (now - (r.timestamp || 0)) / 86400;
    ageDaysList.push(days);
    const w = days < 90 ? 1.0
      : days < 365 ? 0.60
      : days < 730 ? 0.30
      : days < 1095 ? 0.15
      : days < 1825 ? 0.05
      : 0.0;
    freshnessSum += w;
    freshnessTotal++;
  }
  const freshnessFactor = freshnessTotal > 0 ? freshnessSum / freshnessTotal : 0;
  // Staleness cap: when the median report is very old, hard-cap the overall
  // confidence. A tight cluster of ratings still "reads" consistent but tells
  // us little about a Proton stack from 5+ years ago.
  const sortedAges = [...ageDaysList].sort((a, b) => a - b);
  const medianDays = sortedAges.length > 0 ? sortedAges[Math.floor(sortedAges.length / 2)] : 0;
  const stalenessCap = medianDays < 365 ? 1.0
    : medianDays < 730 ? 0.85
    : medianDays < 1095 ? 0.70
    : medianDays < 1825 ? 0.55
    : medianDays < 2920 ? 0.40
    : 0.25;
  const rawConf = n > 0 ? (sampleFactor * 0.45 + consistencyFactor * 0.35 + freshnessFactor * 0.20) : 0;
  const confidencePct = Math.min(95, Math.round(rawConf * 100 * stalenessCap));
  const medianHuman = medianDays < 30 ? `${Math.round(medianDays)} days`
    : medianDays < 365 ? `${Math.round(medianDays / 30)} months`
    : `${(medianDays / 365).toFixed(1)} years`;
  const confFactors = [
    { label: 'Sample size', value: Math.round(sampleFactor * 100), detail: `${n} report${n !== 1 ? 's' : ''} (log curve, 45% weight)` },
    { label: 'Tier consistency', value: Math.round(consistencyFactor * 100), detail: 'How tightly clustered ratings are (35% weight)' },
    { label: 'Data freshness', value: Math.round(freshnessFactor * 100), detail: 'Recency-weighted freshness (20% weight)' },
  ];
  if (n > 0 && stalenessCap < 1.0) {
    confFactors.push({
      label: 'Staleness cap',
      value: Math.round(stalenessCap * 100),
      detail: `median report is ${medianHuman} old; overall confidence capped at ${Math.round(stalenessCap * 100)}%`,
    });
  }

  // --- Trend ---
  // Playable-share based (see computeCompatTrend): a platinum->gold drift is not
  // a decline, and a trend is only claimed when both windows are well sampled.
  const recentReps = allReports.filter(r => r.timestamp && now - r.timestamp < RECENT_DAYS * 86400);
  const priorReps = allReports.filter(r => r.timestamp && now - r.timestamp >= RECENT_DAYS * 86400 && now - r.timestamp < PRIOR_WINDOW_DAYS * 86400);
  const trend = computeCompatTrend(recentReps, priorReps);
  const trendDir = trend.dir;
  const trendDiff = trend.delta;
  const recentPositiveRatio = trend.recentPositiveRatio;
  const olderPositiveRatio = trend.priorPositiveRatio;

  // --- Per-Proton-version success % ---
  const versionMap = {};
  for (const r of allReports) {
    const ver = r.protonVersion || r.proton_version || 'Unknown';
    if (!versionMap[ver]) versionMap[ver] = { total: 0, positive: 0 };
    versionMap[ver].total++;
    if (isPositive(r.rating)) versionMap[ver].positive++;
  }
  const versionStats = Object.entries(versionMap)
    .map(([ver, s]) => ({ ver, total: s.total, pct: Math.round((s.positive / s.total) * 100) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  // --- Launch option flag frequency (all sources) ---
  const flagMap = {};
  const allSources = [...configs, ...allReports];
  for (const item of allSources) {
    const lo = item.launchOptions || item.launch_options || '';
    if (!lo) continue;
    const tokens = lo.split(/\s+/).filter(t => t.startsWith('%') || t.startsWith('-') || /^[A-Z_]+=/.test(t));
    for (const tok of tokens) {
      flagMap[tok] = (flagMap[tok] || 0) + 1;
    }
  }
  const totalSources = allSources.filter(item => (item.launchOptions || item.launch_options)).length;
  const launchFlags = Object.entries(flagMap)
    .map(([flag, cnt]) => ({ flag, cnt, pct: totalSources > 0 ? Math.round((cnt / totalSources) * 100) : /* istanbul ignore next */ 0 }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 10);

  // --- new metrics ---
  const monthly = computeMonthlyReports(allReports);
  const workingStatus = computeWorkingStatus(allReports, now);
  const freshness = computeFreshness(allReports, now);
  const settingsTips = computeSettingsTips(allReports, configs);

  return {
    confidencePct,
    confFactors,
    trendDir,
    trendDiff,
    recentPositiveRatio,
    olderPositiveRatio,
    recentCount: recentReps.length,
    priorCount: priorReps.length,
    versionStats,
    launchFlags,
    ratingCounts,
    totalReports: n,
    monthly,
    workingStatus,
    freshness,
    settingsTips,
  };
}

// Tests need access; in the browser these are just window-level globals.
if (typeof module !== 'undefined' && /* istanbul ignore next */ module.exports) {
  module.exports = {
    computeGameStats,
    computeMonthlyReports,
    computeWorkingStatus,
    computeFreshness,
    computeSettingsTips,
    isPositive,
    isNegative,
    computeCompatTrend,
  };
}
