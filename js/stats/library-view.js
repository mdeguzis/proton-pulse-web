// library-view.js -- signed-in "My Library" tab for stats.html (#209).
//
// The tab is deliberately compact: one card with a headline stat, a small
// Chart.js horizontal bar of the top optimization patterns across owned
// games, and a table of a few owned games with their most-recommended
// pattern. No filters, no walls of charts. Keep it focused.
//
// Auth: uses window.SupaAuth.getSession() to decide whether to render or
// prompt to sign in. If not signed in we show a short call-to-action.

import { OPTIMIZATION_PATTERNS } from '../shared/analytics-patterns.js?v=c119f011';
import { aggregateLibraryPatterns } from '../shared/library-correlations.js?v=b7a81edf';
import { renderPurposeChart } from '../shared/purpose-charts.js?v=d383b3bd';

const REPORT_FETCH_CHUNK = 100;   // Steam libraries can be hundreds of games
const MAX_REPORTS         = 500;  // per fetch, we don't need every row

function _esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function _authHeaders(session) {
  const url = window.SUPABASE_URL;
  const key = window.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / anon key not set');
  const h = { apikey: key, Accept: 'application/json' };
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  return { url, headers: h };
}

async function _fetchOwnedAppIds(session) {
  const { url, headers } = _authHeaders(session);
  const resp = await fetch(`${url}/rest/v1/user_steam_library?select=appids&limit=1`, { headers });
  if (!resp.ok) return [];
  const rows = await resp.json();
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  return Array.isArray(row?.appids) ? row.appids.map(String) : [];
}

async function _fetchOwnHardwareBucket(session) {
  // Prefer the user's own most recent submitted report's gpu_architecture;
  // if they have none, fall back to null and we'll just skip the bucket
  // filter (using every hardware).
  const { url, headers } = _authHeaders(session);
  const q = 'select=gpu_architecture&gpu_architecture=not.is.null&order=created_at.desc&limit=1';
  const resp = await fetch(`${url}/rest/v1/user_configs?${q}`, { headers });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows?.[0]?.gpu_architecture || null;
}

async function _fetchReportsForAppIds(session, appIds, hardwareBucket) {
  const { url, headers } = _authHeaders(session);
  const collected = [];
  for (let i = 0; i < appIds.length; i += REPORT_FETCH_CHUNK) {
    if (collected.length >= MAX_REPORTS) break;
    const chunk = appIds.slice(i, i + REPORT_FETCH_CHUNK);
    const params = new URLSearchParams();
    params.set('select', 'app_id,notes,launch_options,form_responses,rating,gpu_architecture');
    params.append('app_id', `in.(${chunk.join(',')})`);
    if (hardwareBucket) params.append('gpu_architecture', `eq.${hardwareBucket}`);
    params.set('limit', String(MAX_REPORTS - collected.length));
    const resp = await fetch(`${url}/rest/v1/user_configs?${params.toString()}`, { headers });
    if (!resp.ok) continue;
    const rows = await resp.json();
    if (Array.isArray(rows)) collected.push(...rows);
  }
  return collected;
}

function _renderEmpty(host, msg, sub) {
  host.innerHTML = `
    <div class="chart-card">
      <h3>For your library</h3>
      <p class="fg-card-hint">${_esc(msg)}</p>
      ${sub ? `<p class="fg-card-hint" style="margin-top:6px">${_esc(sub)}</p>` : ''}
    </div>`;
}

function _renderSignedOut(host) {
  host.innerHTML = `
    <div class="chart-card">
      <h3>For your library</h3>
      <p class="fg-card-hint">
        Sign in and sync your Steam library on the
        <a href="profile.html">profile page</a> to see which optimizations
        the community recommends for the games <em>you</em> own on hardware
        like yours.
      </p>
    </div>`;
}

let _libraryChart = null;

/**
 * Render the My Library tab into the given host element.
 * Idempotent on repeated calls (destroys the previous chart).
 */
export async function renderLibraryTab(host) {
  if (!host) return;
  const SupaAuth = (typeof window !== 'undefined') ? window.SupaAuth : null;
  const session = SupaAuth && typeof SupaAuth.getSession === 'function'
    ? await SupaAuth.getSession() : null;
  if (!session?.user) { _renderSignedOut(host); return; }

  host.innerHTML = `
    <div class="chart-card">
      <h3>For your library</h3>
      <p class="fg-card-hint">Loading your library and matching reports...</p>
    </div>`;

  let owned = [];
  let hardware = null;
  try {
    [owned, hardware] = await Promise.all([
      _fetchOwnedAppIds(session),
      _fetchOwnHardwareBucket(session),
    ]);
  } catch (e) {
    _renderEmpty(host, 'Could not load your library.', String(e?.message || e));
    return;
  }
  if (owned.length === 0) {
    _renderEmpty(host,
      'Your Steam library has not been synced yet.',
      'Head to the profile page and click "Sync Steam library".');
    return;
  }

  const reports = await _fetchReportsForAppIds(session, owned, hardware);
  if (reports.length === 0) {
    _renderEmpty(host,
      hardware
        ? `No community reports on similar hardware (${hardware}) for games in your library yet.`
        : 'No community reports for games in your library yet.');
    return;
  }

  const agg = aggregateLibraryPatterns(reports, owned, OPTIMIZATION_PATTERNS);
  if (agg.perPattern.length === 0) {
    _renderEmpty(host,
      'No specific optimizations flagged across your library yet.',
      'Reports on your owned games don\'t mention gamemode, mangohud, dxvk-async, or similar patterns.');
    return;
  }

  const topPatterns = agg.perPattern.slice(0, 5);
  const topGames    = agg.perGame.slice(0, 8);
  const hwLabel = hardware ? _esc(hardware) : 'all hardware';

  host.innerHTML = `
    <div class="chart-card">
      <h3>For your library on ${hwLabel}</h3>
      <p class="fg-card-hint">
        Scanned <strong>${agg.totalReports}</strong> community reports across
        <strong>${agg.totalGames}</strong> games you own. Top optimizations
        people mention:
      </p>
      <div class="purpose-chart-wrap">
        <canvas id="library-patterns-chart"></canvas>
      </div>
      <table class="library-recs">
        <thead>
          <tr><th>App ID</th><th>Reports</th><th>Top optimization</th></tr>
        </thead>
        <tbody>
          ${topGames.map(g => `
            <tr>
              <td><a href="app.html#/app/${_esc(g.appId)}">${_esc(g.appId)}</a></td>
              <td>${g.reportCount}</td>
              <td>${_esc(topPatterns.find(p => p.key === g.topPattern)?.label || g.topPattern)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;

  const canvas = host.querySelector('#library-patterns-chart');
  if (_libraryChart) { _libraryChart.destroy(); _libraryChart = null; }
  _libraryChart = renderPurposeChart(canvas, {
    purpose: 'distribution',
    data: {
      labels: topPatterns.map(p => p.label),
      values: topPatterns.map(p => p.gameCount),
    },
    options: { title: 'games in library' },
  });
}
