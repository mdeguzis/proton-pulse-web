// Pure sort helpers for the home page (screenshots from ProtonDB /explore
// comparison). Split out of home.js so tests can import them without pulling
// window-touching config. Zero side effects, no I/O.

// Tier score ladder (higher = better). platinum > gold > silver > bronze > borked.
// Unknown / pending tiers score 0 so they sink to the bottom of "best".
export const TIER_SCORE = {
  platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1,
};

/**
 * Sort recent-reports rows by one of seven modes:
 *   recent         - default; caller passes reports already newest-first
 *   best           - "ProtonDB Rating" descending (platinum before gold)
 *   worst          - "Most Borked" ascending (borked before bronze)
 *   count          - report count total (protondbCount + pulseCount) descending
 *   release_desc   - newest release year first; unknown years last
 *   release_asc    - oldest release year first; unknown years last
 *   alpha          - A-Z, case-insensitive natural sort
 *
 * @param {Array<object>} reports  each row has { appId, title, tier, lastReportDate, protondbCount, pulseCount }
 * @param {string} sort            one of the sort keys above
 * @param {(appId: string) => (number|null)} releaseYearFn  optional; only used by the release sorts
 * @returns {Array<object>}        new array; input is not mutated
 */
export function sortReports(reports, sort, releaseYearFn = () => null) {
  const copy = [...reports];
  if (sort === 'best') {
    copy.sort((a, b) =>
      (TIER_SCORE[b.tier] || 0) - (TIER_SCORE[a.tier] || 0) ||
      (b.lastReportDate || '').localeCompare(a.lastReportDate || ''));
  } else if (sort === 'worst') {
    copy.sort((a, b) =>
      (TIER_SCORE[a.tier] || 99) - (TIER_SCORE[b.tier] || 99) ||
      (b.lastReportDate || '').localeCompare(a.lastReportDate || ''));
  } else if (sort === 'count') {
    copy.sort((a, b) =>
      ((b.protondbCount || 0) + (b.pulseCount || 0)) -
      ((a.protondbCount || 0) + (a.pulseCount || 0)));
  } else if (sort === 'release_desc') {
    copy.sort((a, b) => {
      const ay = releaseYearFn(a.appId) ?? -Infinity;
      const by = releaseYearFn(b.appId) ?? -Infinity;
      return (by - ay) || (b.lastReportDate || '').localeCompare(a.lastReportDate || '');
    });
  } else if (sort === 'release_asc') {
    copy.sort((a, b) => {
      const ay = releaseYearFn(a.appId) ?? Infinity;
      const by = releaseYearFn(b.appId) ?? Infinity;
      return (ay - by) || (b.lastReportDate || '').localeCompare(a.lastReportDate || '');
    });
  } else if (sort === 'alpha') {
    copy.sort((a, b) => String(a.title || '').localeCompare(
      String(b.title || ''), undefined, { sensitivity: 'base', numeric: true }));
  }
  return copy;
}

/**
 * Build an appId -> releaseYear map from a search-index array.
 * Column 6 is the release year (see scripts/pipeline/game_images.py padding
 * comment). Rows with a missing / non-numeric year are skipped so callers
 * can distinguish "unknown" (null) from 0.
 * @param {Array} searchIndex
 * @returns {Map<string, number>}
 */
export function buildReleaseYearMap(searchIndex) {
  const map = new Map();
  if (!Array.isArray(searchIndex)) return map;
  for (const row of searchIndex) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const y = Number(row[6]);
    if (Number.isFinite(y) && y > 0) map.set(String(row[0]), y);
  }
  return map;
}
