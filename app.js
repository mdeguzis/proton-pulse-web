const CDN    = 'https://mdeguzis.github.io/proton-pulse-data/data';
const SB_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
const SB_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
const STEAM_IMG = id => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;
const SITE_BASE = (() => {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts.length ? `/${parts[0]}` : '';
})();
const dataFilesHref = appId => `${SITE_BASE}/data/${appId}/`;

const RATING_COLORS = {
  platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0',
  bronze: '#b07040', borked: '#c85050', pending: '#3a4a5a'
};
const RATING_TEXT = {
  platinum: '#0a0c10', gold: '#0a0c10', silver: '#0a0c10',
  bronze: '#0a0c10', borked: '#fff', pending: '#c8d4e0'
};

let searchIndex     = null;   // [[appId, title], ...]
let searchFocusIdx  = -1;

// -- Routing ------------------------------------------

function getRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const m = h.match(/^app\/(\d+)/);
  const q = new URLSearchParams(location.search).get('q')?.trim() || '';
  if (m) return { page: 'app', appId: m[1], query: q };
  if (q) return { page: 'search', query: q };
  return { page: 'home', query: '' };
}

window.addEventListener('hashchange', () => route());
window.addEventListener('popstate', () => route());
route();

async function route() {
  const r = getRoute();
  const routeSearchInput = document.getElementById('search');
  if (routeSearchInput) {
    routeSearchInput.value = r.page === 'search' ? r.query : '';
  }
  if (r.page === 'app') await renderGamePage(r.appId);
  else if (r.page === 'search') await renderSearchPage(r.query);
  else await renderHomePage();
}

async function renderHomePage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading Proton Pulse configs...</div>';
  try {
    const r = await fetch(
      `${SB_URL}/user_proton_configs?select=voter_id,app_id,app_name,config,updated_at&order=updated_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const rows = r.ok
      ? latestPerApp(await r.json()).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      : [];
    if (!rows.length) {
      el.innerHTML = `
        <div class="state-box">
          No Proton Pulse configs yet.<br>
          Search for a game above, or <a href="https://github.com/mdeguzis/decky-proton-pulse" target="_blank" rel="noopener">install the Decky Plugin</a> to submit configs.
        </div>`;
      return;
    }
    el.innerHTML = `
      <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Configs</p>
      <div class="cards" style="border:1px solid var(--border)">
        ${rows.map(row => {
          const cfg = row.config || {};
          const name = row.app_name || cfg.appName || `App ${row.app_id}`;
          const proton = cfg.protonVersion || '';
          const profile = cfg.profileName || '';
          const d = Math.round((Date.now() / 1000 - new Date(row.updated_at).getTime() / 1000) / 86400);
          const age = d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
          const hwParts = [proton, profile].filter(Boolean);
          return `
            <a class="card" href="#/app/${row.app_id}" style="text-decoration:none">
              <img src="${STEAM_IMG(row.app_id)}" onerror="this.style.display='none'" alt=""
                   style="width:108px;height:40px;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">
              <div class="left">
                <div class="proton">${esc(name)}</div>
                <div class="hw">${hwParts.length ? hwParts.map(esc).join(' | ') : ''}</div>
                <div class="age">${age}</div>
              </div>
              <div class="right">
                <span class="source-badge">
                  <img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse
                </span>
              </div>
            </a>`;
        }).join('')}
      </div>`;
  } catch {
    el.innerHTML = '<div class="state-box">Search for a game above or navigate to <code>#/app/{appId}</code></div>';
  }
}

function latestPerApp(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = String(row.app_id || row.appId || '');
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing || row.updated_at > existing.updated_at) seen.set(key, row);
  }
  return [...seen.values()];
}

async function fetchMatchingPulseConfigs(query) {
  const q = query.trim();
  if (!q) return [];
  try {
    const url = new URL(`${SB_URL}/user_proton_configs`);
    url.searchParams.set('select', 'voter_id,app_id,app_name,config,updated_at');
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

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

// -- Data fetching ------------------------------------

async function fetchCdn(appId) {
  try {
    const r = await fetch(`${CDN}/${appId}/latest.json`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

/** Deduplicate rows by voter_id, keeping only the most recent per unique client. */
function latestPerClient(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.voter_id || row.config?.clientId || Math.random();
    const existing = seen.get(key);
    if (!existing || row.updated_at > existing.updated_at) seen.set(key, row);
  }
  return [...seen.values()];
}

async function fetchSupabase(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/user_proton_configs?app_id=eq.${appId}&select=voter_id,app_id,app_name,config,updated_at&order=updated_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    const rows = latestPerClient(await r.json());

    return rows.map(row => {
      const cfg = row.config || {};
      return {
        clientId:      row.voter_id || cfg.clientId || '',
        profileName:   cfg.profileName   || 'Unnamed Config',
        protonVersion: cfg.protonVersion || '',
        launchOptions: cfg.launchOptions || '',
        enabledVars:   cfg.enabledVars   || {},
        appName:       row.app_name || cfg.appName || `App ${row.app_id}`,
        timestamp:     Math.floor(new Date(row.updated_at).getTime() / 1000),
        source:        cfg.source || 'proton-pulse',
        cpu:           cfg.cpu   || null,
        gpu:           cfg.gpu   || null,
        gpuVendor:     cfg.gpuVendor || null,
        gpuDriver:     cfg.gpuDriver || null,
        ram:           cfg.ram   || null,
        os:            cfg.os    || null,
        kernel:        cfg.kernel || null,
      };
    });
  } catch { return []; }
}

async function fetchNativeReports(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/user_configs?app_id=eq.${appId}&select=client_id,app_id,title,cpu,gpu,gpu_driver,gpu_vendor,ram,os,kernel,proton_version,rating,duration,notes,vram_mb,cpu_cores,display_resolution,steam_deck_model,created_at&order=created_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    const rows = await r.json();
    // keep only the latest submission per client
    const seen = new Map();
    for (const row of rows) {
      const key = row.client_id || Math.random();
      const existing = seen.get(key);
      if (!existing || row.created_at > existing.created_at) seen.set(key, row);
    }
    return [...seen.values()].map(row => ({
      title:             row.title || `App ${row.app_id}`,
      cpu:               row.cpu || '',
      gpu:               row.gpu || '',
      gpuDriver:         row.gpu_driver || '',
      gpuVendor:         row.gpu_vendor || '',
      ram:               row.ram || '',
      os:                row.os || '',
      kernel:            row.kernel || '',
      protonVersion:     row.proton_version || '',
      rating:            row.rating || '',
      duration:          row.duration || '',
      notes:             row.notes || '',
      vramMb:            row.vram_mb ?? null,
      cpuCores:          row.cpu_cores ?? null,
      displayResolution: row.display_resolution ?? null,
      steamDeckModel:    row.steam_deck_model ?? null,
      timestamp:         Math.floor(new Date(row.created_at).getTime() / 1000),
      source:            'proton-pulse',
    }));
  } catch { return []; }
}

async function fetchVotes(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/report_vote_totals?app_id=eq.${appId}&select=report_key,upvotes,downvotes`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return {};
    const rows = await r.json();
    const totals = {};
    for (const v of rows) {
      totals[v.report_key] = { up: Number(v.upvotes || 0), down: Number(v.downvotes || 0) };
    }
    return totals;
  } catch { return {}; }
}

// -- Helpers ------------------------------------------

function reportKey(r) {
  return `${r.timestamp}:${(r.gpu||'').slice(0,20)}:${(r.protonVersion||'').slice(0,15)}`;
}


function tierFromReports(reports) {
  const order = ['platinum','gold','silver','bronze','borked'];
  const counts = {};
  for (const r of reports) counts[r.rating] = (counts[r.rating] || 0) + 1;
  for (const t of order) if (counts[t]) return t;
  return 'pending';
}

function daysAgo(ts) {
  const d = Math.round((Date.now() / 1000 - ts) / 86400);
  return d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}

function utcStamp(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function confColor(s) {
  if (s >= 8) return '#4caf80';
  if (s >= 6) return '#c8a050';
  if (s >= 4) return '#c87840';
  return '#c85050';
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : s; }

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function searchIndexMatches(query, limit) {
  const q = query.trim();
  const ql = q.toLowerCase();
  const isNum = /^\d+$/.test(q);
  return (searchIndex || []).filter(([id, title]) =>
    isNum ? String(id).startsWith(q) : (String(title).toLowerCase().includes(ql) || String(id).startsWith(q))
  ).slice(0, limit);
}

function estimateScore(r) {
  const base = { platinum: 60, gold: 48, silver: 36, bronze: 24, borked: 0 }[r.rating] || 30;
  const days = Math.round((Date.now() / 1000 - r.timestamp) / 86400);
  const recency = days < 90 ? 15 : days < 365 ? 5 : -5;
  return Math.max(0, base + recency);
}

function renderPulseSearchResult(row) {
  const age = daysAgo(Math.floor(new Date(row.updatedAt).getTime() / 1000));
  const isProtonDb = (row.source || '').toLowerCase() === 'protondb';
  const alsoInIndex = !isProtonDb && (searchIndex || []).some(([id]) => String(id) === String(row.appId));
  const sourceBadge = isProtonDb
    ? '<span class="source-badge protondb">ProtonDB</span>'
    : '<span class="source-badge pulse"><img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse</span>'
      + (alsoInIndex ? ' <span class="source-badge protondb">ProtonDB</span>' : '');
  return `
    <a class="search-result-card" href="#/app/${row.appId}">
      <img src="${STEAM_IMG(row.appId)}" onerror="this.style.display='none'" alt="">
      <div class="search-result-main">
        <div class="search-result-main-title">${esc(row.appName)}</div>
        <div class="search-result-main-meta">
          Latest config: ${esc(row.profileName)}${row.protonVersion ? ` · ${esc(row.protonVersion)}` : ''}<br>
          Updated ${age}
        </div>
      </div>
      <div class="search-result-side">
        ${sourceBadge}
      </div>
    </a>`;
}

function renderIndexSearchResult([appId, title]) {
  return `
    <a class="search-result-card" href="${dataFilesHref(appId)}">
      <img src="${STEAM_IMG(appId)}" onerror="this.style.display='none'" alt="">
      <div class="search-result-main">
        <div class="search-result-main-title">${esc(title)}</div>
        <div class="search-result-main-meta">
          Static ProtonDB mirror data indexed for app ${esc(appId)}.
        </div>
      </div>
      <div class="search-result-side">
        <span class="badge badge-reports">Index</span>
      </div>
    </a>`;
}

async function renderSearchPage(query) {
  const el = document.getElementById('content');
  const q = query.trim();
  el.innerHTML = '<div class="state-box">Searching Proton Pulse and index data...</div>';
  await loadSearchIndex();
  const pulseResults = await withTimeout(fetchMatchingPulseConfigs(q), 2500, []);
  const indexResults = searchIndexMatches(q, 24);
  const total = pulseResults.length + indexResults.length;

  el.innerHTML = `
    <div class="search-summary">
      Search results for <strong>${esc(q)}</strong> · ${total} grouped hit${total === 1 ? '' : 's'}${pulseResults.length === 0 && indexResults.length > 0 ? ' · Proton Pulse config search may still be catching up' : ''}
    </div>
    <div class="search-groups">
      <section class="search-group">
        <div class="search-group-head">
          <span class="search-group-title">User Configs</span>
          <span class="search-group-count">${pulseResults.length} app${pulseResults.length === 1 ? '' : 's'}</span>
        </div>
        ${pulseResults.length
          ? `<div class="search-result-list">${pulseResults.map(renderPulseSearchResult).join('')}</div>`
          : '<div class="search-group-empty">No Proton Pulse user configs matched this query.</div>'}
      </section>

      <section class="search-group">
        <div class="search-group-head">
          <span class="search-group-title">Index Data Hits</span>
          <span class="search-group-count">${indexResults.length} app${indexResults.length === 1 ? '' : 's'}</span>
        </div>
        ${indexResults.length
          ? `<div class="search-result-list">${indexResults.map(renderIndexSearchResult).join('')}</div>`
          : '<div class="search-group-empty">No static index entries matched this query.</div>'}
      </section>
    </div>`;
}

// -- Render: Proton Pulse Configs section ------------

const NA_SPAN = '<span style="color:#4a5f70;font-style:italic">Not available</span>';
function cfgNa(s) { return s || NA_SPAN; }

function downloadConfigJson(c) {
  const blob = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pulse-config-${c.profileName || 'unnamed'}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderConfigCard(c, idx) {
  const vars = Object.entries(c.enabledVars || {}).filter(([, v]) => v);
  const isProtonDb = (c.source || '').toLowerCase() === 'protondb';
  const sourceLabel = isProtonDb ? 'ProtonDB' : 'Proton Pulse';
  return `
    <div class="config-card">
      <div class="config-head">
        <div class="config-name">${esc(c.profileName)}</div>
        <span class="source-badge pulse">
          <img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse
        </span>
      </div>
      ${c.clientId ? `<div class="config-row"><span class="config-lbl">Client ID</span><span class="config-val">${esc(c.clientId)}</span></div>` : ''}
      <div class="config-row">
        <span class="config-lbl">Proton</span>
        <span class="config-val">${cfgNa(esc(c.protonVersion))}</span>
      </div>
      ${c.launchOptions ? `
      <div class="config-row">
        <span class="config-lbl">Launch Options</span>
        <span class="config-val">${esc(c.launchOptions)}</span>
      </div>` : ''}
      ${vars.length ? `
      <div class="config-row">
        <span class="config-lbl">Env Vars</span>
        <span class="config-vars">${vars.map(([k]) => `<span class="var-tag">${esc(k)}</span>`).join('')}</span>
      </div>` : ''}
      <div class="config-hw">
        <div class="config-hw-label">Hardware</div>
        <div class="config-row"><span class="config-lbl">GPU</span><span>${cfgNa(esc(c.gpu))}</span></div>
        <div class="config-row"><span class="config-lbl">CPU</span><span>${cfgNa(esc(c.cpu))}</span></div>
        <div class="config-row"><span class="config-lbl">RAM</span><span>${cfgNa(esc(c.ram))}</span></div>
        <div class="config-row"><span class="config-lbl">OS</span><span>${cfgNa(esc(c.os))}</span></div>
        <div class="config-row"><span class="config-lbl">Kernel</span><span>${cfgNa(esc(c.kernel))}</span></div>
      </div>
      <div class="config-meta">
        ${utcStamp(c.timestamp)} | Source: ${sourceLabel}
        <button class="cfg-dl-btn" data-cfg-idx="${idx}" title="Download as JSON">JSON</button>
      </div>
    </div>`;
}

function renderConfigsSection(configs) {
  if (!configs.length) return '';
  return `
    <div class="configs-section">
      <div class="configs-section-head">
        <span class="configs-section-title">Proton Pulse Configs</span>
        <span class="configs-section-count">${configs.length} saved</span>
      </div>
      <div class="configs-list">
        ${configs.map((c, i) => renderConfigCard(c, i)).join('')}
      </div>
    </div>`;
}

// -- Render: trend summary ----------------------------

function trendSummary(reps) {
  if (reps.length < 2) return '';
  const ratingVal = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };
  const now = Date.now() / 1000;
  const recent = reps.filter(r => now - r.timestamp < 180 * 86400);
  const older  = reps.filter(r => now - r.timestamp >= 180 * 86400);
  if (!recent.length || !older.length) return '';
  const avg = arr => arr.reduce((s, r) => s + (ratingVal[r.rating] || 3), 0) / arr.length;
  const diff = avg(recent) - avg(older);
  if (Math.abs(diff) < 0.3)
    return `<div class="trend">Compatibility is <strong>stable</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
  if (diff > 0)
    return `<div class="trend">Compatibility is <strong style="color:var(--green)">improving</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
  return `<div class="trend">Compatibility is <strong style="color:var(--red)">declining</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
}

// -- Render: report card ------------------------------

function renderCard(r, votes) {
  const v     = votes[reportKey(r)] || { up: 0, down: 0 };
  const score = Math.min(10, Math.max(0, (r.score || estimateScore(r)) / 10)).toFixed(1);
  const isPP  = r.source === 'proton-pulse';
  const rc    = RATING_COLORS[r.rating] || '#3a4a5a';
  const rt    = RATING_TEXT[r.rating]   || '#c8d4e0';
  const na = s => s || '<span style="color:#4a5f70;font-style:italic">Not available</span>';
  return `
    <div class="card">
      <div class="left">
        <div class="card-head">
          <div class="proton">${esc(r.protonVersion || 'Unknown')}</div>
          <span class="source-badge ${isPP ? 'pulse' : 'protondb'}">
            ${isPP
              ? '<img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse'
              : 'ProtonDB'}
          </span>
        </div>
        <div class="hw">${esc([r.gpu, r.os].filter(Boolean).join(' / ') || 'Hardware unavailable')}</div>
        <div class="age">${daysAgo(r.timestamp)}</div>
      </div>
      <div class="right">
        <span class="rating" style="background:${rc};color:${rt}">${r.rating || '?'}</span>
        <span class="score" style="color:${confColor(parseFloat(score))}">${score}/10</span>
        <span class="votes">+${v.up} -${v.down}</span>
      </div>
    </div>
    <div class="card-summary">
      <div class="row"><span class="label">GPU</span><span>${na(esc(r.gpu))}</span></div>
      <div class="row"><span class="label">CPU</span><span>${na(esc(r.cpu))}</span></div>
      <div class="row"><span class="label">OS</span><span>${na(esc(r.os))}</span></div>
      <div class="row"><span class="label">Proton</span><span>${na(esc(r.protonVersion))}</span></div>
      ${r.notes ? `<div class="notes-full">${esc(r.notes)}</div>` : ''}
      <button class="all-details-btn" onclick="this.nextElementSibling.classList.toggle('open');this.textContent=this.nextElementSibling.classList.contains('open')?'Hide Hardware Details':'All Hardware Details'">All Hardware Details</button>
      <div class="all-details-panel">
        <div class="row"><span class="label">RAM</span><span>${na(esc(r.ram))}</span></div>
        ${r.vramMb ? `<div class="row"><span class="label">VRAM</span><span>${r.vramMb >= 1024 ? (r.vramMb/1024).toFixed(1)+' GB' : r.vramMb+' MB'}</span></div>` : ''}
        <div class="row"><span class="label">GPU Driver</span><span>${na(esc(r.gpuDriver))}</span></div>
        <div class="row"><span class="label">Kernel</span><span>${na(esc(r.kernel))}</span></div>
        <div class="row"><span class="label">Duration</span><span>${na(esc(r.duration))}</span></div>
        ${r.cpuCores ? `<div class="row"><span class="label">CPU Cores</span><span>${r.cpuCores}</span></div>` : ''}
        ${r.displayResolution ? `<div class="row"><span class="label">Resolution</span><span>${esc(r.displayResolution)}</span></div>` : ''}
        ${r.steamDeckModel ? `<div class="row"><span class="label">Steam Deck</span><span>${esc(r.steamDeckModel.toUpperCase())}</span></div>` : ''}
        ${r.launchOptions ? `<div class="row"><span class="label">Launch Options</span><span>${esc(r.launchOptions)}</span></div>` : ''}
      </div>
    </div>`;
}

// -- Render: game page --------------------------------

async function renderGamePage(appId) {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading reports...</div>';

  const [cdn, configs, nativeReports, votes] = await Promise.all([
    fetchCdn(appId),
    fetchSupabase(appId),
    fetchNativeReports(appId),
    fetchVotes(appId)
  ]);

  const reports = [
    ...cdn.map(r => ({ ...r, source: 'protondb' })),
    ...nativeReports,
  ];

  if (!reports.length && !configs.length) {
    el.innerHTML = `<div class="state-box">No reports found for app ${appId}</div>`;
    return;
  }

  const title = reports[0]?.title || configs[0]?.appName || `App ${appId}`;
  const tier  = tierFromReports(reports);
  document.title = `${title} - Proton Pulse`;

  let sortMode = 'recent';
  let filterGpu    = '';
  let filterOs     = '';
  let filterRating = '';
  let filterSource = '';

  // Pulse config filters
  let filterCfgProton = '';
  let filterCfgSource = '';

  const gpuVendor = g => {
    if (!g) return '';
    const l = g.toLowerCase();
    if (/nvidia|geforce|rtx|gtx/.test(l)) return 'nvidia';
    if (/\bamd\b|radeon/.test(l)) return 'amd';
    if (/\bintel\b|iris|arc\b/.test(l)) return 'intel';
    return '';
  };
  const osFamily = o => {
    if (!o) return '';
    const l = o.toLowerCase();
    if (/steamos|holoisos/.test(l)) return 'steamos';
    if (/arch|cachyos|manjaro|garuda|endeavour/.test(l)) return 'arch';
    if (/fedora|bazzite|nobara/.test(l)) return 'fedora';
    if (/ubuntu|pop|mint|elementary/.test(l)) return 'ubuntu';
    if (/debian/.test(l)) return 'debian';
    if (/nixos/.test(l)) return 'nixos';
    return '';
  };

  const filtered = () => {
    let arr = [...reports];
    if (filterGpu)    arr = arr.filter(r => gpuVendor(r.gpu) === filterGpu);
    if (filterOs)     arr = arr.filter(r => (r.os || '').trim() === filterOs);
    if (filterRating) arr = arr.filter(r => r.rating === filterRating);
    if (filterSource) arr = arr.filter(r => (r.source || 'protondb') === filterSource);
    return arr;
  };

  const filteredConfigs = () => {
    let arr = [...configs];
    if (filterCfgProton) arr = arr.filter(c => c.protonVersion === filterCfgProton);
    if (filterCfgSource) arr = arr.filter(c => (c.source || 'proton-pulse') === filterCfgSource);
    return arr;
  };

  const sorted = () => {
    const arr = filtered();
    if (sortMode === 'recent') arr.sort((a, b) => b.timestamp - a.timestamp);
    else if (sortMode === 'votes') arr.sort((a, b) => {
      const va = votes[reportKey(a)] || { up:0, down:0 };
      const vb = votes[reportKey(b)] || { up:0, down:0 };
      return (vb.up - vb.down) - (va.up - va.down);
    });
    return arr;
  };

  function render() {
    const reps = sorted();
    const rc   = RATING_COLORS[tier] || '#3a4a5a';
    const rt   = RATING_TEXT[tier]   || '#c8d4e0';

    el.innerHTML = `
      <div class="game-header">
        <img src="${STEAM_IMG(appId)}" onerror="this.style.display='none'" alt="">
        <div class="game-header-info">
          <div class="game-title">${esc(title)}</div>
          <div class="game-meta">
            App ${appId}
            &nbsp;/&nbsp; <strong>${cdn.length}</strong> ProtonDB report${cdn.length !== 1 ? 's' : ''}
            ${nativeReports.length ? `&nbsp;/&nbsp; <strong>${nativeReports.length}</strong> Pulse report${nativeReports.length !== 1 ? 's' : ''}` : ''}
            &nbsp;/&nbsp; <strong>${configs.length}</strong> Pulse config${configs.length !== 1 ? 's' : ''}
          </div>
        </div>
        <span class="tier-badge" style="background:${rc};color:${rt}">${tier}</span>
        <button class="info-btn" id="rating-info-btn" title="What does this rating mean?"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="11" fill="#3b82f6"/><text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="serif">i</text></svg></button>
        <div class="info-tooltip" id="rating-info-tip">
          <div class="info-tooltip-inner">
          <h3 style="margin:0 0 10px">ProtonDB Ratings</h3>
          <span style="color:#b4c7dc">Platinum</span> - Runs perfectly out of the box<br>
          <span style="color:#c8a050">Gold</span> - Runs after tweaks<br>
          <span style="color:#8fa0b0">Silver</span> - Runs with minor issues<br>
          <span style="color:#b07040">Bronze</span> - Runs but with significant issues<br>
          <span style="color:#c85050">Borked</span> - Does not run or is unplayable<br><br>
          The tier shown is the most common rating across all reports for this game.<br><br>

          <h3 style="margin:0 0 10px">Confidence Scoring</h3>
          Each report gets a relevance score (0-100) based on how closely it matches <em>your</em> hardware when viewed in the Decky plugin. On this website, an estimate is shown without local system info.<br><br>

          <h4 style="margin:0 0 6px">1. Base Rating (0-60 pts)</h4>
          <code>Platinum=60, Gold=48, Silver=36, Bronze=24, Borked=0</code><br>
          Borked reports older than 365 days are treated as Bronze (games get fixed over time).<br><br>

          <h4 style="margin:0 0 6px">2. Recency Bonus</h4>
          <code>&lt;90 days: +15 | 90-365 days: +5 | &gt;1 year: -5</code><br><br>

          <h4 style="margin:0 0 6px">3. Custom Proton Bonus (+10)</h4>
          Reports using GE-Proton, CachyOS, TKG, or ProtonPlus builds get +10.<br><br>

          <h4 style="margin:0 0 6px">4. Proton Version Match</h4>
          <code>Same major version: +8 | Adjacent: +4</code><br><br>

          <h4 style="margin:0 0 6px">5. GPU Multiplier</h4>
          <code>Same vendor: 1.0x | Different: 0.5x | Unknown: 0.75x</code><br>
          Same vendor + same driver major: 1.3x | Close driver: 1.1x<br><br>

          <h4 style="margin:0 0 6px">6. OS Multiplier</h4>
          <code>Exact match: 1.08x | Same family: 1.04x</code><br>
          OS families: SteamOS/Arch, Bazzite/Nobara/Fedora, Ubuntu/Pop/Mint/Debian, NixOS<br><br>

          <h4 style="margin:0 0 6px">7. Kernel Multiplier</h4>
          <code>Exact: 1.12x | Same minor: 1.08x | Same major: 1.04x</code><br>
          Valve/SteamOS kernels compare build numbers instead of upstream versions.<br><br>

          <h4 style="margin:0 0 6px">8. Notes Sentiment (-10 to +10)</h4>
          Keywords like "crash", "broken", "freeze" reduce score (-3 each).<br>
          Keywords like "perfect", "flawless", "no issues" boost score (+2 each).<br>
          Negation-aware: "no crash" does NOT count as negative.<br><br>

          <h4 style="margin:0 0 6px">Final Formula</h4>
          <code>score = (rating + recency + customProton + protonMatch) * gpuMult * osMult * kernelMult + notesSentiment</code><br><br>

          <h4 style="margin:0 0 6px">Score-to-Tier Mapping</h4>
          <code>&gt;=80: Platinum | &gt;=60: Gold | &gt;=40: Silver | &gt;=20: Bronze | &lt;20: Borked</code><br><br>

          <a href="https://github.com/mdeguzis/decky-proton-pulse/blob/main/src/lib/scoring.ts" target="_blank" rel="noopener" style="color:var(--accent)">View full scoring source code on GitHub</a>
          </div>
        </div>
      </div>

      <div class="hub-links">
        <a class="hub-link" href="https://store.steampowered.com/app/${appId}" target="_blank" rel="noopener">Steam ></a>
        <a class="hub-link" href="https://steamdb.info/app/${appId}/" target="_blank" rel="noopener">SteamDB ></a>
        <a class="hub-link" href="https://www.protondb.com/app/${appId}" target="_blank" rel="noopener">ProtonDB ></a>
        <a class="hub-link" href="https://www.pcgamingwiki.com/w/index.php?search=${encodeURIComponent(title)}" target="_blank" rel="noopener">PCGamingWiki ></a>
        <a class="hub-link" href="${dataFilesHref(appId)}">Data Files ></a>
        <button class="hub-link" id="scoring-info-btn">How Scoring Works ></button>
      </div>

      ${trendSummary(reports)}
      ${configs.length ? (() => {
        const cfgVersions = [...new Set(configs.map(c => c.protonVersion).filter(Boolean))].sort();
        const cfgSources  = [...new Set(configs.map(c => c.source || 'proton-pulse'))].sort();
        const visibleCfgs = filteredConfigs();
        return `
          <div class="configs-section-head" style="border:1px solid var(--border);border-bottom:none;padding:8px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span class="configs-section-title">Proton Pulse Configs</span>
            <span class="configs-section-count">${configs.length} saved</span>
            <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              ${cfgVersions.length > 1 ? `
              <select id="fCfgProton" style="background:var(--bg);border:1px solid var(--border2);color:var(--text);padding:3px 7px;font-size:0.72rem;font-family:inherit">
                <option value="">Any Proton</option>
                ${cfgVersions.map(v => `<option value="${esc(v)}" ${filterCfgProton===v?'selected':''}>${esc(v)}</option>`).join('')}
              </select>` : ''}
              ${cfgSources.length > 1 ? `
              <select id="fCfgSource" style="background:var(--bg);border:1px solid var(--border2);color:var(--text);padding:3px 7px;font-size:0.72rem;font-family:inherit">
                <option value="">Any Source</option>
                ${cfgSources.map(s => `<option value="${esc(s)}" ${filterCfgSource===s?'selected':''}>${esc(s)}</option>`).join('')}
              </select>` : ''}
              ${(filterCfgProton || filterCfgSource) ? `<span style="font-size:0.72rem;color:var(--muted)">${visibleCfgs.length} of ${configs.length}</span>` : ''}
            </div>
          </div>
          <div class="configs-list" style="border:1px solid var(--border)">
            ${visibleCfgs.length
              ? visibleCfgs.map((c, i) => renderConfigCard(c, i)).join('')
              : '<div class="state-box" style="border:none;padding:20px">No configs match filters</div>'}
          </div>`;
      })() : `
        <div class="configs-empty">
          No Proton Pulse configs for this game yet --
          <a href="https://github.com/mdeguzis/decky-proton-pulse" target="_blank" rel="noopener">add one via the Decky Plugin</a>.
        </div>`}

      <div class="reports-section-head">
        <span class="reports-section-title">Community Reports</span>
        <div class="sort-bar">
          <button class="${sortMode==='recent'?'active':''}" data-sort="recent">Recent</button>
          <button class="${sortMode==='votes'?'active':''}" data-sort="votes">Top Voted</button>
        </div>
      </div>

      <div class="filter-bar">
        ${(() => {
          const GPU_LABEL = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };
          const SRC_LABEL = { 'protondb': 'ProtonDB', 'proton-pulse': 'Pulse' };
          const RATING_LABEL = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked' };
          const RATING_ORDER = ['platinum','gold','silver','bronze','borked'];

          const availGpus    = [...new Set(reports.map(r => gpuVendor(r.gpu)).filter(Boolean))];
          const availOs      = [...new Set(reports.map(r => (r.os || '').trim()).filter(Boolean))].sort();
          const availRatings = RATING_ORDER.filter(rt => reports.some(r => r.rating === rt));
          const availSrcs    = [...new Set(reports.map(r => r.source || 'protondb').filter(Boolean))];

          const gpuSel    = availGpus.length > 0 ? `
            <label>GPU</label>
            <select id="fGpu">
              <option value="">Any</option>
              ${availGpus.map(v => `<option value="${v}" ${filterGpu===v?'selected':''}>${GPU_LABEL[v]||v}</option>`).join('')}
            </select>` : '';
          const osSel     = availOs.length > 0 ? `
            <label>OS</label>
            <select id="fOs">
              <option value="">Any</option>
              ${availOs.map(v => `<option value="${esc(v)}" ${filterOs===v?'selected':''}>${esc(v)}</option>`).join('')}
            </select>` : '';
          const ratingSel = availRatings.length > 0 ? `
            <label>Rating</label>
            <select id="fRating">
              <option value="">Any</option>
              ${availRatings.map(v => `<option value="${v}" ${filterRating===v?'selected':''}>${RATING_LABEL[v]||v}</option>`).join('')}
            </select>` : '';
          const srcSel    = `
            <label>Source</label>
            <select id="fSource">
              <option value="">Any</option>
              ${availSrcs.map(v => `<option value="${v}" ${filterSource===v?'selected':''}>${SRC_LABEL[v]||v}</option>`).join('')}
            </select>`;

          const anyActive = filterGpu || filterOs || filterRating || filterSource;
          return gpuSel + osSel + ratingSel + srcSel +
            (anyActive ? `<span class="filter-count">${reps.length} of ${reports.length}</span>` : '');
        })()}
      </div>

      <div class="cards">
        ${reps.length
          ? reps.map(r => renderCard(r, votes)).join('')
          : '<div class="state-box" style="border:none">No reports match filters</div>'}
      </div>
    `;

    el.querySelectorAll('.sort-bar button').forEach(b =>
      b.onclick = () => { sortMode = b.dataset.sort; render(); }
    );
    el.querySelector('#rating-info-btn')?.addEventListener('click', () => {
      el.querySelector('#rating-info-tip')?.classList.toggle('open');
    });
    el.querySelector('#scoring-info-btn')?.addEventListener('click', () => {
      el.querySelector('#rating-info-tip')?.classList.toggle('open');
    });
    el.querySelector('#fGpu')?.addEventListener('change', e => { filterGpu    = e.target.value; render(); });
    el.querySelector('#fOs')?.addEventListener('change',  e => { filterOs     = e.target.value; render(); });
    el.querySelector('#fRating')?.addEventListener('change', e => { filterRating = e.target.value; render(); });
    el.querySelector('#fSource')?.addEventListener('change', e => { filterSource = e.target.value; render(); });
    el.querySelector('#fCfgProton')?.addEventListener('change', e => { filterCfgProton = e.target.value; render(); });
    el.querySelector('#fCfgSource')?.addEventListener('change', e => { filterCfgSource = e.target.value; render(); });
    el.querySelectorAll('.cfg-dl-btn').forEach(b => {
      b.addEventListener('click', e => { e.stopPropagation(); downloadConfigJson(filteredConfigs()[Number(b.dataset.cfgIdx)]); });
    });
  }

  render();
}

// -- Search --------------------------------------------

const searchInput   = document.getElementById('search');
const searchResults = document.getElementById('search-results');

async function loadSearchIndex() {
  if (searchIndex !== null) return;
  try {
    const r = await fetch('search-index.json');
    searchIndex = r.ok ? await r.json() : [];
  } catch { searchIndex = []; }
}

function closeSearch() {
  searchResults.classList.remove('open');
  searchResults.innerHTML = '';
  searchFocusIdx = -1;
}

function positionSearchResults() {
  const rect = searchInput.getBoundingClientRect();
  const desiredWidth = Math.max(rect.width, 620);
  const maxWidth = Math.min(desiredWidth, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - maxWidth - 12));
  searchResults.style.top = `${Math.round(rect.bottom + 4)}px`;
  searchResults.style.left = `${Math.round(left)}px`;
  searchResults.style.width = `${Math.round(maxWidth)}px`;
}

function renderSearchResults(q) {
  const items = searchResults.querySelectorAll('a.search-item');
  searchFocusIdx = Math.max(-1, Math.min(searchFocusIdx, items.length - 1));
  items.forEach((a, i) => a.classList.toggle('focused', i === searchFocusIdx));
}

async function onSearchInput() {
  const q = searchInput.value.trim();
  if (!q) { closeSearch(); return; }
  await loadSearchIndex();
  positionSearchResults();
  const MAX = 8;

  // Filter: numeric queries match only on app ID prefix; text matches title or ID
  const matches = searchIndexMatches(q, MAX);

  if (!matches.length) {
    searchResults.innerHTML = `<div class="search-no-results">No quick matches — press Enter to open grouped search results.</div>`;
    searchResults.classList.add('open');
    searchFocusIdx = -1;
    return;
  }

  const rows = matches.map(([id, title]) => {
    const img = STEAM_IMG(id);
    return `<a class="search-item" href="#/app/${id}" data-id="${id}">
      <img src="${img}" onerror="this.style.display='none'" alt="" loading="lazy">
      <div class="search-result-info">
        <div class="search-result-title">${esc(title)}</div>
        <div class="search-result-badges">
          <span class="badge badge-reports">ProtonDB</span>
        </div>
      </div>
    </a>`;
  }).join('');

  const footer = `<a class="search-footer" href="app.html?q=${encodeURIComponent(q)}">Open grouped search results →</a>`;
  searchResults.innerHTML = rows + footer;
  searchResults.classList.add('open');
  searchFocusIdx = -1;

  // Close when a result is clicked
  searchResults.querySelectorAll('a.search-item').forEach(a => {
    a.addEventListener('click', () => { closeSearch(); searchInput.value = ''; });
  });
}

searchInput.addEventListener('input', onSearchInput);

searchInput.addEventListener('keydown', e => {
  const items = [...searchResults.querySelectorAll('a.search-item')];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchFocusIdx = Math.min(searchFocusIdx + 1, items.length - 1);
    renderSearchResults(searchInput.value.trim());
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchFocusIdx = Math.max(searchFocusIdx - 1, -1);
    renderSearchResults(searchInput.value.trim());
    return;
  }
  if (e.key === 'Escape') { closeSearch(); return; }
  if (e.key === 'Enter') {
    const focused = items[searchFocusIdx];
    if (focused) { focused.click(); return; }
    const q = searchInput.value.trim();
    if (!q) return;
    closeSearch();
    searchInput.value = '';
    if (/^\d+$/.test(q)) {
      location.hash = '#/app/' + q;
    } else {
      window.location.href = 'app.html?q=' + encodeURIComponent(q);
    }
  }
});

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) closeSearch();
});

window.addEventListener('resize', () => {
  if (searchResults.classList.contains('open')) positionSearchResults();
});

(function(){
  var toggle  = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }

  toggle.addEventListener('click', function() {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });

  overlay.addEventListener('click', closeSidebar);
  sidebar.querySelectorAll('a').forEach(function(a) {
    a.addEventListener('click', closeSidebar);
  });
})();
