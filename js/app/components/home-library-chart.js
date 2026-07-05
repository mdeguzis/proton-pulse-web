// Signed-in-only home page section: horizontal bar chart showing the rating
// breakdown across the user's cached Steam library (#199). Cross-references
// user_steam_library.appids with search-index tiers.
import { getMyLibraryAppIds } from '../lib/user-library.js?v=1d8e72df';
import { loadSearchIndex, searchIndex } from './search.js?v=598aaad1';
import { RATING_COLORS, RATING_TEXT } from '../config.js?v=f9591262';
import { esc } from '../utils.js?v=c7e1268c';

const TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
const TIER_LABEL = {
  platinum: 'Platinum',
  gold:     'Gold',
  silver:   'Silver',
  bronze:   'Bronze',
  borked:   'Borked',
};

/**
 * Compute a tier -> count map for the intersection of appIds and search-index
 * entries. Exported so tests can pin down the aggregation logic without
 * touching the DOM.
 */
export function computeLibraryTierCounts(appIdSet, indexRows) {
  const counts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0, pending: 0, unrated: 0 };
  if (!appIdSet || appIdSet.size === 0 || !Array.isArray(indexRows)) return counts;
  for (const row of indexRows) {
    const appId = Number(row?.[0]);
    if (!Number.isFinite(appId) || !appIdSet.has(appId)) continue;
    const tier = String(row?.[2] || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, tier)) {
      counts[tier] += 1;
    } else if (tier === 'native') {
      counts.platinum += 1;
    } else {
      counts.unrated += 1;
    }
  }
  return counts;
}

export async function renderHomeLibraryChart(mountEl) {
  if (!mountEl) return;
  const session = await window.SupaAuth?.getSession?.();
  if (!session?.user) {
    mountEl.innerHTML = '';
    return;
  }
  await loadSearchIndex().catch(() => null);
  const appIds = await getMyLibraryAppIds();
  if (!appIds || appIds.size === 0) {
    mountEl.innerHTML = `
      <div class="home-library-chart home-library-chart--empty">
        <div class="hlc-title">Your library</div>
        <div class="hlc-empty-body">
          No Steam library synced yet.
          <a href="profile.html">Sync your library</a> to see a compatibility breakdown here.
        </div>
      </div>`;
    return;
  }
  const counts = computeLibraryTierCounts(appIds, searchIndex);
  const rated = TIER_ORDER.reduce((sum, t) => sum + (counts[t] || 0), 0);
  const totalOwned = appIds.size;
  const maxBar = Math.max(1, ...TIER_ORDER.map((t) => counts[t] || 0));

  const barsHtml = TIER_ORDER.map((tier) => {
    const n = counts[tier] || 0;
    const pct = Math.round((n / maxBar) * 100);
    const bg = RATING_COLORS[tier] || '#3a4a5a';
    const fg = RATING_TEXT[tier] || '#c8d4e0';
    return `
      <div class="hlc-row">
        <div class="hlc-label" style="color:${fg};background:${bg}">${esc(TIER_LABEL[tier])}</div>
        <div class="hlc-track"><div class="hlc-fill" style="width:${pct}%;background:${bg}"></div></div>
        <div class="hlc-count">${n.toLocaleString()}</div>
      </div>`;
  }).join('');

  mountEl.innerHTML = `
    <div class="home-library-chart">
      <div class="hlc-title">Your library at a glance</div>
      <div class="hlc-subtitle">
        ${rated.toLocaleString()} of ${totalOwned.toLocaleString()} owned games have compatibility data.
      </div>
      <div class="hlc-bars">${barsHtml}</div>
    </div>`;
}
