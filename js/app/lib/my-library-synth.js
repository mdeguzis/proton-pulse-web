/**
 * Synthesize the "My Library" dataset from three sources so every owned
 * game shows up, not just the ones that happen to be in recent-reports:
 *
 * 1. recent-reports rows the user already owns (keep timestamps + tier)
 * 2. search-index rows for owned appIds not already covered (adds tier +
 *    counts for games with ProtonDB history but no recent report)
 * 3. bare stubs for owned appIds missing from both above (Steam games
 *    that never got a ProtonDB report -- box art still resolves via the
 *    Steam CDN, tier renders as pending)
 *
 * Kept pure (no DOM, no window) so the count math is unit-testable and
 * the "total games in library" number matches what the user sees in Steam.
 */
export function synthesizeMyLibrary(libraryAppIds, recentReports, searchIndex) {
  if (!libraryAppIds || libraryAppIds.size === 0) {
    return { rows: [], fromRecentReports: 0, fromSearchIndex: 0, bareStubs: 0 };
  }
  const owned = new Set([...libraryAppIds].map(String));
  const recentOwned = (recentReports || []).filter((r) => owned.has(String(r.appId)));
  const covered = new Set(recentOwned.map((r) => String(r.appId)));

  const fromSearchIndex = [];
  for (const row of (searchIndex || [])) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const id = String(row[0]);
    if (!owned.has(id)) continue;
    if (covered.has(id)) continue;
    fromSearchIndex.push({
      appId:          id,
      title:          row[1] || `App ${id}`,
      tier:           row[2] || 'pending',
      protondbCount:  Number(row[3] || 0),
      pulseCount:     Number(row[4] || 0),
      appType:        row[5] || 'steam',
      lastReportDate: '',
    });
    covered.add(id);
  }

  const bareStubs = [];
  for (const id of owned) {
    if (covered.has(id)) continue;
    bareStubs.push({
      appId:          id,
      title:          `App ${id}`,
      tier:           'pending',
      protondbCount:  0,
      pulseCount:     0,
      appType:        'steam',
      lastReportDate: '',
    });
  }

  return {
    rows: [...recentOwned, ...fromSearchIndex, ...bareStubs],
    fromRecentReports: recentOwned.length,
    fromSearchIndex: fromSearchIndex.length,
    bareStubs: bareStubs.length,
  };
}
