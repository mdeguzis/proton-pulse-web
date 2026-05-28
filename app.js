const SB_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
const SB_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
const STEAM_IMG = id => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;
// On github.io project page the URL is /proton-pulse-data/..., on the custom
// domain (www.proton-pulse.com) it serves from root. Keep SITE_BASE empty on
// the custom domain so links don't get a bogus prefix.
const SITE_BASE = (() => {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[0] === 'proton-pulse-data' ? '/proton-pulse-data' : '';
})();
// On localhost the local /data directory is gitignored + empty (real data
// comes from the pipeline running in CI). Fetch from the production CDN
// instead so any searched game works during local dev preview.
const IS_LOCAL_DEV = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
const CDN = IS_LOCAL_DEV
  ? 'https://www.proton-pulse.com/data'
  : `${window.location.origin}${SITE_BASE}/data`;
// Data Files link points at the same place we fetch data from - so localhost
// users browse the prod data directory rather than 404'ing on a missing
// local one
const dataFilesHref = appId => IS_LOCAL_DEV
  ? `https://www.proton-pulse.com/data/${appId}/`
  : `${SITE_BASE}/data/${appId}/`;
// Steam app IDs are sequentially assigned and currently top out ~3 million.
// Non-Steam shortcut IDs are CRC32-derived and can be any 32-bit value.
// Any ID above 10 million is treated as a non-Steam shortcut.
const isNonSteamAppId = id => Number(id) > 10_000_000;

const RATING_COLORS = {
  platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0',
  bronze: '#b07040', borked: '#c85050', pending: '#3a4a5a'
};
const RATING_TEXT = {
  platinum: '#0a0c10', gold: '#0a0c10', silver: '#0a0c10',
  bronze: '#0a0c10', borked: '#fff', pending: '#c8d4e0'
};



function normalizeOs(raw) {
  if (!raw) return '';
  let s = raw.trim();
  if (/^\d+$/.test(s)) return '';
  // strip parenthetical suffixes
  s = s.replace(/\s*\(.*\)$/, '');
  // strip trailing edition/variant words
  s = s.replace(/\s+(LTS|Holo|Core|Silverblue|Kinoite|Workstation|Server|Desktop)$/i, '');
  // collapse long build versions like "44.20260407.n.0" to just "44"
  s = s.replace(/\s(\d{1,3})\.\d{5,}[\w.]*/g, ' $1');
  // "24.04.3" -> "24.04"
  s = s.replace(/(\d+\.\d+)\.\d+/g, '$1');
  return s.trim();
}

// - Routing ------------------------------------------


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
    el.innerHTML = `
      ${pulseReports.length ? `
        <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Reports</p>
        <div class="cards" style="border:1px solid var(--border);margin-bottom:16px">
          ${renderPulseReportCards(pulseReports)}
        </div>` : ''}
      ${configRows.length ? `
        <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Configs</p>
        <div class="cards" style="border:1px solid var(--border)">
          ${configRows.map(row => {
          const cfg = row.config || {};
          const name = row.app_name || cfg.appName || `App ${row.app_id}`;
          const proton = cfg.protonVersion || '';
          const profile = cfg.profileName || '';
          const d = Math.round((Date.now() / 1000 - new Date(row.updated_at).getTime() / 1000) / 86400);
          const age = d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
          const hwParts = [proton, profile].filter(Boolean);
          const isNonSteam = cfg.isNonSteam === true || isNonSteamAppId(row.app_id);
          const hasProtonDb = !isNonSteam && protonDbAppIds.has(String(row.app_id));
          return `
            <a class="card" href="#/app/${row.app_id}" style="text-decoration:none">
              <img src="${STEAM_IMG(row.app_id)}" onerror="this.style.display='none'" alt=""
                   style="width:108px;height:40px;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">
              <div class="left">
                <div class="proton">${esc(name)}</div>
                <div class="hw">${hwParts.length ? hwParts.map(esc).join(' | ') : ''}</div>
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
          }).join('')}
        </div>` : ''}`;
  } catch {
    el.innerHTML = '<div class="state-box">Search for a game above or navigate to <code>#/app/{appId}</code></div>';
  }
}

async function renderHomeFallback() {
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

function renderPulseReportCards(rows) {
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

async function fetchRecentPulseReports() {
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

function latestPerApp(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = String(row.app_id || row.appId || '');
    if (!key) continue;
    const existing = seen.get(key);
    const rowTime = row.updated_at || row.created_at || '';
    const existingTime = existing?.updated_at || existing?.created_at || '';
    if (!existing || rowTime > existingTime) seen.set(key, row);
  }
  return [...seen.values()];
}

async function fetchMatchingPulseConfigs(query) {
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
async function fetchMatchingPulseReportAppIds(query) {
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

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

// - Data fetching ------------------------------------

async function fetchCdn(appId) {
  try {
    const r = await fetch(`${CDN}/${appId}/latest.json`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// Session cache for user-triggered live ProtonDB checks. Keyed by appId so
// repeat visits within the session skip the network hit without auto-fetching.
const _protonDbLiveCache = new Map();

// User-triggered live check: fetches ProtonDB public API for a single game.
// NOT called automatically -- must be triggered by the user clicking the
// "Check ProtonDB Live" button to avoid hammering their API on every page load.
async function fetchProtonDbLive(appId) {
  const key = String(appId);
  if (_protonDbLiveCache.has(key)) return _protonDbLiveCache.get(key);
  try {
    const r = await fetch(
      `https://www.protondb.com/api/v1/reports/summaries/${appId}.json`,
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) { _protonDbLiveCache.set(key, []); return []; }
    const data = await r.json();
    if (!data || !data.tier) { _protonDbLiveCache.set(key, []); return []; }
    console.log(`[proton-pulse] live check for ${appId} | tier=${data.tier} total=${data.total} source=protondb-api`);
    const result = [{
      appId,
      tier:         data.tier,
      total:        data.total || 0,
      trendingTier: data.trendingTier || data.tier,
      score:        data.score || 0,
      source:       'protondb-live',
      _liveOnly:    true,
    }];
    _protonDbLiveCache.set(key, result);
    return result;
  } catch (e) {
    console.debug(`[proton-pulse] ProtonDB live check failed | appId=${appId} error=${e.message}`);
    _protonDbLiveCache.set(key, []);
    return [];
  }
}

// Compute aggregate per-game stats from all available reports and configs.
// allReports: combined cdn + nativeReports (each has .rating, .protonVersion, .timestamp)
// configs: pulse configs (each may have .launchOptions, .protonVersion)
// Returns an object with confidence, trend, versionStats, launchFlags, ratingCounts.
function computeGameStats(allReports, configs) {
  const now = Date.now() / 1000;
  const RATING_VAL = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };
  const RATING_SCORE = { platinum: 1.0, gold: 0.8, silver: 0.6, bronze: 0.4, borked: 0.0 };
  const TIERS = ['platinum', 'gold', 'silver', 'bronze', 'borked'];

  // --- Rating distribution ---
  const ratingCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0 };
  for (const r of allReports) {
    if (ratingCounts[r.rating] != null) ratingCounts[r.rating]++;
  }

  // --- Confidence: sample size + tier consistency + freshness ---
  const n = allReports.length;
  const sampleFactor = n > 0 ? Math.min(1.0, Math.log2(Math.max(1, n)) / Math.log2(50)) : 0;

  // tier consistency: std deviation of numeric ratings, normalized 0-1 (1=all same tier)
  let consistencyFactor = 0;
  if (n > 0) {
    const vals = allReports.map(r => RATING_VAL[r.rating] || 3);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const stdDev = Math.sqrt(variance);
    consistencyFactor = Math.max(0, 1 - stdDev / 2);
  }

  // freshness: weighted recency of reports
  let freshnessSum = 0, freshnessTotal = 0;
  for (const r of allReports) {
    const days = (now - (r.timestamp || 0)) / 86400;
    const w = days < 90 ? 1.0 : days < 365 ? 0.6 : 0.2;
    freshnessSum += w;
    freshnessTotal++;
  }
  const freshnessFactor = freshnessTotal > 0 ? freshnessSum / freshnessTotal : 0;

  // composite: 45% sample size, 35% tier consistency, 20% freshness; scale to 0-100
  const rawConf = n > 0 ? (sampleFactor * 0.45 + consistencyFactor * 0.35 + freshnessFactor * 0.20) : 0;
  const confidencePct = Math.min(95, Math.round(rawConf * 100));
  const confFactors = [
    { label: 'Sample size', value: Math.round(sampleFactor * 100), detail: `${n} report${n !== 1 ? 's' : ''} (log curve, 45% weight)` },
    { label: 'Tier consistency', value: Math.round(consistencyFactor * 100), detail: 'How tightly clustered ratings are (35% weight)' },
    { label: 'Data freshness', value: Math.round(freshnessFactor * 100), detail: 'Recency-weighted freshness (20% weight)' },
  ];

  // --- Trend: compare recent 90d avg vs prior 91-270d avg ---
  const recentReps = allReports.filter(r => r.timestamp && now - r.timestamp < 90 * 86400);
  const priorReps  = allReports.filter(r => r.timestamp && now - r.timestamp >= 90 * 86400 && now - r.timestamp < 270 * 86400);
  let trendDir = 'stable', trendDiff = 0;
  if (recentReps.length >= 2 && priorReps.length >= 2) {
    const avg = arr => arr.reduce((s, r) => s + (RATING_VAL[r.rating] || 3), 0) / arr.length;
    trendDiff = avg(recentReps) - avg(priorReps);
    if (trendDiff > 0.3) trendDir = 'improving';
    else if (trendDiff < -0.3) trendDir = 'declining';
  } else if (recentReps.length < 2 && priorReps.length < 2) {
    trendDir = 'insufficient';
  }

  // --- Per-Proton-version success % (positive = platinum/gold/silver) ---
  const versionMap = {};
  for (const r of allReports) {
    const ver = r.protonVersion || r.proton_version || 'Unknown';
    if (!versionMap[ver]) versionMap[ver] = { total: 0, positive: 0 };
    versionMap[ver].total++;
    if (['platinum', 'gold', 'silver'].includes(r.rating)) versionMap[ver].positive++;
  }
  const versionStats = Object.entries(versionMap)
    .map(([ver, s]) => ({ ver, total: s.total, pct: Math.round((s.positive / s.total) * 100) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  // --- Launch option flag frequency (from all configs that have launchOptions) ---
  const flagMap = {};
  const allSources = [...configs, ...allReports];
  for (const item of allSources) {
    const lo = item.launchOptions || item.launch_options || '';
    if (!lo) continue;
    // tokenize on spaces; keep flags starting with % or - and env vars (KEY=val), skip bare values
    const tokens = lo.split(/\s+/).filter(t => t.startsWith('%') || t.startsWith('-') || /^[A-Z_]+=/.test(t));
    for (const tok of tokens) {
      flagMap[tok] = (flagMap[tok] || 0) + 1;
    }
  }
  const totalSources = allSources.filter(item => (item.launchOptions || item.launch_options)).length;
  const launchFlags = Object.entries(flagMap)
    .map(([flag, cnt]) => ({ flag, cnt, pct: totalSources > 0 ? Math.round((cnt / totalSources) * 100) : 0 }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 10);

  return { confidencePct, confFactors, trendDir, trendDiff, recentCount: recentReps.length, priorCount: priorReps.length, versionStats, launchFlags, ratingCounts, totalReports: n };
}

function renderStatsPanel(stats, appId) {
  const { confidencePct, confFactors, trendDir, trendDiff, recentCount, priorCount, versionStats, launchFlags, ratingCounts, totalReports } = stats;
  const TIER_LABELS = { platinum: 'Plat', gold: 'Gold', silver: 'Silv', bronze: 'Bron', borked: 'Bork' };
  const TREND_LABEL = { improving: '<strong style="color:var(--green)">Improving</strong>', declining: '<strong style="color:var(--red)">Declining</strong>', stable: '<strong>Stable</strong>', insufficient: '<span style="color:var(--muted)">Not enough data</span>' };
  const confBarColor = confidencePct >= 75 ? 'var(--green)' : confidencePct >= 45 ? '#e0a030' : 'var(--red)';

  const factorRows = confFactors.map(f => `
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
      <span style="width:120px;color:var(--muted)">${f.label}</span>
      <div style="flex:1;background:var(--bg);border-radius:2px;height:6px;overflow:hidden">
        <div style="width:${f.value}%;height:100%;background:${f.value >= 70 ? 'var(--green)' : f.value >= 40 ? '#e0a030' : 'var(--red)'}"></div>
      </div>
      <span style="width:36px;text-align:right;font-weight:700">${f.value}%</span>
      <span style="color:var(--muted);font-size:0.7rem;flex:2">${f.detail}</span>
    </div>`).join('');

  const distCells = Object.entries(ratingCounts).map(([tier, n]) => `
    <div style="text-align:center;flex:1">
      <div style="background:${RATING_COLORS[tier]};color:${RATING_TEXT[tier]};font-weight:700;font-size:0.8rem;padding:3px 6px;border-radius:3px">${TIER_LABELS[tier]}</div>
      <div style="font-size:0.9rem;font-weight:700;margin-top:3px">${n}</div>
      <div style="font-size:0.7rem;color:var(--muted)">${totalReports > 0 ? Math.round(n / totalReports * 100) : 0}%</div>
    </div>`).join('');

  const verRows = versionStats.length
    ? versionStats.map(v => `
      <div style="display:flex;align-items:center;gap:8px;margin:3px 0">
        <span style="min-width:140px;font-size:0.75rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.ver)}">${esc(v.ver)}</span>
        <div style="flex:1;background:var(--bg);border-radius:2px;height:6px">
          <div style="width:${v.pct}%;height:100%;background:${v.pct >= 70 ? 'var(--green)' : v.pct >= 40 ? '#e0a030' : 'var(--red)'}"></div>
        </div>
        <span style="width:36px;text-align:right;font-weight:700">${v.pct}%</span>
        <span style="width:30px;text-align:right;color:var(--muted)">${v.total}r</span>
      </div>`).join('')
    : '<div style="color:var(--muted);font-size:0.78rem">No version data available</div>';

  const flagRows = launchFlags.length
    ? launchFlags.map(f => `
      <div style="display:flex;align-items:center;gap:8px;margin:3px 0">
        <code style="min-width:160px;font-size:0.72rem">${esc(f.flag)}</code>
        <div style="flex:1;background:var(--bg);border-radius:2px;height:6px">
          <div style="width:${Math.min(100, f.pct)}%;height:100%;background:var(--accent)"></div>
        </div>
        <span style="width:36px;text-align:right;font-weight:700">${f.pct}%</span>
        <span style="width:24px;text-align:right;color:var(--muted)">${f.cnt}x</span>
      </div>`).join('')
    : '<div style="color:var(--muted);font-size:0.78rem">No launch option data</div>';

  return `
    <div style="display:grid;gap:16px">
      <div>
        <h3 style="margin:0 0 8px">Confidence Score</h3>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
          <div style="font-size:2rem;font-weight:800;color:${confBarColor}">${confidencePct}%</div>
          <div style="flex:1">
            <div style="background:var(--bg);border-radius:4px;height:10px;overflow:hidden">
              <div style="width:${confidencePct}%;height:100%;background:${confBarColor};transition:width 0.3s"></div>
            </div>
            <div style="font-size:0.72rem;color:var(--muted);margin-top:4px">Based on ${totalReports} total report${totalReports !== 1 ? 's' : ''} &mdash; <a href="confidence.html?app=${appId}" style="color:var(--accent)">full breakdown</a></div>
          </div>
        </div>
        ${factorRows}
      </div>
      <div>
        <h3 style="margin:0 0 8px">Compatibility Trend</h3>
        <div>${TREND_LABEL[trendDir] || TREND_LABEL.stable}${trendDir !== 'insufficient' ? ` <span style="color:var(--muted);font-size:0.78rem">(${recentCount} reports in last 90d vs ${priorCount} in prior 90-270d window)</span>` : ''}</div>
      </div>
      <div>
        <h3 style="margin:0 0 8px">Rating Distribution</h3>
        <div style="display:flex;gap:6px">${distCells}</div>
      </div>
      <div>
        <h3 style="margin:0 0 6px">Per-Proton-Version Success Rate</h3>
        <div style="font-size:0.72rem;color:var(--muted);margin-bottom:6px">% of reports rated silver or better</div>
        ${verRows}
      </div>
      <div>
        <h3 style="margin:0 0 6px">Common Launch Option Flags</h3>
        <div style="font-size:0.72rem;color:var(--muted);margin-bottom:6px">Frequency across all configs and reports with launch options</div>
        ${flagRows}
      </div>
    </div>`;
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
      `${SB_URL}/user_proton_configs?app_id=eq.${appId}&is_published=eq.true&select=id,voter_id,app_id,app_name,config,updated_at,is_published&order=updated_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    const rows = latestPerClient(await r.json());

    return rows.map(row => {
      const cfg = row.config || {};
      return {
        appId:         row.app_id,
        configId:      row.id ?? null,
        clientId:      row.voter_id || cfg.clientId || '',
        profileName:   cfg.profileName || '',
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
        isNonSteam:    cfg.isNonSteam === true,
        pluginVersion: cfg.pluginVersion || null,
        isEdited:      cfg.isEdited === true,
      };
    });
  } catch { return []; }
}

async function fetchNativeReports(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/user_configs?app_id=eq.${appId}&select=id,client_id,app_id,title,cpu,gpu,gpu_driver,gpu_vendor,ram,os,kernel,proton_version,rating,duration,duration_minutes,notes,vram_mb,form_responses,config_key,game_owned,created_at,source&order=created_at.desc`,
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
      reportId:          row.id ?? null,
      appId:             row.app_id,
      clientId:          row.client_id || '',
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
      durationMinutes:   row.duration_minutes ?? null,
      notes:             row.notes || '',
      vramMb:            row.vram_mb ?? null,
      formResponses:     row.form_responses ?? null,
      configKey:         row.config_key || null,
      gameOwned:         row.game_owned ?? false,
      timestamp:         Math.floor(new Date(row.created_at).getTime() / 1000),
      source:            row.source || 'proton-pulse',
    }));
  } catch { return []; }
}

async function fetchConfigPlaytimeTotals(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/config_playtime_totals?app_id=eq.${appId}&select=config_key,total_minutes,session_count,unique_players`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    return await r.json();
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

async function fetchUserVotes(appId) {
  try {
    const voterId = getWebClientId();
    if (!voterId) return {};
    const r = await fetch(
      `${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${appId}&select=report_key,vote`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return {};
    const rows = await r.json();
    const result = {};
    for (const row of rows) result[row.report_key] = row.vote;
    return result;
  } catch { return {}; }
}

async function castVote(appId, rKey, vote, upBtn, dnBtn) {
  const voterId = getWebClientId();
  const wasUp = upBtn.classList.contains('active');
  const wasDn = dnBtn.classList.contains('active');
  const upCount = upBtn.querySelector('.vote-count');
  const dnCount = dnBtn.querySelector('.vote-count');
  const up = parseInt(upCount.textContent) || 0;
  const dn = parseInt(dnCount.textContent) || 0;

  const isUndo = (vote === 1 && wasUp) || (vote === -1 && wasDn);

  upBtn.classList.remove('active');
  dnBtn.classList.remove('active');

  if (isUndo) {
    if (vote === 1) upCount.textContent = Math.max(0, up - 1);
    else dnCount.textContent = Math.max(0, dn - 1);
    try {
      await fetch(`${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${String(appId)}&report_key=eq.${encodeURIComponent(rKey)}`, {
        method: 'DELETE',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'return=minimal' },
      });
    } catch { /* silently fail */ }
    return;
  }

  if (vote === 1) {
    upBtn.classList.add('active');
    upCount.textContent = up + 1;
    if (wasDn) dnCount.textContent = Math.max(0, dn - 1);
  } else {
    dnBtn.classList.add('active');
    dnCount.textContent = dn + 1;
    if (wasUp) upCount.textContent = Math.max(0, up - 1);
  }

  try {
    const existing = wasUp ? 1 : wasDn ? -1 : null;
    if (existing === null) {
      await fetch(`${SB_URL}/report_votes?on_conflict=voter_id,app_id,report_key`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ voter_id: voterId, app_id: String(appId), report_key: rKey, vote }),
      });
    } else {
      await fetch(`${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${String(appId)}&report_key=eq.${encodeURIComponent(rKey)}`, {
        method: 'PATCH',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ vote }),
      });
    }
  } catch { /* silently fail */ }
}

// - Helpers ------------------------------------------

function fmtDuration(d) {
  switch (d) {
    case 'underOneHour':   return '< 1 hour';
    case 'oneToFourHours': return '1-4 hours';
    case 'fourToTenHours': return '4-10 hours';
    case 'overTenHours':   return '10+ hours';
    default:               return d || null;
  }
}

function fmtMinutes(m) {
  if (!m || m < 1) return '< 1 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 10 ? `${h.toFixed(1)} hr` : `${Math.round(h)} hr`;
}

function reportKey(r) {
  return `${r.timestamp}:${(r.gpu||'').slice(0,20)}:${(r.protonVersion||'').slice(0,15)}`;
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
  // Confidence always lives in the Steam-cyan/blue family so it can never
  // blend with a rating badge color (gold / silver / bronze / borked-red).
  // Brightness drops as confidence drops - the percentage number still
  // does the heavy lifting; the color just signals "this is confidence, not
  // a tier badge" at a glance.
  if (s >= 8) return '#66c0f4';   // Steam accent cyan - high confidence
  if (s >= 6) return '#4a90b8';   // mid cyan - moderate
  if (s >= 4) return '#3a6680';   // muted dark cyan - low
  return '#4a5a6a';                // slate-grey - very low
}
// Text color paired with confColor - dark text on bright cyan reads fine, but
// the darker cyan / slate shades need light text for accessibility
function confTextColor(s) {
  return s >= 7 ? '#0a1a24' : '#e8f4ff';
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : s; }

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }






// - Render: Proton Pulse Configs section ------------

const NA_SPAN = '<span style="color:#4a5f70;font-style:italic">Not available</span>';
function cfgNa(s) { return s || NA_SPAN; }

function downloadJson(obj, prefix) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${prefix}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  a.click();
  URL.revokeObjectURL(a.href);
}

function configKey(c) {
  return `cfg:${c.configId != null ? c.configId : (c.clientId || '')}`;
}

const FORM_RESPONSE_LABELS = {
  canInstall:        'Were you able to install the game?',
  canStart:          'Were you able to start the game?',
  canPlay:           'Were you able to begin playing?',
  performanceFaults: 'Unexpected slowdowns or stutters?',
  graphicalFaults:   'Graphical glitches or artifacts?',
  windowingFaults:   'Windowing or display issues?',
  audioFaults:       'Audio issues?',
  inputFaults:       'Input or controller issues?',
  stabilityFaults:   'Crashes or instability?',
  saveGameFaults:    'Save game issues?',
  significantBugs:   'Other significant bugs?',
  onlineMultiplayer: 'Online multiplayer tested?',
  localMultiplayer:  'Local multiplayer tested?',
  verdict:           'Overall: would you recommend this to others?',
  verdictOob:        'Works out of the box without tweaks?',
  requiresFramegen:  'Required framegen (FSR/LSFG/DLSS-G) for smooth play?',
};

function buildFormRows(c) {
  const r = c.formResponses;
  if (!r || typeof r !== 'object') return null;
  const rows = Object.entries(FORM_RESPONSE_LABELS)
    .map(([key, label]) => {
      const val = r[key];
      if (val == null || val === '') return '';
      const v = String(val).toLowerCase();
      const badge = v === 'yes'
        ? '<span class="fr-badge fr-yes">Yes</span>'
        : v === 'no'
          ? '<span class="fr-badge fr-no">No</span>'
          : `<span class="fr-badge">${esc(String(val))}</span>`;
      return `<div class="fr-row"><span class="fr-lbl">${esc(label)}</span>${badge}</div>`;
    })
    .filter(Boolean);
  if (!rows.length) return null;
  const tinker = Array.isArray(r.tinkeringMethods) && r.tinkeringMethods.length
    ? `<div class="fr-row"><span class="fr-lbl">Tinkering methods</span><span class="fr-badge">${r.tinkeringMethods.map(m => esc(m)).join(', ')}</span></div>`
    : '';
  return rows.join('') + tinker;
}

function renderConfigCard(c, idx, votes = {}, userVotes = {}) {
  const ck = configKey(c);
  const cv = votes[ck] || { up: 0, down: 0 };
  const userVote = userVotes[ck] || 0;
  const vars = Object.entries(c.enabledVars || {}).filter(([, v]) => v);
  const isProtonDb = (c.source || '').toLowerCase() === 'protondb';
  const isPlugin = !isProtonDb && (c.source || '').toLowerCase() !== 'web' && !(c.source || '').startsWith('web-');
  const sourceLabel = isProtonDb
    ? (c.isEdited ? 'ProtonDB (edited)' : 'ProtonDB')
    : isPlugin ? 'Decky Plugin' : 'Web';
  const unnamed = !c.profileName;
  const configId = c.configId != null ? `#${c.configId}` : (c.clientId ? `#${c.clientId.slice(0, 8)}…` : null);
  return `
    <div class="config-card">
      <div class="config-head">
        <div>
          <div class="config-name${unnamed ? ' config-name--unnamed' : ''}">${unnamed ? 'Unnamed Config' : esc(c.profileName)}</div>
          ${configId ? `<div class="config-id-line" title="${esc(c.clientId)}">${esc(configId)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
            <span class="source-badge pulse">
              <img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse
            </span>
            ${(c.isNonSteam || isNonSteamAppId(c.appId))
              ? '<span class="source-badge non-steam-game">Non-Steam</span>'
              : '<span class="source-badge steam-game">Steam</span>'}
          </div>
          <div class="vote-btns">
            <button class="vote-btn vote-up${userVote === 1 ? ' active' : ''}" data-vote="1" data-rkey="${esc(ck)}" data-appid="${c.appId}" title="Helpful"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${cv.up}</span></button>
            <button class="vote-btn vote-dn${userVote === -1 ? ' active' : ''}" data-vote="-1" data-rkey="${esc(ck)}" data-appid="${c.appId}" title="Not helpful"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="transform:scaleY(-1)"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${cv.down}</span></button>
          </div>
        </div>
      </div>
      ${isPlugin && c.pluginVersion ? `<div class="config-row"><span class="config-lbl">Plugin Version</span><span class="config-val">${esc(c.pluginVersion)}</span></div>` : ''}
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
      ${renderFormResponses(c)}
      <div class="config-hw">
        <div class="config-hw-label">Hardware</div>
        <div class="config-row"><span class="config-lbl">GPU</span><span>${cfgNa(esc(c.gpu))}</span></div>
        <div class="config-row"><span class="config-lbl">CPU</span><span>${cfgNa(esc(c.cpu))}</span></div>
        <div class="config-row"><span class="config-lbl">RAM</span><span>${cfgNa(esc(c.ram))}</span></div>
        <div class="config-row"><span class="config-lbl">OS</span><span>${cfgNa(esc(c.os))}</span></div>
        <div class="config-row"><span class="config-lbl">Kernel</span><span>${cfgNa(esc(c.kernel))}</span></div>
        <button class="all-details-btn" onclick="this.nextElementSibling.classList.toggle('open');this.textContent=this.nextElementSibling.classList.contains('open')?'Hide Hardware Details':'All Hardware Details'">All Hardware Details</button>
        <div class="all-details-panel">
          <div class="config-row"><span class="config-lbl">GPU Driver</span><span>${cfgNa(esc(c.gpuDriver))}</span></div>
          <div class="config-row"><span class="config-lbl">GPU Vendor</span><span>${cfgNa(esc(c.gpuVendor))}</span></div>
        </div>
      </div>
      <div class="config-meta">
        ${utcStamp(c.timestamp)} | Source: ${sourceLabel}
        <button class="cfg-dl-btn" data-cfg-json='${JSON.stringify(c).replace(/'/g,"&#39;")}' title="Download as JSON">JSON</button>
        ${c.clientId && c.clientId === getWebClientId()
          ? `<button class="cfg-dl-btn delete-cfg-btn" data-voter-id="${esc(c.clientId)}" data-app-id="${c.appId}" style="color:#c85050;border-color:#c85050" title="Delete your config">Delete</button>`
          : ''}
      </div>
    </div>`;
}

function renderConfigsSection(configs) {
  if (!configs.length) return '';
  const gistBar = GhAuth.isLoggedIn()
    ? `<div class="gist-bar" id="configs-gist-bar">
         <span class="gist-bar-label">Gist</span>
         <button class="gist-btn gist-btn-save" id="gist-save-btn" title="Save these configs to your GitHub Gist backup">Save to Gist</button>
         <button class="gist-btn" id="gist-load-btn" title="Load configs from your GitHub Gist backup">Load from Gist</button>
         <span class="gist-status" id="gist-status"></span>
       </div>`
    : '';
  return `
    <div class="configs-section">
      <div class="configs-section-head">
        <span class="configs-section-title">Proton Pulse Configs</span>
        <span class="configs-section-count">${configs.length} saved</span>
      </div>
      ${gistBar}
      <div class="configs-list">
        ${configs.map((c, i) => renderConfigCard(c, i)).join('')}
      </div>
    </div>`;
}

// - Render: trend summary ----------------------------

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

// - Deck Verified status helpers (stub for now) -------
//
const DECK_STATUS_LABELS = {
  verified:    'Verified',
  playable:    'Playable',
  unsupported: 'Unsupported',
  unknown:     'Unknown',
};
const DECK_CRITERIA_LABELS = [
  'All functionality is accessible when using the default controller configuration',
  'This game shows Steam Deck controller icons',
  'In-game interface text is legible on Steam Deck',
  'This game\'s default graphics configuration performs well on Steam Deck',
];

// Steam's resolved_category values: 0=unknown, 1=unsupported, 2=playable, 3=verified
const DECK_CAT_MAP = { 0: 'unknown', 1: 'unsupported', 2: 'playable', 3: 'verified' };
// display_type in resolved_items: 2=fail, 3=info/caveat, 4=pass
const DECK_DISPLAY_MAP = { 4: true, 3: null, 2: false };

// cache fetched deck compat so we dont re-fetch on every render
const _deckCache = {};

async function fetchDeckStatusForApp(appId) {
  if (!appId) return { status: 'unknown', criteria: null };
  if (_deckCache[appId]) return _deckCache[appId];
  try {
    const r = await fetch(`https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appId}`);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (!d.success) throw new Error('no data');
    const cat = d.results?.resolved_category ?? 0;
    const status = DECK_CAT_MAP[cat] || 'unknown';
    // map each resolved_item to a true/false/null criterion result
    const items = d.results?.resolved_items || [];
    const criteria = items.length >= 4
      ? items.slice(0, 4).map(i => DECK_DISPLAY_MAP[i.display_type] ?? null)
      : null;
    const ret = { status, criteria };
    _deckCache[appId] = ret;
    return ret;
  } catch {
    const ret = { status: 'unknown', criteria: null };
    _deckCache[appId] = ret;
    return ret;
  }
}

// synchronous fallback used for initial render before the async fetch returns
function getDeckStatusForApp(appId) {
  return _deckCache[appId] || { status: 'unknown', criteria: null };
}

// cache fetched system requirements
const _reqsCache = {};

async function fetchMinRequirements(appId) {
  if (!appId) return null;
  if (_reqsCache[appId] !== undefined) return _reqsCache[appId];
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const app = d?.[appId]?.data;
    if (!app) { _reqsCache[appId] = null; return null; }
    const reqs = app.pc_requirements;
    if (!reqs || (typeof reqs === 'object' && !reqs.minimum)) {
      _reqsCache[appId] = null;
      return null;
    }
    const ret = {
      minimum: reqs.minimum || null,
      recommended: reqs.recommended || null,
    };
    _reqsCache[appId] = ret;
    return ret;
  } catch {
    _reqsCache[appId] = null;
    return null;
  }
}

// Inline SVGs for Deck status icons. All 24x24 viewBox + currentColor so a
// single CSS color rule paints them.
const DECK_STATUS_ICON_SVG = {
  verified:    '<circle cx="12" cy="12" r="10" fill="#5ba32b"/><path d="M8 12.5 11 15.5 16 9.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  playable:    '<circle cx="12" cy="12" r="10" fill="#d4a72c"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" fill="#0a0c10" font-family="serif">i</text>',
  unsupported: '<circle cx="12" cy="12" r="10" fill="#c84a4a"/><path d="M8 8 16 16 M16 8 8 16" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  unknown:     '<circle cx="12" cy="12" r="10" fill="rgba(120,120,120,0.45)" stroke="rgba(255,255,255,0.25)" stroke-width="1"/><text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="serif">?</text>',
};

function renderDeckStatusButton(appId) {
  const { status } = getDeckStatusForApp(appId);
  const label = DECK_STATUS_LABELS[status] || 'Unknown';
  // Unsupported has no deeper modal content to surface beyond the criteria
  // list - keep the button clickable so users still see the explanation, but
  // tag it visually so it reads as "definitively negative"
  const disabledClass = status === 'unsupported' ? ' deck-status-btn-unsupported' : '';
  // Button label is just "Steam Deck" - the colored icon already encodes
  // the status (green check, yellow i, red x, gray ?). Full "Steam Deck:
  // Verified" string lives in the modal heading + the title-attr tooltip
  return `<button class="info-btn info-btn-labeled deck-status-btn${disabledClass}" id="deck-status-btn" title="Steam Deck: ${label} (click for details)">
    <svg width="16" height="16" viewBox="0 0 24 24">${DECK_STATUS_ICON_SVG[status] || DECK_STATUS_ICON_SVG.unknown}</svg>
    <span>Steam Deck</span>
  </button>`;
}

// Modal body for the Deck-status popup. Mirrors the Steam Store layout:
// title + summary sentence + per-criterion checklist
function renderDeckStatusModalContent(appId) {
  const { status, criteria } = getDeckStatusForApp(appId);
  const label = DECK_STATUS_LABELS[status] || 'Unknown';
  const summaryByStatus = {
    verified:    `This game is <strong>Verified</strong> on Steam Deck. Fully functional, works great with the built-in controls and display.`,
    playable:    `This game is <strong>Playable</strong> on Steam Deck. Functional, but may require extra effort to interact with or configure.`,
    unsupported: `This game is <strong>not supported</strong> on Steam Deck. Will not run, or critical features are unavailable.`,
    unknown:     `Steam Deck compatibility for this game is <strong>Unknown</strong>. Valve has not yet evaluated it.`,
  };
  const rows = criteria
    ? criteria.map((pass, i) => {
        const iconKey = pass === true ? 'verified' : pass === false ? 'unsupported' : 'playable';
        return `<div class="deck-criterion">
          <span class="deck-criterion-icon"><svg width="18" height="18" viewBox="0 0 24 24">${DECK_STATUS_ICON_SVG[iconKey]}</svg></span>
          <span>${esc(DECK_CRITERIA_LABELS[i])}</span>
        </div>`;
      }).join('')
    : '<p style="color:var(--muted);font-size:0.84rem;margin:0">No per-criterion data available for this title.</p>';
  return `
    <h3 style="margin:0 0 8px;font-size:0.95rem;color:var(--strong)">
      Steam Deck Compatibility:
      <span class="deck-status-badge deck-status-${status}">${label}</span>
    </h3>
    <p style="color:var(--muted);font-size:0.84rem;margin:0 0 12px;line-height:1.5">${summaryByStatus[status] || ''}</p>
    <div class="deck-criteria-list">${rows}</div>
    <p style="color:var(--muted);font-size:0.7rem;margin:10px 0 0;font-style:italic">Sample data shown - real per-game status will land when the pipeline publishes Steam Deck compatibility (task #37).</p>`;
}

// - Author / signals / permalink helpers --------------
//
// New card chrome: a left "author" column with avatar + identity, a row of
// icon-square "signal" indicators inline with the report body (install /
// verdict / OOB / tinker / Deck / owns / framegen), and a permalink button
// on the right column. Phase 1 - no Steam profile fetch yet, so anonymous
// Decky-plugin reports get the Proton Pulse atom icon plus a "Plugin user"
// label with their truncated client_id.

// Inline atom SVG matching the topbar brand mark. currentColor inherits the
// surrounding text color so the same blob works at any size or hue.
const ATOM_ICON_SVG = `
  <svg viewBox="0 0 36 36" fill="none" aria-hidden="true">
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4"/>
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4" transform="rotate(60 18 18)"/>
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4" transform="rotate(-60 18 18)"/>
    <circle cx="18" cy="18" r="2.8" fill="currentColor"/>
  </svg>`;

// Hardware fingerprints for Steam Deck detection - same regexes the pipeline
// stats.py uses. VanGogh = LCD APU codename; Sephiroth / APU 0932 = OLED.
const _DECK_LCD_RE  = /\b(amd\s+custom\s+(apu|gpu)\s+0405|vangogh)\b/i;
const _DECK_OLED_RE = /\b(amd\s+custom\s+(apu|gpu)\s+0932|sephiroth)\b/i;
function isSteamDeckHardware(r) {
  const haystack = `${r.cpu || ''} ${r.gpu || ''}`;
  return _DECK_LCD_RE.test(haystack) || _DECK_OLED_RE.test(haystack);
}

// SVG path data for each signal icon. Drawn at 24x24 viewBox. Currentcolor
// fills/strokes so we don't have to define per-icon color.
const SIGNAL_ICON_SVG = {
  install: '<path fill="currentColor" d="M5 20h14v-2H5v2zm7-2 5-5h-3V4h-4v9H7l5 5z"/>',
  start:   '<path fill="currentColor" d="M8 5v14l11-7z"/>',
  play:    '<path fill="currentColor" d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10.5 14H8v1.5H6V14H3.5v-2H6v-1.5h2V12h2.5v2zm5 .5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-3c-.83 0-1.5-.67-1.5-1.5S17.67 9 18.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>',
  verdict: '<path fill="currentColor" d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.3l.9-4.6.1-.3c0-.4-.2-.8-.4-1L14.2 1 7.6 7.6c-.4.4-.6.9-.6 1.4v10c0 1.1.9 2 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z"/>',
  oob:     '<path fill="currentColor" d="M12 2 4 6v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V6l-8-4zm-1 14-4-4 1.4-1.4 2.6 2.6 5.6-5.6L18 9l-7 7z"/>',
  tinker:  '<path fill="currentColor" d="m22 8-3.5 3.5L15 8l3.5-3.5C16 3.6 13.3 4.4 11.4 6.3c-2 2-2.7 4.8-1.8 7.4l-7.4 7.4 2.8 2.8 7.4-7.4c2.6.9 5.4.2 7.4-1.8 1.9-1.9 2.7-4.6 1.8-7.1z"/>',
  // Steam Deck wordmark glyph (the iconic "D" - solid dot + half-arc). Mirrors
  // the official Deck logo, not a generic gamepad
  deck:    '<circle cx="8" cy="12" r="3.6" fill="currentColor"/><path d="M13 5.4 a7.5 7.5 0 0 1 0 13.2" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round"/>',
  owns:    '<path fill="currentColor" d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>',
  framegen:'<path fill="currentColor" d="M7 21h2v-6H7v6zm4 0h2V9h-2v12zm4 0h2v-9h-2v9zM5 3v18h2V5h12V3H5z"/>',
};

// Build one signal icon square. value is 'yes' | 'no' | null/undefined.
// `whenYes` and `whenNo` control which side counts as "positive" - for most
// signals yes is good (green), but for tinker required the "no" answer to
// verdictOob (didn't work OOB) is what triggers the amber wrench
function renderSignalIcon(iconKey, value, label, opts = {}) {
  const path = SIGNAL_ICON_SVG[iconKey];
  if (!path) return '';
  const positive = opts.positive || 'yes';
  const negative = opts.negative || 'no';
  let state = 'neutral';
  if (value === positive) state = opts.positiveState || 'good';
  else if (value === negative) state = opts.negativeState || 'bad';
  const yesLabel = opts.yesLabel || 'Yes';
  const noLabel  = opts.noLabel  || 'No';
  // Owns icon (and any signal flagged anonymous-unverifiable) should explain
  // *why* the answer is missing - anonymous ProtonDB reports cannot be
  // verified ownership, distinct from "user just didn't answer"
  const neutralLabel = opts.neutralLabel || 'Not answered';
  const stateLabel = value === positive ? yesLabel : value === negative ? noLabel : neutralLabel;
  return `<span class="signal-icon signal-${state}" title="${label}: ${stateLabel}">
    <svg viewBox="0 0 24 24">${path}</svg>
  </span>`;
}

// Build the signals strip for a report. Order matters - vital signs (install
// chain) first so the eye reads "did it run?" left-to-right before getting to
// the optional extras (Deck, owns, framegen).
function renderSignalStrip(r) {
  const fr = r.formResponses || {};
  const isDeck = isSteamDeckHardware(r);
  // For tinker indicator: verdictOob='no' means user said "did not work out
  // of the box without tweaks" - which equates to "tinker required". So we
  // remap the value: 'no' -> "Yes, required" (amber state) and 'yes' -> "No
  // tinker needed" (good state)
  const tinkerValue = fr.verdictOob === 'no' ? 'yes'
                    : fr.verdictOob === 'yes' ? 'no'
                    : null;
  // Owns + Deck don't come from form responses - they come from other report
  // fields. Synthesize a 'yes'/null value so the same renderer works
  const ownsValue = r.gameOwned ? 'yes' : null;
  const deckValue = isDeck ? 'yes' : null;

  // Form-response signals get "Responses not available" when null since the
  // question was never asked/answered. Hardware-detected signals (Deck, Owns)
  // get their own specific neutral labels because they're inferred, not asked
  const formNeutral = 'Responses not available or recorded';
  const icons = [
    renderSignalIcon('install', fr.canInstall, 'Installs',
      { neutralLabel: formNeutral }),
    renderSignalIcon('start',   fr.canStart,   'Starts',
      { neutralLabel: formNeutral }),
    renderSignalIcon('play',    fr.canPlay,    'Playable',
      { neutralLabel: formNeutral }),
    renderSignalIcon('verdict', fr.verdict,    'Would recommend',
      { neutralLabel: formNeutral }),
    renderSignalIcon('oob',     fr.verdictOob, 'Works out of the box',
      { neutralLabel: formNeutral }),
    renderSignalIcon('tinker',  tinkerValue,   'Tinker required',
      { positiveState: 'warn', negativeState: 'good', neutralLabel: formNeutral }),
    renderSignalIcon('deck',    deckValue,     'Steam Deck',
      { positiveState: 'info', neutralLabel: 'Not detected' }),
    renderSignalIcon('owns',    ownsValue,     'Reporter owns the game',
      { positiveState: 'info',
        yesLabel: 'Confirmed',
        neutralLabel: (r.source || '').toLowerCase() === 'protondb'
          ? 'Anonymous report - cannot be verified'
          : 'Not confirmed' }),
    renderSignalIcon('framegen', fr.requiresFramegen, 'Framegen required for smooth play',
      { positiveState: 'warn', neutralLabel: formNeutral }),
  ].filter(Boolean);
  return `<div class="signal-strip">${icons.join('')}</div>`;
}

// Author identity for a report. Returns { kind, displayName, subtitle }.
function getAuthorIdentity(r) {
  const src = (r.source || '').toLowerCase();
  if (src === 'protondb') {
    return {
      kind: 'protondb',
      displayName: 'ProtonDB user',
      subtitle: r.reportId != null ? `#${r.reportId}` : 'anonymous',
    };
  }
  const ppId = r.protonPulseUserId || r.proton_pulse_user_id;
  const cid = r.clientId || r.client_id || '';
  const idShort = (ppId || cid).slice(0, 8);
  const label = src.startsWith('web') ? 'Web user' : 'Plugin user';
  return {
    kind: 'pulse',
    displayName: label,
    subtitle: idShort ? `#${idShort}…` : 'anonymous',
  };
}

// in-memory cache for author stats + avatars so we don't re-fetch per card
const _authorCache = {};

// fetch author aggregate stats from Supabase RPC
async function fetchAuthorStats(r) {
  const ppId = r.protonPulseUserId || r.proton_pulse_user_id;
  const cid = r.clientId || r.client_id || '';
  const key = ppId || cid;
  if (!key || _authorCache[key]?.stats) return _authorCache[key]?.stats || null;

  try {
    const rpcName = ppId ? 'author_stats_by_user' : 'author_stats_by_client';
    const param = ppId ? { p_user_id: ppId } : { p_client_id: cid };
    const url = `${SUPABASE_URL}/rest/v1/rpc/${rpcName}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(param),
    });
    if (!resp.ok) return null;
    const stats = await resp.json();
    _authorCache[key] = _authorCache[key] || {};
    _authorCache[key].stats = stats;
    return stats;
  } catch { return null; }
}

// fetch cached avatar for a linked Pulse user
async function fetchAuthorAvatar(ppId) {
  if (!ppId || _authorCache[ppId]?.avatar !== undefined) return _authorCache[ppId]?.avatar || null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=eq.${ppId}&select=avatar_url,display_name,cached_at`;
    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY },
    });
    if (!resp.ok) return null;
    const rows = await resp.json();
    const row = rows[0] || null;
    _authorCache[ppId] = _authorCache[ppId] || {};
    _authorCache[ppId].avatar = row;
    return row;
  } catch { return null; }
}

// render the author block, then async-enhance with stats + avatar
function renderAuthorBlock(r) {
  const a = getAuthorIdentity(r);
  const fullId = r.protonPulseUserId || r.proton_pulse_user_id || r.clientId || r.client_id || '';
  const tooltipExtra = fullId ? `\nFull id: ${fullId}` : '';
  // data-author-key lets the async enhancer find this element
  const authorKey = fullId.slice(0, 16);
  return `
    <div class="card-author" data-author-key="${esc(authorKey)}" title="${esc(a.displayName)} ${esc(a.subtitle)}${esc(tooltipExtra)}">
      <div class="author-avatar author-avatar-${a.kind}">${ATOM_ICON_SVG}</div>
      <div class="author-name">${esc(a.displayName)}</div>
      <div class="author-sub" title="${esc(fullId || a.subtitle)}">${esc(a.subtitle)}</div>
      <div class="author-stats"></div>
    </div>`;
}

// call after cards are in the DOM to backfill stats + avatars
async function enhanceAuthorBlocks(reports) {
  // dedupe: one fetch per unique author, not per card
  const seen = new Set();
  for (const r of reports) {
    const src = (r.source || '').toLowerCase();
    if (src === 'protondb') continue; // cant aggregate anonymous CDN reports
    const ppId = r.protonPulseUserId || r.proton_pulse_user_id;
    const cid = r.clientId || r.client_id || '';
    const key = (ppId || cid).slice(0, 16);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // fire stats + avatar fetches in parallel
    const [stats, avatar] = await Promise.all([
      fetchAuthorStats(r),
      ppId ? fetchAuthorAvatar(ppId) : Promise.resolve(null),
    ]);

    // patch matching DOM elements
    const els = document.querySelectorAll(`[data-author-key="${key}"]`);
    for (const el of els) {
      if (stats && stats.report_count > 0) {
        const statsEl = el.querySelector('.author-stats');
        if (statsEl) {
          const hrs = stats.total_hours > 0 ? ` / ${stats.total_hours}h` : '';
          statsEl.textContent = `${stats.report_count} reports${hrs}`;
        }
      }
      if (avatar?.avatar_url) {
        const avatarEl = el.querySelector('.author-avatar');
        if (avatarEl) {
          avatarEl.innerHTML = `<img src="${esc(avatar.avatar_url)}" alt="" class="author-avatar-img">`;
        }
        // use Steam display name if available
        if (avatar.display_name) {
          const nameEl = el.querySelector('.author-name');
          if (nameEl) nameEl.textContent = avatar.display_name;
        }
      }
    }
  }
}

// Permalink button - copies a deep-link to the clipboard. Hash format mirrors
// the existing route shape: #/app/{appId}#report-{id}
function renderPermalink(r) {
  const id = r.reportId != null ? `r${r.reportId}` : (r.clientId ? `c${r.clientId.slice(0, 8)}` : '');
  if (!id || !r.appId) return '';
  const anchor = `report-${id}`;
  // Inline JS avoids needing a separate event delegate hook for now. Replace
  // with delegated handler when this lands in production
  const fn = `(function(b){const u=location.origin+location.pathname+'#/app/${r.appId}#${anchor}';navigator.clipboard?.writeText(u);b.classList.add('copied');setTimeout(()=>b.classList.remove('copied'),900);return false;})(this)`;
  return `<button class="permalink-btn" type="button" title="Copy permalink to this report" onclick="${fn}">
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M3.9 12c0-1.7 1.4-3.1 3.1-3.1h4V7H7c-2.8 0-5 2.2-5 5s2.2 5 5 5h4v-1.9H7c-1.7 0-3.1-1.4-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.7 0 3.1 1.4 3.1 3.1s-1.4 3.1-3.1 3.1h-4V17h4c2.8 0 5-2.2 5-5s-2.2-5-5-5z"/></svg>
  </button>`;
}

// - Render: report card ------------------------------

function renderCard(r, votes, userVotes = {}, configPlaytimeTotals = []) {
  const v     = votes[reportKey(r)] || { up: 0, down: 0 };
  const rKey  = reportKey(r);
  const userVote = userVotes[rKey] || 0;
  // Raw score is already on a 0-100 scale internally; we used to divide by 10
  // and display X.X/10 - switched to direct % to match the plugin pill format
  const confRaw = Math.min(100, Math.max(0, r.score || estimateScore(r)));
  const confPct = Math.round(confRaw);
  const src = (r.source || '').toLowerCase();
  // Pulse-submitted reports land in user_configs with source='user' (plugin) or
  // 'proton-pulse' (legacy). ProtonDB mirror rows are tagged 'protondb'.
  // Anything starting with 'web' is the web submit flow, which is a Pulse path too
  const isProtonDb = src === 'protondb';
  const isWeb = src.startsWith('web');
  // When running a Windows game via Proton on Linux, label as Steam Play rather than Linux
  const webPlatformLabel = (src === 'web-linux' && r.protonVersion)
    ? 'Steam Play'
    : { 'web-steamdeck': 'Steam Deck', 'web-linux': 'Linux', 'web-windows': 'Windows', 'web-macos': 'macOS', 'web': 'Web' }[src] || 'Web';
  const rc    = RATING_COLORS[r.rating] || '#3a4a5a';
  const rt    = RATING_TEXT[r.rating]   || '#c8d4e0';
  const na = s => s || '<span style="color:#4a5f70;font-style:italic">Not available</span>';
  // Source badge used to render top-right of each card (Pulse / ProtonDB).
  // Removed - the same info already appears in the "Source" row at the bottom
  // of the card, so two pills said the same thing and crowded the right column.
  return `
    <div class="card" id="${(() => { const id = r.reportId != null ? `r${r.reportId}` : (r.clientId ? `c${r.clientId.slice(0, 8)}` : ''); return id ? `report-${id}` : ''; })()}">
      ${renderAuthorBlock(r)}
      <div class="card-body">
        <div class="proton">${esc(r.protonVersion || 'Unknown')}</div>
        <div class="hw">${esc([r.gpu, r.os].filter(Boolean).join(' / ') || 'Hardware unavailable')}</div>
        <div class="age">
          ${daysAgo(r.timestamp)}
          ${(r.durationMinutes != null || fmtDuration(r.duration)) ? `<span class="hours-inline" title="Steam playtime when the reporter submitted this report">  &middot;  ${r.durationMinutes != null ? fmtMinutes(r.durationMinutes) : fmtDuration(r.duration)} played</span>` : ''}
        </div>
        ${renderSignalStrip(r)}
      </div>
      <div class="right">
        <div class="card-rating-row">
          <a class="confidence-pill conf-link" href="confidence.html?app=${r.appId}${r.reportId != null ? '&report=' + r.reportId : '&ts=' + (r.timestamp || '')}" onclick="event.stopPropagation()" title="See the factor-by-factor breakdown of how this confidence was computed" style="background:${confColor(confPct / 10)};color:${confTextColor(confPct / 10)}">Confidence: ${confPct}%</a>
          <span class="rating" style="background:${rc};color:${rt}">${r.rating || '?'}</span>
        </div>
        <div class="vote-btns">
          <button class="vote-btn vote-up${userVote === 1 ? ' active' : ''}" data-vote="1" data-rkey="${esc(rKey)}" data-appid="${r.appId}" title="Helpful"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${v.up}</span></button>
          <button class="vote-btn vote-dn${userVote === -1 ? ' active' : ''}" data-vote="-1" data-rkey="${esc(rKey)}" data-appid="${r.appId}" title="Not helpful"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="transform:scaleY(-1)"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${v.down}</span></button>
        </div>
      </div>
    </div>
    <div class="card-summary">
      <div class="row"><span class="label">GPU</span><span>${na(esc(r.gpu))}</span></div>
      <div class="row"><span class="label">CPU</span><span>${na(esc(r.cpu))}</span></div>
      <div class="row"><span class="label">OS</span><span>${na(esc(r.os))}</span></div>
      <div class="row"><span class="label">Proton</span><span>${na(esc(r.protonVersion))}</span></div>
      ${(r.durationMinutes != null || fmtDuration(r.duration)) ? `<div class="row"><span class="label">Steam playtime</span><span>${r.durationMinutes != null ? fmtMinutes(r.durationMinutes) : fmtDuration(r.duration)}</span></div>` : ''}
      ${(() => { const pt = r.configKey && configPlaytimeTotals.find(t => t.config_key === r.configKey); return pt ? `<div class="row"><span class="label">Config playtime</span><span title="${pt.session_count} session${pt.session_count !== 1 ? 's' : ''}">${fmtMinutes(pt.total_minutes)}</span></div>` : ''; })()}
      ${r.notes ? `<div class="notes-full">${esc(r.notes)}</div>` : ''}
      <div class="all-details-panel hw-details-panel">
        <div class="row"><span class="label">RAM</span><span>${na(esc(r.ram))}</span></div>
        ${r.vramMb ? `<div class="row"><span class="label">VRAM</span><span>${r.vramMb >= 1024 ? (r.vramMb/1024).toFixed(1)+' GB' : r.vramMb+' MB'}</span></div>` : ''}
        <div class="row"><span class="label">GPU Driver</span><span>${na(esc(r.gpuDriver))}</span></div>
        <div class="row"><span class="label">Kernel</span><span>${na(esc(r.kernel))}</span></div>
        ${r.launchOptions ? `<div class="row"><span class="label">Launch Options</span><span>${esc(r.launchOptions)}</span></div>` : ''}
      </div>
      ${(() => { const fr = buildFormRows(r); return fr ? `<div class="all-details-panel fr-panel"><div class="fr-section">${fr}</div></div>` : ''; })()}
      ${r.reportId != null ? `<div class="row"><span class="label">Report ID</span><span style="font-family:monospace;font-size:0.8em;color:var(--muted)">#${r.reportId}</span></div>` : ''}
      <div class="row"><span class="label">Source</span><span>${isProtonDb ? 'ProtonDB' : isWeb ? 'Web submission' : 'Decky Proton Pulse'}</span></div>
      <!-- All action buttons live in the footer in one uniform blue style:
           Show Report Responses (if there are any), All Hardware Details,
           Permalink, JSON. Delete only shows for the report owner. -->
      <div class="card-footer">
        ${(() => { const fr = buildFormRows(r); return fr ? `<button class="action-btn" onclick="const p=this.closest('.card-summary').querySelector('.fr-panel');p.classList.toggle('open');this.textContent=p.classList.contains('open')?'Hide Report Responses':'Show Report Responses'">Show Report Responses</button>` : `<button class="action-btn action-btn-disabled" disabled title="Responses not available or recorded">No responses recorded</button>`; })()}
        <button class="action-btn" onclick="this.closest('.card-summary').querySelector('.hw-details-panel').classList.toggle('open');this.textContent=this.closest('.card-summary').querySelector('.hw-details-panel').classList.contains('open')?'Hide Hardware Details':'All Hardware Details'">All Hardware Details</button>
        ${renderPermalink(r)}
        <button class="action-btn" data-report-json='${JSON.stringify(r).replace(/'/g,"&#39;")}' title="Download as JSON">JSON</button>
        ${r.clientId && r.clientId === getWebClientId() ? `<button class="action-btn action-btn-danger delete-report-btn" data-app-id="${r.appId || ''}" title="Delete your report">Delete</button>` : ''}
      </div>
    </div>`;
}

// - Render: game page --------------------------------

async function renderGamePage(appId) {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading reports...</div>';

  const [cdn, configs, nativeReports, votes, userVotes, playtimeTotals] = await Promise.all([
    fetchCdn(appId),
    fetchSupabase(appId),
    fetchNativeReports(appId),
    fetchVotes(appId),
    fetchUserVotes(appId),
    fetchConfigPlaytimeTotals(appId),
  ]);

  // If CDN was empty but the user already clicked "Check ProtonDB Live" this
  // session, use the cached live result so the page re-renders correctly.
  const liveCached = !cdn.length ? (_protonDbLiveCache.get(String(appId)) || []) : [];
  const cdnMiss = !cdn.length && !liveCached.length;

  const reports = [
    ...cdn.map(r => ({ ...r, source: 'protondb' })),
    ...liveCached.map(r => ({ ...r, source: 'protondb' })),
    ...nativeReports,
  ];

  // Hard miss: nothing in cache, nothing native, nothing from Pulse.
  // Show a "not in our mirror" state with a user-triggered live check button
  // rather than auto-fetching so we don't hammer the ProtonDB API.
  if (!reports.length && !configs.length) {
    el.innerHTML = `
      <div class="state-box">
        <p style="margin:0 0 10px">This game (<strong>${esc(String(appId))}</strong>) is not in our cached ProtonDB mirror.</p>
        <p style="margin:0 0 14px;color:var(--muted);font-size:0.88rem">Our mirror updates periodically. You can check ProtonDB live, but please use this sparingly to avoid overloading their API.</p>
        <button id="live-check-btn" class="submit-report-btn" style="margin:0">Check ProtonDB Live</button>
        <span id="live-check-status" style="margin-left:10px;font-size:0.85rem;color:var(--muted)"></span>
      </div>`;
    el.querySelector('#live-check-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const status = el.querySelector('#live-check-status');
      btn.disabled = true;
      btn.textContent = 'Checking...';
      if (status) status.textContent = '';
      const live = await fetchProtonDbLive(appId);
      if (live.length) {
        await renderGamePage(appId);
      } else {
        btn.disabled = false;
        btn.textContent = 'Check ProtonDB Live';
        if (status) status.textContent = 'Not found on ProtonDB either.';
      }
    });
    return;
  }

  // Resolve a human-readable title: reports first (they almost always carry one),
  // then configs, then fall back to the pre-loaded search-index which has the
  // canonical Steam name per appId. Final fallback is the bare app id.
  await loadSearchIndex();
  const indexHit = (searchIndex || []).find(row => String(row[0]) === String(appId));
  const title = reports[0]?.title || configs[0]?.appName || indexHit?.[1] || `App ${appId}`;
  const protonDbTier = tierFromReports(cdn);
  const pulseTier = pulseTierFromReports(nativeReports, cdn.length);
  document.title = `${title} - Proton Pulse`;

  const totalCommunityMinutes = playtimeTotals.reduce((s, r) => s + (r.total_minutes || 0), 0);
  const totalSessionCount = playtimeTotals.reduce((s, r) => s + (r.session_count || 0), 0);

  let sortMode = 'recent';
  // Filter state. Persisted to localStorage when the user ticks the "Save"
  // checkbox - same shape works whether signed in or not (profile sync can
  // layer on top later by mirroring this object to the user_configs row).
  const FILTER_STORAGE_KEY = 'proton-pulse:report-filters';
  const FILTER_PERSIST_KEY = 'proton-pulse:report-filters-persist';
  const persistedFilters = (() => {
    try {
      if (localStorage.getItem(FILTER_PERSIST_KEY) !== '1') return {};
      return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}') || {};
    } catch { return {}; }
  })();

  let filterGpu    = persistedFilters.gpu    || '';
  let filterOs     = persistedFilters.os     || '';
  let filterRating = persistedFilters.rating || '';
  // 'deck-lcd' / 'deck-oled' / 'deck-any' / 'desktop' / ''
  let filterDevice = persistedFilters.device || '';
  // Minimum reporter playtime in minutes (0 = any). Useful to skip "launched
  // it once" reports that don't reflect real-use compatibility
  let filterMinPlaytime = persistedFilters.minPlaytime || 0;
  let persistFilters = localStorage.getItem(FILTER_PERSIST_KEY) === '1';

  function saveFiltersIfEnabled() {
    if (!persistFilters) return;
    try {
      const snapshot = { gpu: filterGpu, os: filterOs, rating: filterRating, device: filterDevice, minPlaytime: filterMinPlaytime };
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(snapshot));
    } catch { /* quota / disabled - ignore */ }
  }
  // Unified source filter across configs + reports: 'pulse-config', 'pulse-report',
  // 'protondb', or '' for any
  let filterSource = localStorage.getItem('proton-pulse:config-type') || '';

  const gpuVendor = g => {
    if (!g) return '';
    const l = g.toLowerCase();
    if (/nvidia|geforce|rtx|gtx/.test(l)) return 'nvidia';
    if (/\bamd\b|radeon/.test(l)) return 'amd';
    if (/\bintel\b|iris|arc\b/.test(l)) return 'intel';
    return '';
  };
  const osBase = o => {
    if (!o) return '';
    return o.trim().split(/\s+/)[0];
  };

  // Tag each incoming item with the bucket it belongs to so we can render + filter
  // from one unified list. 'pulse-report' covers both plugin and web submissions,
  // 'protondb' is the upstream mirror, 'pulse-config' is a saved launch profile
  const taggedReports = reports.map((r) => {
    const src = (r.source || '').toLowerCase();
    const bucket = src === 'protondb' ? 'protondb' : 'pulse-report';
    return { ...r, _kind: 'report', _bucket: bucket };
  });
  const taggedConfigs = configs.map((c) => {
    const src = (c.source || '').toLowerCase();
    const bucket = src === 'protondb'
      ? (c.isEdited ? 'protondb-edited' : 'protondb')
      : 'pulse-config';
    return { ...c, _kind: 'config', _bucket: bucket };
  });
  const combined = [...taggedConfigs, ...taggedReports];

  const filtered = () => {
    let arr = [...combined];
    if (filterGpu)    arr = arr.filter(r => gpuVendor(r.gpu) === filterGpu);
    if (filterOs)     arr = arr.filter(r => osBase(r.os) === filterOs);
    if (filterDevice) {
      arr = arr.filter(r => {
        const haystack = `${r.cpu || ''} ${r.gpu || ''}`;
        const isLcd  = _DECK_LCD_RE.test(haystack);
        const isOled = _DECK_OLED_RE.test(haystack);
        if (filterDevice === 'deck-lcd')  return isLcd;
        if (filterDevice === 'deck-oled') return isOled;
        if (filterDevice === 'deck-any')  return isLcd || isOled;
        if (filterDevice === 'desktop')   return !isLcd && !isOled;
        return true;
      });
    }
    if (filterMinPlaytime > 0) {
      // Match against durationMinutes if present; otherwise translate the
      // bucketed duration enum to a coarse minute count so old reports still
      // get filtered consistently
      const DUR_MIN = { underOneHour: 0, oneToFourHours: 60, fourToTenHours: 240, overTenHours: 600 };
      arr = arr.filter(r => {
        if (r.durationMinutes != null) return r.durationMinutes >= filterMinPlaytime;
        const m = DUR_MIN[r.duration];
        return m != null && m >= filterMinPlaytime;
      });
    }
    // Rating filter only makes sense for reports. Configs don't carry a rating,
    // so drop them when the user explicitly narrows by rating
    if (filterRating) arr = arr.filter(r => r._kind === 'report' && r.rating === filterRating);
    if (filterSource) arr = arr.filter(r => r._bucket === filterSource);
    return arr;
  };

  const sorted = () => {
    const arr = filtered();
    if (sortMode === 'recent') arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    else if (sortMode === 'votes') arr.sort((a, b) => {
      const aKey = a._kind === 'config' ? configKey(a) : reportKey(a);
      const bKey = b._kind === 'config' ? configKey(b) : reportKey(b);
      const va = votes[aKey] || { up:0, down:0 };
      const vb = votes[bKey] || { up:0, down:0 };
      return (vb.up - vb.down) - (va.up - va.down);
    });
    return arr;
  };

  function render() {
    const reps = sorted();
    const protonDbBadgeColor = RATING_COLORS[protonDbTier] || '#3a4a5a';
    const protonDbBadgeText = RATING_TEXT[protonDbTier] || '#c8d4e0';
    const pulseHasReports = nativeReports.length > 0;
    const pulseHasConfigs = configs.length > 0;
    const pulseSummaryBits = [];
    if (pulseHasReports) pulseSummaryBits.push(`${nativeReports.length} report${nativeReports.length !== 1 ? 's' : ''}`);
    if (pulseHasConfigs) pulseSummaryBits.push(`${configs.length} config${configs.length !== 1 ? 's' : ''}`);
    // Combined tile - Pulse + ProtonDB roll into one homogeneous "Community"
    // summary since the report list below mixes both sources too. pulseTier
    // already accepts a protonDbCount that weights both sources into one
    // overall rating + confidence, which is exactly what we want here
    const totalReports = nativeReports.length + cdn.length;
    const hasAnyReports = totalReports > 0;
    // Use the combined-source tier when there are any reports; fall back to
    // protondb tier if only protondb reports exist; "pending" when nothing
    const overallTier = hasAnyReports
      ? (pulseHasReports ? pulseTier.tier : protonDbTier)
      : 'pending';
    const overallTileColor = hasAnyReports ? (RATING_COLORS[overallTier] || '#3a4a5a') : '#2a5a8c';
    const overallTileText  = hasAnyReports ? (RATING_TEXT[overallTier]   || '#c8d4e0') : '#d7e9fb';
    // Single summary line - confidence label comes from TOTAL report count,
    // not just Pulse. The old code used pulseTier.confidence which returns
    // 'none' when there are 0 Pulse reports (even if there are 163 ProtonDB
    // reports), producing the nonsensical "none confidence across 163 reports"
    const confBucket = totalReports >= 20 ? 'high' : totalReports >= 5 ? 'medium' : totalReports >= 1 ? 'low' : '';
    const overallTileSummary = hasAnyReports
      ? `${confBucket} confidence across ${totalReports} report${totalReports !== 1 ? 's' : ''}${pulseHasConfigs ? ` / ${configs.length} config${configs.length !== 1 ? 's' : ''}` : ''}`
      : (pulseHasConfigs ? 'Community-submitted configs available' : 'No community data yet');
    // Confidence: prefer Pulse's computed confidencePct (weights both sources)
    // when there are Pulse reports; otherwise fall back to a sample-size only
    // approximation against the ProtonDB report count alone
    const overallConfidencePct = pulseHasReports && pulseTier.confidencePct
      ? pulseTier.confidencePct
      : (cdn.length > 0 ? Math.min(95, Math.round(30 + Math.log2(Math.max(1, cdn.length)) * 18)) : 0);
    // Per-source breakdown - tiny stat strip at the bottom of the tile. Always
    // shows BOTH Pulse + ProtonDB (even at 0) so users understand both feeds
    // contribute even when only one has data. Configs only appear if > 0
    const statBits = [
      `<span><strong>${nativeReports.length}</strong> Pulse</span>`,
      `<span><strong>${cdn.length}</strong> ProtonDB</span>`,
    ];
    if (configs.length) statBits.push(`<span><strong>${configs.length}</strong> config${configs.length !== 1 ? 's' : ''}</span>`);
    const statRow = `<div class="source-summary-stats">${statBits.join('<span class="ss-sep">/</span>')}</div>`;

    // Rating distribution as a grid - shows ALL 5 tiers always with their
    // count, even at 0. Replaces an earlier horizontal stripe bar that
    // looked weird when only one tier had data ("just a gold blob"); the
    // grid format reads at a glance and works the same with 1 report or 100
    const allReports = [...nativeReports, ...cdn];
    const ratingCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0 };
    for (const r of allReports) {
      if (ratingCounts[r.rating] != null) ratingCounts[r.rating]++;
    }
    const TIER_LABELS = { platinum: 'Plat', gold: 'Gold', silver: 'Silv', bronze: 'Bron', borked: 'Bork' };
    const ratingDistribution = `
      <div class="source-summary-distribution" title="Rating distribution across all reports">
        ${Object.entries(ratingCounts).map(([tier, n]) => `
          <div class="dist-chip dist-${tier}${n === 0 ? ' dist-empty' : ''}" title="${n} ${tier} report${n !== 1 ? 's' : ''}">
            <span class="dist-chip-label">${TIER_LABELS[tier]}</span>
            <span class="dist-chip-count">${n}</span>
          </div>
        `).join('')}
      </div>`;

    // Newest-report age - tells visitors at a glance whether the data is
    // fresh or stale. Uses the existing daysAgo helper for consistency
    const newestTs = allReports.length
      ? Math.max(...allReports.map(r => r.timestamp || 0))
      : 0;
    const freshnessLine = newestTs ? `
      <div class="source-summary-freshness">Newest report: <strong>${daysAgo(newestTs)}</strong></div>` : '';
    // Two-column inner layout so the wide tile actually uses its horizontal
    // space. Left: kicker + rating + confidence + summary. Right: distribution
    // bar + freshness + per-source breakdown. Collapses to single column on
    // narrow screens via the media query in app.css
    const sourceTiles = `
      <div class="source-summary-grid">
        <button class="source-summary-tile source-summary-tile-combined" type="button" data-target="pulse-summary">
          <div class="ss-primary">
            <!-- Badge on top, confidence pill below - reads as "the rating
                 first, the trustworthiness second" which matches how users
                 actually scan compatibility scores -->
            <span class="source-summary-tier-row">
              <span class="source-summary-value" style="background:${overallTileColor};color:${overallTileText}">${overallTier}</span>
              ${hasAnyReports && overallConfidencePct ? `<a class="source-summary-conf conf-link" href="confidence.html?app=${appId}" onclick="event.stopPropagation()" style="background:${confColor(overallConfidencePct / 10)};color:${confTextColor(overallConfidencePct / 10)}" title="See the factor-by-factor breakdown of this aggregate confidence">Confidence: ${overallConfidencePct}%</a>` : ''}
            </span>
            <span class="source-summary-meta">${overallTileSummary}</span>
          </div>
          <div class="ss-details">
            ${ratingDistribution}
            ${freshnessLine}
            ${statRow}
          </div>
        </button>
      </div>`;

    // Show a banner if the signed-in client already has a public report on this
    // game (matched via client id on user_configs). No draft concept: upload means publish.
    const myCid = getWebClientId();
    const myPublished = nativeReports.find(r => r.clientId && r.clientId === myCid);
    const myStatusBadge = myPublished ? `
      <div class="my-config-banner my-config-banner--published" title="Your report for this game">
        <span class="my-config-banner-dot"></span>
        <span class="my-config-banner-label">Your report:</span>
        <span class="my-config-banner-status">Published</span>
      </div>` : '';

    el.innerHTML = `
      <div class="game-header">
        <div class="game-header-main">
          <img src="${STEAM_IMG(appId)}" onerror="this.style.display='none'" alt="">
          <div class="game-header-info">
            <div class="game-title">${esc(title)}</div>
            <div class="game-meta">
              App ${appId}
              &nbsp;/&nbsp; <strong>${cdn.length}</strong> ProtonDB report${cdn.length !== 1 ? 's' : ''}
              ${nativeReports.length ? `&nbsp;/&nbsp; <strong>${nativeReports.length}</strong> Pulse report${nativeReports.length !== 1 ? 's' : ''}` : ''}
              &nbsp;/&nbsp; <strong>${configs.length}</strong> Pulse config${configs.length !== 1 ? 's' : ''}
              ${totalCommunityMinutes > 0 ? `&nbsp;/&nbsp; <strong>${fmtMinutes(totalCommunityMinutes)}</strong> community playtime (${totalSessionCount} session${totalSessionCount !== 1 ? 's' : ''})` : ''}
            </div>
            <div class="game-header-summary">
              Browse the combined community view for this game across ProtonDB reports, Pulse compatibility reports, and shared Pulse configs.
            </div>

            ${myStatusBadge}
          </div>
        </div>
        <div class="game-header-side">
          ${sourceTiles}
          <div class="game-header-actions">
            <a class="info-btn" href="scoring.html" id="rating-info-btn" title="How scoring works (opens the canonical scoring page)"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="11" fill="#3b82f6"/><text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="serif">i</text></svg></a>
            <button class="info-btn info-btn-labeled" id="stats-btn" title="Per-game compatibility stats: confidence factors, trend, Proton version success rates, launch option frequency"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="4" height="18" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="17" y="12" width="4" height="9" rx="1"/></svg><span>Stats</span></button>
            <button class="info-btn info-btn-labeled" id="min-reqs-btn" title="Minimum system requirements (from Steam Store, served by pipeline)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="14" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="20" x2="15" y2="20"/></svg><span>Min. Requirements</span></button>
            ${renderDeckStatusButton(appId)}
            <a class="submit-report-btn" href="submit.html?app=${appId}&title=${encodeURIComponent(title)}">Submit Report</a>
          </div>
        </div>
        <div class="info-tooltip" id="min-reqs-tip">
          <div class="info-tooltip-inner" id="min-reqs-content">
            <h3 style="margin:0 0 8px;font-size:0.95rem;color:var(--strong)">Minimum System Requirements</h3>
            <p style="color:var(--muted);font-size:0.84rem;margin:0">System requirements come from the Steam Store appdetails endpoint. The plugin already pulls these as scoring confidence boosters; webui needs the pipeline to publish them per-game (task #37). Once that lands, this panel will show the same CPU/GPU/RAM/OS minimums the plugin shows on the Configure tab.</p>
            <p style="color:var(--muted);font-size:0.78rem;margin:8px 0 0;font-style:italic">Awaiting pipeline backfill</p>
          </div>
        </div>
        <div class="info-tooltip" id="deck-status-tip">
          <div class="info-tooltip-inner" id="deck-status-content">${renderDeckStatusModalContent(appId)}</div>
        </div>
        <div class="info-tooltip" id="stats-tip">
          <div class="info-tooltip-inner" id="stats-content">
            <h3 style="margin:0 0 8px;font-size:0.95rem;color:var(--strong)">Compatibility Stats</h3>
            <p style="color:var(--muted);font-size:0.84rem;margin:0">Loading stats...</p>
          </div>
        </div>

        <!-- External link footer lives inside the game-header banner so it
             reads as part of the game's metadata strip instead of a floating
             group of buttons. Less cluttered, less visual seams between the
             rating tile and the navigation links -->
        <div class="hub-links hub-links-in-banner">
          <a class="hub-link" href="https://store.steampowered.com/app/${appId}" target="_blank" rel="noopener">Steam ></a>
          <a class="hub-link" href="https://steamdb.info/app/${appId}/" target="_blank" rel="noopener">SteamDB ></a>
          <a class="hub-link" href="https://www.protondb.com/app/${appId}" target="_blank" rel="noopener">ProtonDB ></a>
          <a class="hub-link" href="https://www.pcgamingwiki.com/w/index.php?search=${encodeURIComponent(title)}" target="_blank" rel="noopener">PCGamingWiki ></a>
          <a class="hub-link" href="https://steamcharts.com/app/${appId}" target="_blank" rel="noopener">Steam Charts ></a>
          <a class="hub-link" href="https://github.com/ValveSoftware/Proton/issues?q=${encodeURIComponent(title)}" target="_blank" rel="noopener">Proton Issues ></a>
          <a class="hub-link" href="${dataFilesHref(appId)}" target="_blank" rel="noopener">Data Files ></a>
          <a class="hub-link" href="scoring.html">How Scoring Works ></a>
        </div>
      </div>

      ${trendSummary(reports)}

      <div class="reports-section-head" id="pulse-summary">
        <div class="reports-section-copy">
          <span class="reports-section-title">Community Configs &amp; Reports</span>
          <span class="reports-section-subtitle">Saved Pulse configs and compatibility reports from ProtonDB and Proton Pulse contributors, listed together and labeled by source.</span>
        </div>
        <div class="sort-bar">
          <button class="${sortMode==='recent'?'active':''}" data-sort="recent">Recent</button>
          <button class="${sortMode==='votes'?'active':''}" data-sort="votes">Top Voted</button>
        </div>
      </div>

      <div class="filter-bar">
        ${(() => {
          const GPU_LABEL = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };
          const SRC_LABEL = {
            'pulse-config': 'Pulse',
            'pulse-report': 'Pulse Report',
            'protondb': 'ProtonDB',
            'protondb-edited': 'ProtonDB (edited)',
          };
          const SRC_ORDER = ['pulse-config', 'pulse-report', 'protondb', 'protondb-edited'];
          const RATING_LABEL = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked' };
          const RATING_ORDER = ['platinum','gold','silver','bronze','borked'];

          const availGpus    = [...new Set(combined.map(r => gpuVendor(r.gpu)).filter(Boolean))];
          const availOs      = [...new Set(combined.map(r => osBase(r.os)).filter(Boolean))].sort();
          const availRatings = RATING_ORDER.filter(rt => taggedReports.some(r => r.rating === rt));
          const availSrcs    = SRC_ORDER.filter(b => combined.some(r => r._bucket === b));

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
          const srcSel    = availSrcs.length > 1 ? `
            <label>Source</label>
            <select id="fSource">
              <option value="">Any</option>
              ${availSrcs.map(v => `<option value="${v}" ${filterSource===v?'selected':''}>${SRC_LABEL[v]||v}</option>`).join('')}
            </select>` : '';

          // Steam Deck device filter. Only show if at least one report on this
          // game is on a Deck, otherwise the dropdown is meaningless noise
          const hasDeck = combined.some(r => {
            const h = `${r.cpu || ''} ${r.gpu || ''}`;
            return _DECK_LCD_RE.test(h) || _DECK_OLED_RE.test(h);
          });
          const deviceSel = hasDeck ? `
            <label>Device</label>
            <select id="fDevice">
              <option value="">Any</option>
              <option value="deck-any"  ${filterDevice==='deck-any'?'selected':''}>Steam Deck (any)</option>
              <option value="deck-lcd"  ${filterDevice==='deck-lcd'?'selected':''}>Steam Deck LCD</option>
              <option value="deck-oled" ${filterDevice==='deck-oled'?'selected':''}>Steam Deck OLED</option>
              <option value="desktop"   ${filterDevice==='desktop'?'selected':''}>Desktop / other</option>
            </select>` : '';

          // Playtime threshold filter. Buckets match the values stored on
          // existing reports so the dropdown reads predictably (e.g. "2h+"
          // matches reports tagged oneToFourHours and up)
          const playtimeSel = `
            <label>Min playtime</label>
            <select id="fPlaytime">
              <option value="0"    ${filterMinPlaytime===0?'selected':''}>Any</option>
              <option value="60"   ${filterMinPlaytime===60?'selected':''}>1h+</option>
              <option value="120"  ${filterMinPlaytime===120?'selected':''}>2h+</option>
              <option value="240"  ${filterMinPlaytime===240?'selected':''}>4h+</option>
              <option value="600"  ${filterMinPlaytime===600?'selected':''}>10h+</option>
            </select>`;

          const persistChk = `
            <label class="filter-persist" title="Save these filters so they apply next time you visit a game page">
              <input type="checkbox" id="fPersist" ${persistFilters ? 'checked' : ''}>
              <span>Save filters</span>
            </label>`;

          const anyActive = filterGpu || filterOs || filterRating || filterSource || filterDevice || filterMinPlaytime;
          return gpuSel + osSel + ratingSel + srcSel + deviceSel + playtimeSel + persistChk +
            (anyActive ? `<span class="filter-count">${reps.length} of ${combined.length}</span>` : '');
        })()}
      </div>

      <div class="cards">
        ${reps.length
          ? reps.map((r, i) => r._kind === 'config'
              ? renderConfigCard(r, i, votes, userVotes)
              : renderCard(r, votes, userVotes, playtimeTotals)
            ).join('')
          : '<div class="state-box" style="border:none">No configs or reports match filters</div>'}
      </div>
    `;

    el.querySelectorAll('.sort-bar button').forEach(b =>
      b.onclick = () => { sortMode = b.dataset.sort; render(); }
    );
    // rating-info-btn is now a plain <a href> to scoring.html - no JS needed.
    // populateScoringTooltip / #rating-info-tip kept around in case anything
    // else still references them (search/etc); safe to delete in a cleanup pass
    el.querySelector('#stats-btn')?.addEventListener('click', () => {
      const tip = el.querySelector('#stats-tip');
      if (!tip) return;
      const isOpen = tip.classList.toggle('open');
      if (isOpen) {
        const content = el.querySelector('#stats-content');
        if (content) {
          const allReports = [...cdn, ...nativeReports];
          const stats = computeGameStats(allReports, configs);
          console.debug(`[proton-pulse] computeGameStats | appId=${appId} reports=${allReports.length} configs=${configs.length} confidence=${stats.confidencePct}% trend=${stats.trendDir}`);
          content.innerHTML = renderStatsPanel(stats, appId);
        }
      }
    });
    el.querySelector('#min-reqs-btn')?.addEventListener('click', () => {
      // Min-reqs panel reuses the same .info-tooltip styling. Content is a
      // placeholder until task #37 publishes per-game sysreqs from the pipeline
      el.querySelector('#min-reqs-tip')?.classList.toggle('open');
    });
    el.querySelector('#deck-status-btn')?.addEventListener('click', () => {
      // Deck status modal mirrors the Steam Store Deck Compatibility popup -
      // status badge + summary sentence + per-criterion checklist
      el.querySelector('#deck-status-tip')?.classList.toggle('open');
    });
    el.querySelectorAll('.source-summary-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        const targetId = tile.getAttribute('data-target');
        const target = targetId ? el.querySelector(`#${targetId}`) : null;
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    el.querySelector('#scoring-info-btn')?.addEventListener('click', async () => {
      const tip = el.querySelector('#rating-info-tip');
      tip?.classList.toggle('open');
      if (tip?.classList.contains('open')) await populateScoringTooltip(el);
    });
    el.querySelector('#fGpu')?.addEventListener('change', e => { filterGpu    = e.target.value; saveFiltersIfEnabled(); render(); });
    el.querySelector('#fOs')?.addEventListener('change',  e => { filterOs     = e.target.value; saveFiltersIfEnabled(); render(); });
    el.querySelector('#fRating')?.addEventListener('change', e => { filterRating = e.target.value; saveFiltersIfEnabled(); render(); });
    el.querySelector('#fSource')?.addEventListener('change', e => { filterSource = e.target.value; saveFiltersIfEnabled(); render(); });
    el.querySelector('#fDevice')?.addEventListener('change', e => { filterDevice = e.target.value; saveFiltersIfEnabled(); render(); });
    el.querySelector('#fPlaytime')?.addEventListener('change', e => { filterMinPlaytime = parseInt(e.target.value, 10) || 0; saveFiltersIfEnabled(); render(); });
    el.querySelector('#fPersist')?.addEventListener('change', e => {
      persistFilters = e.target.checked;
      try {
        localStorage.setItem(FILTER_PERSIST_KEY, persistFilters ? '1' : '0');
        if (persistFilters) saveFiltersIfEnabled();
        else localStorage.removeItem(FILTER_STORAGE_KEY);
      } catch { /* quota - ignore */ }
    });
    // Match both the legacy .cfg-dl-btn (Pulse config cards) and the new
    // unified .action-btn (report cards) so the JSON download click works
    // regardless of which renderer produced the button
    el.querySelectorAll('.cfg-dl-btn, .action-btn[data-report-json], .action-btn[data-cfg-json]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        // Cards embed their full payload in data-cfg-json or data-report-json.
        // Falling back to an index lookup broke after configs and reports were
        // merged into one list, so both kinds now carry the JSON inline
        if (b.dataset.cfgJson) downloadJson(JSON.parse(b.dataset.cfgJson), 'pulse-config');
        else if (b.dataset.reportJson) downloadJson(JSON.parse(b.dataset.reportJson), 'report');
      });
    });
    el.querySelectorAll('.vote-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const vote  = parseInt(btn.dataset.vote);
        const rKey  = btn.dataset.rkey;
        const aId   = btn.dataset.appid;
        const btns  = btn.closest('.vote-btns');
        castVote(aId, rKey, vote, btns.querySelector('.vote-up'), btns.querySelector('.vote-dn'));
      });
    });

    el.querySelectorAll('.delete-report-btn').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete your report for this game?')) return;
        const clientId = getWebClientId();
        const r = await fetch(`${SB_URL}/user_configs?client_id=eq.${clientId}&app_id=eq.${appId}`, {
          method: 'DELETE',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'x-client-id': clientId },
        });
        if (r.ok) { b.textContent = 'Deleted'; setTimeout(render, 1000); }
        else { b.textContent = 'Failed'; }
      });
    });

    // Delete plugin config (user_proton_configs) — shown when voter_id matches this device's client ID
    el.querySelectorAll('.delete-cfg-btn').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete your Proton config for this game?')) return;
        const voterId  = b.dataset.voterId;
        const cfgAppId = b.dataset.appId;
        const r = await fetch(
          `${SB_URL}/user_proton_configs?voter_id=eq.${voterId}&app_id=eq.${cfgAppId}`,
          { method: 'DELETE', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'x-client-id': voterId } }
        );
        console.log('[delete-cfg]', r.status, voterId, cfgAppId);
        if (r.ok) { b.textContent = 'Deleted'; setTimeout(render, 1000); }
        else { b.textContent = 'Failed'; }
      });
    });

    // async-enhance author blocks with stats + avatars after the DOM is ready
    void enhanceAuthorBlocks(reps.filter(r => r._kind !== 'config'));

    // fetch real Steam Deck compat + min requirements and patch the UI
    void (async () => {
      const [deckData, reqsData] = await Promise.all([
        fetchDeckStatusForApp(appId),
        fetchMinRequirements(appId),
      ]);
      // update deck status button icon + modal
      const deckBtn = el.querySelector('#deck-status-btn');
      if (deckBtn && deckData.status !== 'unknown') {
        const lbl = DECK_STATUS_LABELS[deckData.status] || 'Unknown';
        deckBtn.querySelector('svg').innerHTML = DECK_STATUS_ICON_SVG[deckData.status] || DECK_STATUS_ICON_SVG.unknown;
        deckBtn.title = `Steam Deck: ${lbl} (click for details)`;
      }
      const deckTip = el.querySelector('#deck-status-tip');
      if (deckTip) deckTip.innerHTML = `<div class="info-tooltip-inner">${renderDeckStatusModalContent(appId)}</div>`;

      // fill min requirements panel
      const reqsEl = el.querySelector('#min-reqs-content');
      if (reqsEl && reqsData) {
        reqsEl.innerHTML = `
          <h3 style="margin:0 0 8px;font-size:0.95rem;color:var(--strong)">Minimum System Requirements</h3>
          ${reqsData.minimum || '<p style="color:var(--muted)">No minimum requirements listed.</p>'}
          ${reqsData.recommended ? `<h3 style="margin:12px 0 8px;font-size:0.95rem;color:var(--strong)">Recommended</h3>${reqsData.recommended}` : ''}
        `;
      } else if (reqsEl) {
        reqsEl.innerHTML = '<p style="color:var(--muted);padding:8px 0">No system requirements available from Steam for this title.</p>';
      }
    })();
  }

  render();
}

// - Search --------------------------------------------

const searchInput   = document.getElementById('search');
const searchResults = document.getElementById('search-results');






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

// Sidebar toggle + auth chip wiring moved to topbar.js (shared across all pages).

