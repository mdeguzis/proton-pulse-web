import { escapeHtml } from '../utils.js?v=bd5a67c2';

let chartInstance = null;
let reportsChartInstance = null;

// Pipeline-emitted JSON files we want to expose freshness/cache stats for.
// Adding a new one here surfaces it in the Data Cache section automatically.
const DATA_FILES = [
  'search-index.json',
  'recent-reports.json',
  'most_played.json',
  'game-images.json',
  'nonsteam-images.json',
  'stats.json',
  'proton-versions.json',
];

function _formatAge(secs) {
  if (!Number.isFinite(secs)) return '?';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

function _formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function _probeDataFile(name) {
  // HEAD-equivalent fetch so the file body never lands in memory. Reads cache
  // and freshness headers from the response so the panel reflects the same
  // values the user's browser is honoring.
  const url = `https://www.proton-pulse.com/${name}`;
  try {
    const resp = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    const headers = resp.headers;
    const lastModRaw = headers.get('last-modified');
    const lastMod = lastModRaw ? new Date(lastModRaw) : null;
    const sizeRaw = headers.get('content-length');
    const cc = headers.get('cache-control') || '';
    const maxAgeMatch = cc.match(/max-age=(\d+)/);
    const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : null;
    const edge = headers.get('x-proxy-cache') || headers.get('x-cache') || headers.get('cf-cache-status') || '';
    return {
      name,
      ok: resp.ok,
      status: resp.status,
      lastMod,
      ageSecs: lastMod ? (Date.now() - lastMod.getTime()) / 1000 : null,
      maxAge,
      sizeBytes: sizeRaw ? parseInt(sizeRaw, 10) : null,
      edge,
    };
  } catch (e) {
    return { name, ok: false, error: e.message };
  }
}

async function loadDataCacheTable() {
  const target = document.getElementById('data-cache-table');
  if (!target) return;
  // Initial placeholder is already in the rendered HTML; we only overwrite
  // once the probes resolve so the synchronous initial render is stable.
  const rows = await Promise.all(DATA_FILES.map(_probeDataFile));
  target.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>File</th><th>Status</th><th>Last modified</th><th>Age</th>
        <th>Max-age</th><th>Stale?</th><th>Size</th><th>Edge cache</th>
      </tr></thead>
      <tbody>${rows.map(r => {
        if (!r.ok) {
          return `<tr><td>${escapeHtml(r.name)}</td><td colspan="7" style="color:var(--red,#ff5566)">${escapeHtml(r.error || ('HTTP ' + r.status))}</td></tr>`;
        }
        const stale = r.maxAge != null && r.ageSecs != null && r.ageSecs > r.maxAge;
        const staleCell = stale
          ? `<span style="color:var(--red,#ff5566)">yes (${_formatAge(r.ageSecs - r.maxAge)} past)</span>`
          : `<span style="color:#4caf80">no</span>`;
        const lm = r.lastMod ? r.lastMod.toLocaleString() : '?';
        return `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td>HTTP ${r.status}</td>
          <td style="font-size:0.78rem">${escapeHtml(lm)}</td>
          <td>${_formatAge(r.ageSecs)}</td>
          <td>${r.maxAge != null ? _formatAge(r.maxAge) : '?'}</td>
          <td>${staleCell}</td>
          <td>${_formatSize(r.sizeBytes)}</td>
          <td style="font-size:0.78rem">${escapeHtml(r.edge || '-')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <p class="admin-empty" style="margin-top:8px;font-size:0.78rem">Probed via HEAD against the production CDN. Edge cache value reflects the most recent fetch from your client.</p>
  `;
}

function renderImgRoutes() {
  // window.__imgRouteCounts is bumped by js/app/lib/steam-img.js on every
  // fallback hit. Counts are session-scoped and reset on full page load.
  const counts = window.__imgRouteCounts || {};
  const fallbackTotal = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
  if (!fallbackTotal) {
    return `<p class="admin-empty">No fallback routes hit yet this session. Primary akamai CDN handled every image.</p>`;
  }
  const routes = [
    { key: 'cloudflare',           label: 'Cloudflare CDN (hashed Steam)',  color: '#5c8bd6' },
    { key: 'game-images-json',     label: 'game-images.json (Steam override)', color: '#d4b36a' },
    { key: 'nonsteam-images-json', label: 'nonsteam-images.json (GOG/Epic)',   color: '#7a3fcf' },
    { key: 'hidden',               label: 'Hidden (all routes exhausted)',     color: '#ff5566' },
  ];
  return `<table class="admin-table">
    <thead><tr><th>Route</th><th>Hits</th><th>% of fallbacks</th></tr></thead>
    <tbody>${routes.map(r => {
      const n = Number(counts[r.key]) || 0;
      const pct = fallbackTotal ? Math.round((n / fallbackTotal) * 100) : 0;
      return `<tr>
        <td><span style="display:inline-block;width:8px;height:8px;background:${r.color};margin-right:8px;border-radius:50%"></span>${escapeHtml(r.label)}</td>
        <td>${n}</td>
        <td>${pct}%</td>
      </tr>`;
    }).join('')}
    <tr style="border-top:1px solid rgba(255,255,255,0.08);font-weight:600">
      <td>Total fallbacks</td><td>${fallbackTotal}</td><td>100%</td>
    </tr>
    </tbody>
  </table>
  <p class="admin-empty" style="margin-top:8px;font-size:0.78rem">Primary akamai CDN successes are not counted (no fallback fires on success). A low fallback total means most images load on the first try.</p>`;
}

function wireJumpNav(root, sections) {
  root.querySelectorAll('.analytics-jump-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = root.querySelector(`#${btn.dataset.target}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function destroyChart() {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  if (reportsChartInstance) {
    reportsChartInstance.destroy();
    reportsChartInstance = null;
  }
}

function renderDayButtons(daysBack, onChangeDays) {
  return [7, 30, 90].map(d => {
    const active = d === daysBack ? ' admin-sort-btn--active' : '';
    return `<button class="admin-sort-btn${active}" data-days="${d}">${d}d</button>`;
  }).join('');
}

function renderStatRows(totals) {
  const stats = [
    { label: 'Total events',     value: totals.total_events      ?? 0 },
    { label: 'Sessions',         value: totals.total_sessions    ?? 0 },
    { label: 'Unique users',     value: totals.authed_users      ?? 0 },
    { label: 'New users',        value: totals.new_users         ?? 0 },
    { label: 'Logins',           value: totals.auth_success      ?? 0 },
    { label: 'Login failures',   value: totals.auth_failure      ?? 0 },
    { label: 'Reports submitted',value: totals.reports_submitted ?? 0 },
  ];
  return `<table class="admin-table analytics-stat-rows">
    <tbody>${stats.map(s =>
      `<tr>
        <td style="color:var(--text-muted,#888);font-size:0.82rem;padding:6px 10px">${escapeHtml(s.label)}</td>
        <td style="font-weight:600;text-align:right;padding:6px 10px">${escapeHtml(String(s.value))}</td>
      </tr>`
    ).join('')}</tbody>
  </table>`;
}

function renderPagesTable(rows) {
  if (!rows || !rows.length) return `<p class="admin-empty">No data yet.</p>`;
  return `<table class="admin-table">
    <thead><tr><th>Page</th><th>Views</th></tr></thead>
    <tbody>${rows.map(r =>
      `<tr><td>${escapeHtml(r.page || '(unknown)')}</td><td>${escapeHtml(String(r.views))}</td></tr>`
    ).join('')}</tbody>
  </table>`;
}

function renderGamesTable(rows) {
  if (!rows || !rows.length) return `<p class="admin-empty">No game views tracked yet.</p>`;
  return `<table class="admin-table">
    <thead><tr><th>Game</th><th>Views</th></tr></thead>
    <tbody>${rows.map(r => {
      const title = escapeHtml(r.title || r.app_id || '(unknown)');
      const link  = r.app_id
        ? `<a class="admin-link" href="/app.html#/app/${escapeHtml(String(r.app_id))}" target="_blank">${title}</a>`
        : title;
      return `<tr><td>${link}</td><td>${escapeHtml(String(r.views))}</td></tr>`;
    }).join('')}</tbody>
  </table>`;
}

function renderEventTypesTable(rows) {
  if (!rows || !rows.length) return `<p class="admin-empty">No data yet.</p>`;
  return `<table class="admin-table">
    <thead><tr><th>Event type</th><th>Total</th></tr></thead>
    <tbody>${rows.map(r =>
      `<tr><td><code style="font-size:0.78rem">${escapeHtml(r.event_type)}</code></td><td>${escapeHtml(String(r.total))}</td></tr>`
    ).join('')}</tbody>
  </table>`;
}

function renderSwCache(sw) {
  if (!sw || !sw.sessions) {
    return `<p class="admin-empty">No service worker cache data yet.</p>`;
  }
  const rows = [
    { label: 'Image cache hit rate', value: `${sw.hit_rate}%` },
    { label: 'Images served from cache', value: sw.served },
    { label: 'Cache misses', value: sw.misses },
    { label: 'Sessions reporting', value: sw.sessions },
  ];
  return `<table class="admin-table analytics-stat-rows">
    <tbody>${rows.map(s =>
      `<tr>
        <td style="color:var(--text-muted,#888);font-size:0.82rem;padding:6px 10px">${escapeHtml(s.label)}</td>
        <td style="font-weight:600;text-align:right;padding:6px 10px">${escapeHtml(String(s.value))}</td>
      </tr>`
    ).join('')}</tbody>
  </table>`;
}

export function renderAnalytics(data, { daysBack, onChangeDays }) {
  const content = document.getElementById('analytics-content');

  // Anchor ids drive the sticky jump-nav at the top. Adding a new section
  // means adding a row to NAV_SECTIONS so it gets a button.
  const NAV_SECTIONS = [
    { id: 'sec-daily',      label: 'Activity' },
    { id: 'sec-reports',    label: 'Reports' },
    { id: 'sec-pages',      label: 'Pages' },
    { id: 'sec-games',      label: 'Games' },
    { id: 'sec-summary',    label: 'Summary' },
    { id: 'sec-sw-cache',   label: 'SW Cache' },
    { id: 'sec-data-cache', label: 'Data Cache' },
    { id: 'sec-img-routes', label: 'Image Routes' },
  ];
  const navHtml = `<div class="analytics-jump-nav" id="analytics-jump-nav">${
    NAV_SECTIONS.map(s =>
      `<button type="button" class="analytics-jump-btn" data-target="${s.id}">${escapeHtml(s.label)}</button>`
    ).join('')
  }</div>`;

  content.innerHTML = `
    ${navHtml}
    <div class="admin-sort-row" style="margin-bottom:16px">
      <span class="admin-sort-label">Range:</span>
      ${renderDayButtons(daysBack, onChangeDays)}
    </div>
    <div id="sec-daily" style="margin-bottom:6px">
      <span class="analytics-section-title">Daily activity</span>
      <span style="float:right;font-size:0.75rem;color:var(--text-muted,#888)">
        <span style="color:#5c8bd6">&#9644;</span> Sessions &nbsp;
        <span style="color:#4caf80">&#9644;</span> Unique users
      </span>
    </div>
    <div class="analytics-chart-wrap">
      <canvas id="analytics-daily-chart"></canvas>
    </div>
    <div id="sec-reports" style="margin-top:24px;margin-bottom:6px">
      <span class="analytics-section-title">Report submissions</span>
      <span style="float:right;font-size:0.75rem;color:var(--text-muted,#888)">
        <span style="color:#d4b36a">&#9644;</span> Reports
      </span>
    </div>
    <div class="analytics-chart-wrap">
      <canvas id="analytics-reports-chart"></canvas>
    </div>
    <div id="sec-pages" class="analytics-two-col" style="margin-top:20px">
      <div>
        <div class="analytics-section-title">Top pages</div>
        ${renderPagesTable(data.top_pages)}
      </div>
      <div>
        <div class="analytics-section-title">Event breakdown</div>
        ${renderEventTypesTable(data.event_types)}
      </div>
    </div>
    <div id="sec-games" style="margin-top:20px">
      <div class="analytics-section-title">Top games viewed</div>
      ${renderGamesTable(data.top_games)}
    </div>
    <div id="sec-summary" style="margin-top:20px">
      <div class="analytics-section-title">Summary</div>
      ${renderStatRows(data.totals || {})}
    </div>
    <div id="sec-sw-cache" style="margin-top:20px">
      <div class="analytics-section-title">Image cache (service worker)</div>
      ${renderSwCache(data.sw_cache)}
    </div>
    <div id="sec-data-cache" style="margin-top:20px">
      <div class="analytics-section-title">Pipeline data cache <button type="button" class="admin-sort-btn" id="data-cache-refresh" style="margin-left:10px;font-size:0.72rem">Refresh</button></div>
      <div id="data-cache-table"><p class="admin-empty">Probing data files...</p></div>
    </div>
    <div id="sec-img-routes" style="margin-top:20px">
      <div class="analytics-section-title">Image route hits (this session)</div>
      ${renderImgRoutes()}
    </div>
  `;

  wireJumpNav(content, NAV_SECTIONS);
  loadDataCacheTable();
  content.querySelector('#data-cache-refresh')?.addEventListener('click', loadDataCacheTable);

  content.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener('click', () => onChangeDays(Number(btn.dataset.days)));
  });

  destroyChart();

  const daily = data.daily || [];
  if (daily.length && typeof Chart !== 'undefined') {
    const canvas = document.getElementById('analytics-daily-chart');
    if (canvas) {
      chartInstance = new Chart(canvas, {
        type: 'line',
        data: {
          labels: daily.map(r => r.day),
          datasets: [
            {
              label: 'Sessions',
              data: daily.map(r => r.sessions),
              borderColor: '#5c8bd6',
              backgroundColor: 'rgba(92,139,214,0.12)',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
            },
            {
              label: 'Unique users',
              data: daily.map(r => r.unique_users ?? 0),
              borderColor: '#4caf80',
              backgroundColor: 'rgba(76,175,128,0.08)',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: items => items[0].label,
              },
            },
          },
          scales: {
            x: { ticks: { color: '#888', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
          },
        },
      });
    }
  }

  const reportsByDay = data.reports_by_day || [];
  if (reportsByDay.length && typeof Chart !== 'undefined') {
    const canvas = document.getElementById('analytics-reports-chart');
    if (canvas) {
      reportsChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: reportsByDay.map(r => r.day),
          datasets: [{
            label: 'Reports',
            data: reportsByDay.map(r => r.count),
            backgroundColor: 'rgba(212,179,106,0.5)',
            borderColor: '#d4b36a',
            borderWidth: 1,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#888', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: '#888', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
          },
        },
      });
    }
  }
}
