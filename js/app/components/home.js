// home (components) for the app page. Relocated from app.js.

import { fetchRecentPulseReports } from '../api/reports.js?v=7c5d0e92';
import { loadSearchIndex, searchIndex } from './search.js?v=5c8b29f2';
import { SB_KEY, SB_URL, isNonSteamAppId } from '../config.js?v=f75c43ba';
import { daysAgo, latestPerApp } from '../utils.js?v=d4fea298';
import { renderGameCard } from '../lib/card.js?v=fb41e0a7';

const LIMIT = 25;

function _popularSub(g) {
  const total = (g.protondbCount || 0) + (g.pulseCount || 0);
  const parts = [];
  if (total > 0) parts.push(`${total.toLocaleString()} report${total === 1 ? '' : 's'}`);
  if (g.peak) parts.push(`${g.peak.toLocaleString()} peak players`);
  return parts.join(' \u00b7 ') || 'Popular on Steam';
}

export async function renderHomePage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading recent reports...</div>';
  try {
    const [pulseReports, mostPlayedResp] = await Promise.all([
      fetchRecentPulseReports(),
      fetch('most_played.json').catch(() => null),
    ]);

    pulseReports.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    // Pad up to LIMIT with popular Steam games so the page is never sparse
    const seenIds = new Set(pulseReports.map(r => String(r.app_id)));
    const popularCards = [];
    if (pulseReports.length < LIMIT && mostPlayedResp && mostPlayedResp.ok) {
      const mostPlayed = await mostPlayedResp.json().catch(() => []);
      for (const g of (Array.isArray(mostPlayed) ? mostPlayed : [])) {
        if (pulseReports.length + popularCards.length >= LIMIT) break;
        if (seenIds.has(String(g.appId))) continue;
        popularCards.push(renderGameCard({
          href: `#/app/${g.appId}`,
          appId: g.appId,
          imgUrl: g.headerImage || undefined,
          title: g.title,
          sub: _popularSub(g),
          tier: String(g.rating || '').toLowerCase() || undefined,
        }));
      }
    }

    const pulseHtml = pulseReports.map(row => renderActivityCard('report', row)).join('');
    el.innerHTML = `
      <p class="section-label" style="margin-bottom:10px">Recent Reports</p>
      <div class="cards">${pulseHtml}${popularCards.join('')}</div>`;
  } catch {
    el.innerHTML = '<div class="state-box">Search for a game above or navigate to <code>#/app/{appId}</code></div>';
  }
}

export async function renderHomeFallback() {
  const [pulseReports] = await Promise.all([
    fetchRecentPulseReports(),
    loadSearchIndex(),
  ]);
  const popularIds = ['730', '570', '440', '292030', '1245620', '1091500', '1174180', '413150'];
  const titleById = new Map((searchIndex || []).map(([id, title]) => [String(id), title]));
  const popularCards = popularIds
    .map((appId) => ({ appId, title: titleById.get(appId) || `App ${appId}` }))
    .filter((row) => row.title)
    .map((row) => renderGameCard({ href: `#/app/${row.appId}`, appId: row.appId, title: row.title, sub: 'ProtonDB data available' }))
    .join('');

  const pulseCards = renderPulseReportCards(pulseReports);

  return `
    ${pulseCards ? `
      <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Reports</p>
      <div class="cards" style="margin-bottom:16px">
        ${pulseCards}
      </div>` : ''}
    <p class="section-label" style="margin-bottom:10px">Popular ProtonDB Reports</p>
    <div class="cards">
      ${popularCards}
    </div>`;
}

// Unified activity card used by the merged "Recent Activity" feed on the
// home page. `kind` drives the small REPORT/CONFIG pill on the right plus
// which fields show in the body. Single renderer means both kinds share
// the same hover/click target shape, so the layout is consistent down
// the list instead of two visually separate sections
export function renderActivityCard(kind, row) {
  const isReport = kind === 'report';
  const appId = row.app_id;
  let title, hwLine, age, isNonSteam = false;
  if (isReport) {
    title = row.title || `App ${appId}`;
    hwLine = [row.rating, row.proton_version].filter(Boolean).join(' | ');
    age = daysAgo(Math.floor(new Date(row.created_at).getTime() / 1000));
    isNonSteam = isNonSteamAppId(appId);
  } else {
    const cfg = row.config || {};
    title = row.app_name || cfg.appName || `App ${appId}`;
    hwLine = [cfg.protonVersion || '', cfg.profileName || ''].filter(Boolean).join(' | ');
    const d = Math.round((Date.now() / 1000 - new Date(row.updated_at).getTime() / 1000) / 86400);
    age = d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
    isNonSteam = cfg.isNonSteam === true || isNonSteamAppId(appId);
  }
  const rating = isReport ? String(row.rating || '').toLowerCase() : '';
  return renderGameCard({
    href: `#/app/${appId}`,
    appId,
    title,
    sub: `${hwLine}${hwLine && age ? ' \u00b7 ' : ''}${age}`,
    tier: rating || undefined,
  });
}

export function renderPulseReportCards(rows) {
  return rows.map((row) => {
    const rating = String(row.rating || '').toLowerCase();
    const sub = [row.proton_version, daysAgo(Math.floor(new Date(row.created_at).getTime() / 1000))].filter(Boolean).join(' \u00b7 ');
    return renderGameCard({
      href: `#/app/${row.app_id}`,
      appId: row.app_id,
      title: row.title || `App ${row.app_id}`,
      sub,
      tier: rating || undefined,
    });
  }).join('');
}
