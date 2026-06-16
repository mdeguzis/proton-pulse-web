// home (components) for the app page. Relocated from app.js.

import { fetchRecentPulseReports } from '../api/reports.js?v=ab9bb0d8';
import { loadSearchIndex, searchIndex } from './search.js?v=e6b28bb2';
import { SB_KEY, SB_URL, isNonSteamAppId } from '../config.js?v=9970759a';
import { daysAgo, latestPerApp } from '../utils.js?v=f5dda5b6';
import { renderGameCard } from '../lib/card.js?v=ae6042a4';

const PAGE_SIZE = 10;

function _popularSub(g) {
  const total = (g.protondbCount || 0) + (g.pulseCount || 0);
  const countPart = total > 0 ? `${total.toLocaleString()} report${total === 1 ? '' : 's'}` : '';
  const datePart = g.lastReportDate ? `latest: ${g.lastReportDate}` : '';
  return [countPart, datePart].filter(Boolean).join(' \u00b7 ');
}

function _loadMoreBtn(sectionId) {
  return `<button class="load-more-btn" data-section="${sectionId}">Load more</button>`;
}

function _appendCards(sectionId, queue) {
  const cardsEl = document.getElementById(`cards-${sectionId}`);
  const btnEl = document.getElementById(`load-more-${sectionId}`);
  if (!cardsEl || !queue.length) { if (btnEl) btnEl.remove(); return; }
  const batch = queue.splice(0, PAGE_SIZE);
  const html = sectionId === 'recent'
    ? batch.map(_recentCardHtml).join('')
    : batch.map(g => renderGameCard({
        href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
        title: g.title, sub: _popularSub(g),
        tier: String(g.rating || '').toLowerCase() || undefined, sourceLabel: 'Steam',
      })).join('');
  cardsEl.insertAdjacentHTML('beforeend', html);
  if (!queue.length && btnEl) btnEl.remove();
}

function _recentCardHtml(r) {
  return renderGameCard({
    href: `#/app/${r.appId}`,
    appId: r.appId,
    title: r.title,
    sub: _popularSub(r),
    tier: String(r.tier || '').toLowerCase() || undefined,
    sourceLabel: 'Steam',
  });
}

export async function renderHomePage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading recent reports...</div>';
  try {
    const [recentResp, mostPlayedResp] = await Promise.all([
      fetch('recent-reports.json').catch(() => null),
      fetch('most_played.json').catch(() => null),
    ]);

    let recentReports = [];
    if (recentResp && recentResp.ok) {
      recentReports = await recentResp.json().catch(() => []);
    }

    const recentQueue = recentReports.slice(PAGE_SIZE);
    const recentInitial = recentReports.slice(0, PAGE_SIZE);
    const recentHtml = recentInitial.map(_recentCardHtml).join('');

    const seenIds = new Set(recentReports.map(r => String(r.appId)));
    let mostPlayed = [];
    if (mostPlayedResp && mostPlayedResp.ok) {
      mostPlayed = (await mostPlayedResp.json().catch(() => [])).filter(g => !seenIds.has(String(g.appId)));
    }
    const popularQueue = mostPlayed.slice(PAGE_SIZE);
    const popularInitial = mostPlayed.slice(0, PAGE_SIZE);
    const popularHtml = popularInitial.map(g => renderGameCard({
      href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
      title: g.title, sub: _popularSub(g),
      tier: String(g.rating || '').toLowerCase() || undefined, sourceLabel: 'Steam',
    })).join('');

    el.innerHTML = `
      <p class="section-label" style="margin-bottom:10px">Recent Reports</p>
      <div class="cards" id="cards-recent">${recentHtml || '<div class="state-box">No reports yet.</div>'}</div>
      ${recentQueue.length ? `<div id="load-more-recent">${_loadMoreBtn('recent')}</div>` : ''}
      <p class="section-label" style="margin-top:24px;margin-bottom:10px">Popular on Steam</p>
      <div class="cards" id="cards-popular">${popularHtml}</div>
      ${popularQueue.length ? `<div id="load-more-popular">${_loadMoreBtn('popular')}</div>` : ''}`;

    document.getElementById('load-more-recent')?.querySelector('button')
      ?.addEventListener('click', () => _appendCards('recent', recentQueue, null));
    document.getElementById('load-more-popular')?.querySelector('button')
      ?.addEventListener('click', () => _appendCards('popular', popularQueue, null));
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
export function renderActivityCard(kind, row, counts = {}) {
  const isReport = kind === 'report';
  const appId = row.app_id;
  let title, sub, isNonSteam = false;
  if (isReport) {
    title = row.title || `App ${appId}`;
    isNonSteam = isNonSteamAppId(appId);
    const total = (counts.protondbCount || 0) + (counts.pulseCount || 0);
    const countPart = total > 0 ? `${total.toLocaleString()} report${total === 1 ? '' : 's'}` : '';
    const date = row.created_at ? String(row.created_at).slice(0, 10) : '';
    const datePart = date ? `latest: ${date}` : '';
    sub = [countPart, datePart].filter(Boolean).join(' \u00b7 ');
  } else {
    const cfg = row.config || {};
    title = row.app_name || cfg.appName || `App ${appId}`;
    const hwLine = [cfg.protonVersion || '', cfg.profileName || ''].filter(Boolean).join(' | ');
    const d = Math.round((Date.now() / 1000 - new Date(row.updated_at).getTime() / 1000) / 86400);
    const age = d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
    sub = `${hwLine}${hwLine && age ? ' \u00b7 ' : ''}${age}`;
    isNonSteam = cfg.isNonSteam === true || isNonSteamAppId(appId);
  }
  const rating = isReport ? String(row.rating || '').toLowerCase() : '';
  return renderGameCard({
    href: `#/app/${appId}`,
    appId,
    title,
    sub,
    tier: rating || undefined,
    sourceLabel: isNonSteam ? 'Non-Steam' : 'Steam',
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
