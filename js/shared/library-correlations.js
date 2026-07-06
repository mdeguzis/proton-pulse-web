// library-correlations.js -- pure aggregation for Phase E (#209).
//
// The stats "My Library" tab cross-references a signed-in user's owned Steam
// appids with community user_configs reports on similar hardware, then runs
// each report's text through the analytics-patterns matchers to surface which
// optimizations tend to help across the library.
//
// This module holds the pure logic (test-friendly). The view layer in
// js/stats/library-view.js does the fetching + rendering.

import { matchReport } from './analytics-patterns.js?v=c119f011';

/**
 * Aggregate one pattern group across a list of user_configs rows scoped to
 * the user's owned games.
 *
 * @param {Array<Object>} reports  user_configs rows. Each row must have
 *   `app_id` and one or more of the notes / launch-option / form_responses
 *   fields the matcher understands.
 * @param {Set<string>|Array<string>} ownedAppIds  the user's owned Steam
 *   appids (as strings). Reports outside this set are dropped.
 * @param {Array<{key: string, label: string, matchers: RegExp[]}>} patternGroup
 *   e.g. OPTIMIZATION_PATTERNS from analytics-patterns.js.
 * @returns {{
 *   perPattern: Array<{ key: string, label: string, gameCount: number, reportCount: number }>,
 *   perGame:    Array<{ appId: string, topPattern: string, patterns: string[], reportCount: number }>,
 *   totalReports: number,
 *   totalGames:   number,
 * }}
 */
export function aggregateLibraryPatterns(reports, ownedAppIds, patternGroup) {
  const empty = { perPattern: [], perGame: [], totalReports: 0, totalGames: 0 };
  if (!Array.isArray(reports) || reports.length === 0) return empty;
  if (!Array.isArray(patternGroup) || patternGroup.length === 0) return empty;

  const owned = ownedAppIds instanceof Set
    ? ownedAppIds
    : new Set((ownedAppIds || []).map(String));
  if (owned.size === 0) return empty;

  const labelByKey = new Map(patternGroup.map(g => [g.key, g.label]));
  const patternGameSet = new Map(patternGroup.map(g => [g.key, new Set()]));
  const patternReportCount = new Map(patternGroup.map(g => [g.key, 0]));
  const gameStats = new Map(); // appId -> { patternCounts: Map, reportCount }

  let scannedReports = 0;
  const gamesTouched = new Set();

  for (const r of reports) {
    const appId = String(r.app_id ?? r.appId ?? '');
    if (!appId || !owned.has(appId)) continue;
    scannedReports++;
    gamesTouched.add(appId);

    const hits = matchReport(r, patternGroup);
    let gs = gameStats.get(appId);
    if (!gs) { gs = { patternCounts: new Map(), reportCount: 0 }; gameStats.set(appId, gs); }
    gs.reportCount++;
    for (const key of hits) {
      patternGameSet.get(key)?.add(appId);
      patternReportCount.set(key, (patternReportCount.get(key) || 0) + 1);
      gs.patternCounts.set(key, (gs.patternCounts.get(key) || 0) + 1);
    }
  }

  const perPattern = patternGroup
    .map(g => ({
      key: g.key,
      label: labelByKey.get(g.key) || g.key,
      gameCount:   patternGameSet.get(g.key)?.size || 0,
      reportCount: patternReportCount.get(g.key) || 0,
    }))
    .filter(p => p.gameCount > 0)
    .sort((a, b) => b.gameCount - a.gameCount || b.reportCount - a.reportCount);

  const perGame = [...gameStats.entries()]
    .map(([appId, gs]) => {
      const sorted = [...gs.patternCounts.entries()].sort((a, b) => b[1] - a[1]);
      return {
        appId,
        reportCount: gs.reportCount,
        patterns: sorted.map(([k]) => k),
        topPattern: sorted[0]?.[0] || null,
      };
    })
    .filter(g => g.topPattern != null)
    .sort((a, b) => b.reportCount - a.reportCount);

  return {
    perPattern,
    perGame,
    totalReports: scannedReports,
    totalGames:   gamesTouched.size,
  };
}
