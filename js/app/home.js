// home module for the app page. Relocated from app.js.

import { SB_KEY, SB_URL, STEAM_IMG, isNonSteamAppId } from './config.js';
import { loadSearchIndex, searchIndex } from './search.js';
import { daysAgo, esc, latestPerApp } from './utils.js';

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
      <div class="cards" style="border:1px solid var(--border)">
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
    .map((row) => `
      <a class="card" href="#/app/${row.appId}" style="text-decoration:none">
        <img src="${STEAM_IMG(row.appId)}" onerror="this.style.display='none'" alt=""
             style="width:108px;height:40px;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">
        <div class="left">
          <div class="proton">${esc(row.title)}</div>
          <div class="hw">Open ProtonDB and Proton Pulse reports</div>
        </div>
        <div class="right"><span class="source-badge protondb">ProtonDB</span></div>
      </a>`)
    .join('');

  const pulseCards = renderPulseReportCards(pulseReports);

  return `
    ${pulseCards ? `
      <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Reports</p>
      <div class="cards" style="border:1px solid var(--border);margin-bottom:16px">
        ${pulseCards}
      </div>` : ''}
    <p class="section-label" style="margin-bottom:10px">Popular ProtonDB Reports</p>
    <div class="cards" style="border:1px solid var(--border)">
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
  return `
    <a class="card" href="#/app/${appId}" style="text-decoration:none">
      <img src="${STEAM_IMG(appId)}" onerror="this.style.display='none'" alt=""
           style="width:108px;height:40px;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">
      <div class="left">
        <div class="proton">${esc(title)}</div>
        <div class="hw">${esc(hwLine)}</div>
        <div class="age">${age}</div>
      </div>
      <div class="right" style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
        <span class="source-badge pulse">
          <img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse
        </span>
        ${hasProtonDb ? '<span class="source-badge protondb">ProtonDB</span>' : ''}
        ${isNonSteam
          ? '<span class="source-badge non-steam-game">Non-Steam</span>'
          : '<span class="source-badge steam-game">Steam</span>'}
      </div>
    </a>`;
}

export function renderPulseReportCards(rows) {
  return rows.map((row) => `
    <a class="card" href="#/app/${row.app_id}" style="text-decoration:none">
      <img src="${STEAM_IMG(row.app_id)}" onerror="this.style.display='none'" alt=""
           style="width:108px;height:40px;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">
      <div class="left">
        <div class="proton">${esc(row.title || `App ${row.app_id}`)}</div>
        <div class="hw">${esc([row.rating, row.proton_version].filter(Boolean).join(' | '))}</div>
        <div class="age">${daysAgo(Math.floor(new Date(row.created_at).getTime() / 1000))}</div>
      </div>
      <div class="right"><span class="source-badge pulse"><img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse</span></div>
    </a>`)
    .join('');
}

export async function fetchRecentPulseReports() {
  try {
    const r = await fetch(
      `${SB_URL}/user_configs?select=id,app_id,title,rating,proton_version,created_at,source&order=created_at.desc&limit=8`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    return latestPerApp(await r.json()).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    return [];
  }
}


export async function fetchMatchingPulseConfigs(query) {
  const q = query.trim();
  if (!q) return [];
  try {
    const url = new URL(`${SB_URL}/user_proton_configs`);
    url.searchParams.set('select', 'id,voter_id,app_id,app_name,config,updated_at,is_published');
    url.searchParams.set('is_published', 'eq.true');
    url.searchParams.set('order', 'updated_at.desc');
    url.searchParams.set('limit', '60');
    if (/^\d+$/.test(q)) {
      url.searchParams.set('or', `(app_id.eq.${q},app_name.ilike.*${q}*)`);
    } else {
      url.searchParams.set('app_name', `ilike.*${q}*`);
    }
    const r = await fetch(url.toString(), {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) return [];
    return latestPerApp(await r.json()).map((row) => {
      const cfg = row.config || {};
      return {
        appId: row.app_id,
        appName: row.app_name || cfg.appName || `App ${row.app_id}`,
        profileName: cfg.profileName || 'Unnamed Config',
        protonVersion: cfg.protonVersion || '',
        updatedAt: row.updated_at,
        source: cfg.source || 'proton-pulse',
      };
    });
  } catch {
    return [];
  }
}

// Return distinct app_ids from user_configs (Pulse compatibility reports) that
// match the query. Used to tag search results with the Pulse badge even when
// the game has no saved launch profile yet
export async function fetchMatchingPulseReportAppIds(query) {
  const q = query.trim();
  if (!q) return new Set();
  try {
    const url = new URL(`${SB_URL}/user_configs`);
    url.searchParams.set('select', 'app_id');
    url.searchParams.set('limit', '100');
    if (/^\d+$/.test(q)) {
      url.searchParams.set('or', `(app_id.eq.${q},title.ilike.*${q}*)`);
    } else {
      url.searchParams.set('title', `ilike.*${q}*`);
    }
    const r = await fetch(url.toString(), {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) return new Set();
    const rows = await r.json();
    return new Set(rows.map((row) => String(row.app_id)));
  } catch {
    return new Set();
  }
}
