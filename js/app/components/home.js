// home (components) for the app page. Relocated from app.js.

import { fetchRecentPulseReports } from '../api/reports.js?v=3333b0d8';
import { loadSearchIndex, searchIndex } from './search.js?v=069664f8';
import { SB_KEY, SB_URL, isNonSteamAppId } from '../config.js?v=f75c43ba';
import { daysAgo, latestPerApp } from '../utils.js?v=d4fea298';
import { renderGameCard } from '../lib/card.js?v=e84d9849';

export async function renderHomePage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading Proton Pulse reports...</div>';
  try {
    // Kick off the search index load in parallel so we can mark cards that
    // also have ProtonDB data without blocking on the configs fetch
    const [r, pulseReports] = await Promise.all([
      fetch(
        `${SB_URL}/user_proton_configs?is_published=eq.true&select=id,voter_id,app_id,app_name,config,updated_at,is_published&order=updated_at.desc`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      ),
      fetchRecentPulseReports(),
      loadSearchIndex(),
    ]);
    const configRows = r.ok
      ? latestPerApp(await r.json()).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      : [];
    if (!configRows.length && !pulseReports.length) {
      el.innerHTML = await renderHomeFallback();
      return;
    }
    // Build a quick lookup of app IDs that also appear in the ProtonDB search
    // index so we can tag those cards with both badges
    const protonDbAppIds = new Set((searchIndex || []).map(([id]) => String(id)));

    // Merge reports + configs into one Recent Activity feed sorted by
    // timestamp. They were two separate sections before but the visual
    // distinction was unclear, so we use a small REPORT/CONFIG kind badge
    // on the right side of each card instead. Activity items carry a
    // unix-second `ts` so they can be sorted across both sources
    const activity = [];
    for (const row of pulseReports) {
      const ts = Math.floor(new Date(row.created_at).getTime() / 1000);
      activity.push({ kind: 'report', ts, row });
    }
    for (const row of configRows) {
      const ts = Math.floor(new Date(row.updated_at).getTime() / 1000);
      activity.push({ kind: 'config', ts, row });
    }
    activity.sort((a, b) => b.ts - a.ts);

    el.innerHTML = activity.length ? `
      <p class="section-label" style="margin-bottom:10px">Recent Reports</p>
      <div class="cards">
        ${activity.map(({ kind, row }) => renderActivityCard(kind, row, protonDbAppIds)).join('')}
      </div>` : '';
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
export function renderActivityCard(kind, row, protonDbAppIds) {
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
  const hasProtonDb = !isNonSteam && protonDbAppIds && protonDbAppIds.has(String(appId));
  // Per design discussion: there's no real distinction between a "config"
  // and a "report" -- a report is just a config that has form responses
  // attached. Both render identically here; the Publish flow on My
  // Reports is what enforces filling out responses before a row goes
  // public-visible. No REPORT/CONFIG badge needed on the home feed
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
