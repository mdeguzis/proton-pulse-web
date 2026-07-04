import { escapeHtml } from '../utils.js?v=2668b2f0';

let chartInstance = null;
let reportsChartInstance = null;
let imgRoutesChartInstance = null;
let dataCacheChartInstance = null;

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

// Format a YYYY-MM-DD label as e.g. "Mon Jul 1, 2026" for chart tooltips.
// Falls back to the raw label if it doesn't parse (Chart.js sometimes passes
// numeric indices during transitions).
function _formatTooltipDate(label) {
  if (!label || typeof label !== 'string') return String(label || '');
  const m = label.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return label;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime())) return label;
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function _formatAge(secs) {
  if (!Number.isFinite(secs)) return '?';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

// Chart.js plugin: draws a 1px vertical crosshair at the hovered x position.
// Chart.js gives us index-mode tooltips out of the box but does not draw a
// visible guideline, so hovering feels imprecise. Register this per chart
// via the `plugins: [_verticalHoverLine]` array in the Chart config.
const _verticalHoverLine = {
  id: 'verticalHoverLine',
  afterDraw(chart) {
    const active = chart.tooltip?._active;
    if (!active || !active.length) return;
    const x = active[0].element.x;
    const top = chart.chartArea.top;
    const bottom = chart.chartArea.bottom;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  },
};

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

function _renderDataCacheChart(rows) {
  const canvas = document.getElementById('data-cache-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (dataCacheChartInstance) { dataCacheChartInstance.destroy(); dataCacheChartInstance = null; }
  // Bars are "age as % of max-age". Pipeline data files routinely sit far
  // past their 10min Cache-Control header (search-index updates every few
  // hours, max-age is for CDN edge churn). Visualizing 1200% would just
  // produce a single dominant bar, so we clamp display at 200% (= 2x stale)
  // and surface the true value in the tooltip. The 100% mark is implicit
  // as "anything red is stale". Files without max-age render at 0 in grey.
  const labels = rows.map(r => r.name);
  const truePcts = rows.map(r => {
    if (!r.ok || r.ageSecs == null || !r.maxAge) return 0;
    return Math.round((r.ageSecs / r.maxAge) * 100);
  });
  const DISPLAY_CAP = 200;
  const displayPcts = truePcts.map(p => Math.min(p, DISPLAY_CAP));
  const colors = truePcts.map(p => p === 0 ? 'rgba(120,120,120,0.5)' : p > 100 ? '#ff5566' : p > 50 ? '#d4b36a' : '#4caf80');
  dataCacheChartInstance = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Age vs max-age', data: displayPcts, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${truePcts[ctx.dataIndex]}% of TTL elapsed (max-age ${_formatAge(rows[ctx.dataIndex].maxAge)})` } },
      },
      scales: {
        x: {
          min: 0, max: DISPLAY_CAP,
          ticks: { color: '#888', callback: v => v + '%' },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: { ticks: { color: '#888', font: { size: 11 } }, grid: { display: false } },
      },
    },
  });
}

// Image load timings from the browser's performance entry buffer.
// Groups all image transfers from the steam header CDNs (akamai, cloudflare,
// game-images.json hashed URLs, nonsteam covers) by route and reports cache
// hit rate (transferSize === 0) plus median + p95 duration in ms. This is the
// "where do images lag" view -- the per-page-life resource buffer is the
// authoritative source for what the browser actually fetched.
function readImageLoadStats() {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return [];
  const routes = [
    { key: 'akamai',     label: 'akamai (primary)',  match: /shared\.akamai\.steamstatic\.com/ },
    { key: 'cloudflare', label: 'cloudflare CDN',    match: /(shared|cdn)\.cloudflare\.steamstatic\.com/ },
    { key: 'gameImages', label: 'game-images hashed', match: /steamcdn-a\.akamaihd\.net|akamaihd\.net|cloudflare\.steamstatic\.com\/.+_hash/ },
    { key: 'nonsteam',   label: 'nonsteam covers',    match: /gog-statics|images\.gog|epicgames\.com\/.+\.jpg|epicgames\.com\/.+\.png/ },
  ];
  const entries = performance.getEntriesByType('resource').filter(e =>
    e.initiatorType === 'img' || /\.(jpg|jpeg|png|webp)(\?|$)/i.test(e.name)
  );
  const out = [];
  for (const r of routes) {
    const matches = entries.filter(e => r.match.test(e.name));
    if (!matches.length) {
      out.push({ ...r, count: 0, cacheHits: 0, cacheHitRate: 0, medianMs: 0, p95Ms: 0 });
      continue;
    }
    const durations = matches.map(e => Math.round(e.duration)).sort((a, b) => a - b);
    const cacheHits = matches.filter(e => e.transferSize === 0).length;
    const median = durations[Math.floor(durations.length / 2)] || 0;
    const p95 = durations[Math.floor(durations.length * 0.95)] || durations[durations.length - 1] || 0;
    out.push({
      ...r,
      count: matches.length,
      cacheHits,
      cacheHitRate: Math.round((cacheHits / matches.length) * 100),
      medianMs: median,
      p95Ms: p95,
    });
  }
  return out;
}

function renderImageLoadStats() {
  const stats = readImageLoadStats();
  const total = stats.reduce((s, r) => s + r.count, 0);
  if (!total) {
    return `<p class="admin-empty">No image transfers observed yet this session. Visit a few game pages to populate the buffer.</p>`;
  }
  return `<table class="admin-table">
    <thead><tr><th>Route</th><th>Loads</th><th>Cache hits</th><th>Hit %</th><th>Median</th><th>p95</th></tr></thead>
    <tbody>${stats.map(r => {
      if (!r.count) {
        return `<tr><td>${escapeHtml(r.label)}</td><td colspan="5" style="color:var(--muted)">(no loads)</td></tr>`;
      }
      const p95Color = r.p95Ms > 800 ? '#ff5566' : r.p95Ms > 300 ? '#d4b36a' : '#4caf80';
      return `<tr>
        <td>${escapeHtml(r.label)}</td>
        <td>${r.count}</td>
        <td>${r.cacheHits}</td>
        <td>${r.cacheHitRate}%</td>
        <td>${r.medianMs} ms</td>
        <td style="color:${p95Color}">${r.p95Ms} ms</td>
      </tr>`;
    }).join('')}</tbody>
  </table>
  <p class="admin-empty" style="margin-top:8px;font-size:0.78rem">Cache hit = browser served from disk (transferSize 0). p95 > 800ms is flagged red. Buffer is per-tab session; admin page itself does not load game thumbnails, so visit /app/... pages first.</p>`;
}

function renderImgRoutesChart() {
  const canvas = document.getElementById('img-routes-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (imgRoutesChartInstance) { imgRoutesChartInstance.destroy(); imgRoutesChartInstance = null; }
  const counts = window.__imgRouteCounts || {};
  const routes = [
    { key: 'cloudflare',           label: 'Cloudflare',  color: '#5c8bd6' },
    { key: 'game-images-json',     label: 'game-images', color: '#d4b36a' },
    { key: 'nonsteam-images-json', label: 'nonsteam',    color: '#7a3fcf' },
    { key: 'hidden',               label: 'hidden',      color: '#ff5566' },
  ];
  const data = routes.map(r => Number(counts[r.key]) || 0);
  imgRoutesChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: routes.map(r => r.label),
      datasets: [{ label: 'Hits', data, backgroundColor: routes.map(r => r.color), borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#888' }, grid: { display: false } },
        y: { ticks: { color: '#888', stepSize: 1, precision: 0 }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
      },
    },
  });
}

async function loadDataCacheTable() {
  const target = document.getElementById('data-cache-table');
  if (!target) return;
  // Initial placeholder is already in the rendered HTML; we only overwrite
  // once the probes resolve so the synchronous initial render is stable.
  const rows = await Promise.all(DATA_FILES.map(_probeDataFile));
  _renderDataCacheChart(rows);
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
  if (imgRoutesChartInstance) {
    imgRoutesChartInstance.destroy();
    imgRoutesChartInstance = null;
  }
  if (dataCacheChartInstance) {
    dataCacheChartInstance.destroy();
    dataCacheChartInstance = null;
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
    { id: 'sec-img-timings', label: 'Image Timings' },
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
      <span class="analytics-legend">
        <span class="analytics-legend-item"><span class="analytics-legend-swatch" style="background:#5c8bd6"></span>Sessions</span>
        <span class="analytics-legend-item"><span class="analytics-legend-swatch" style="background:#4caf80"></span>Unique users</span>
      </span>
    </div>
    <div class="analytics-chart-wrap">
      <canvas id="analytics-daily-chart"></canvas>
    </div>
    <p class="chart-caption">Sessions and distinct authenticated users per day across the selected range.</p>
    <div id="sec-reports" style="margin-top:24px;margin-bottom:6px">
      <span class="analytics-section-title">Report submissions</span>
      <span class="analytics-legend">
        <span class="analytics-legend-item"><span class="analytics-legend-swatch" style="background:#5c8bd6"></span>Web</span>
        <span class="analytics-legend-item"><span class="analytics-legend-swatch" style="background:#4caf80"></span>Plugin</span>
        <span class="analytics-legend-item"><span class="analytics-legend-swatch" style="background:#d4b36a"></span>Other</span>
      </span>
    </div>
    <div class="analytics-chart-wrap">
      <canvas id="analytics-reports-chart"></canvas>
    </div>
    <p class="chart-caption">Pulse Reports landed per day, stacked by source. Web = browser submissions, Plugin = Steam Deck plugin, Other = anything that does not match those prefixes.</p>
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
      <div class="analytics-chart-wrap" style="height:200px"><canvas id="data-cache-chart"></canvas></div>
      <p class="chart-caption">Each bar is one pipeline JSON file. Length is age divided by Cache-Control max-age. Green &lt;50%, yellow 50&ndash;100%, red &gt;100% (past TTL). Bars clamp at 200% so a single very-stale file does not squash the rest; hover for the true number.</p>
      <div id="data-cache-table"><p class="admin-empty">Probing data files...</p></div>
    </div>
    <div id="sec-img-routes" style="margin-top:20px">
      <div class="analytics-section-title">Image route hits (this session)</div>
      <div class="analytics-chart-wrap" style="height:200px"><canvas id="img-routes-chart"></canvas></div>
      <p class="chart-caption">Counts of fallback hits since you opened this tab. The primary akamai CDN is not counted (no fallback fires on success), so a low total means most images loaded on the first try.</p>
      ${renderImgRoutes()}
    </div>
    <div id="sec-img-timings" style="margin-top:20px">
      <div class="analytics-section-title">Image load timings <button type="button" class="admin-sort-btn" id="img-timings-refresh" style="margin-left:10px;font-size:0.72rem">Refresh</button></div>
      <div id="img-timings-table">${renderImageLoadStats()}</div>
    </div>
  `;

  wireJumpNav(content, NAV_SECTIONS);
  loadDataCacheTable();
  renderImgRoutesChart();
  content.querySelector('#data-cache-refresh')?.addEventListener('click', loadDataCacheTable);
  content.querySelector('#img-timings-refresh')?.addEventListener('click', () => {
    const t = document.getElementById('img-timings-table');
    if (t) t.innerHTML = renderImageLoadStats();
  });

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
        plugins: [_verticalHoverLine],
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
              cubicInterpolationMode: 'monotone',
              pointRadius: 3,
            },
            {
              label: 'Unique users',
              data: daily.map(r => r.unique_users ?? 0),
              borderColor: '#4caf80',
              backgroundColor: 'rgba(76,175,128,0.08)',
              fill: true,
              tension: 0.3,
              cubicInterpolationMode: 'monotone',
              pointRadius: 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: 'rgba(20,24,32,0.95)',
              borderColor: 'rgba(255,255,255,0.15)',
              borderWidth: 1,
              padding: 10,
              titleFont: { weight: '600' },
              callbacks: {
                title: items => _formatTooltipDate(items[0].label),
                label: ctx => `${ctx.dataset.label}: ${Number(ctx.parsed.y || 0).toLocaleString()}`,
                // Chart.js defaults the swatch fill to dataset.backgroundColor.
                // Our fill is nearly transparent (used for the area under the
                // line), so the swatch on the dark tooltip bg reads as white.
                // Force it to the solid borderColor so the swatch matches the
                // line color the user sees on the chart.
                labelColor: ctx => ({
                  borderColor: ctx.dataset.borderColor,
                  backgroundColor: ctx.dataset.borderColor,
                }),
              },
            },
          },
          scales: {
            x: { ticks: { color: '#888', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
            // grace: 1 pads the axis max by a single unit so the tallest
            // point doesn't sit flush against the chart ceiling.
            y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true, grace: 1 },
          },
        },
      });
    }
  }

  const reportsByDay = data.reports_by_day || [];
  if (reportsByDay.length && typeof Chart !== 'undefined') {
    const canvas = document.getElementById('analytics-reports-chart');
    if (canvas) {
      // #76: stacked bars per source. Older entries that pre-date the source
      // breakdown still have a .count fallback handled in the data fetcher,
      // but defensively default each series to 0 here too.
      reportsChartInstance = new Chart(canvas, {
        type: 'line',
        plugins: [_verticalHoverLine],
        data: {
          labels: reportsByDay.map(r => r.day),
          datasets: [
            {
              label: 'Web',
              data: reportsByDay.map(r => r.web ?? 0),
              backgroundColor: 'rgba(92,139,214,0.35)',
              borderColor: '#5c8bd6',
              borderWidth: 1.5,
              pointRadius: 2,
              tension: 0.3,
              cubicInterpolationMode: 'monotone',
              fill: true,
              stack: 'reports',
            },
            {
              label: 'Plugin',
              data: reportsByDay.map(r => r.plugin ?? 0),
              backgroundColor: 'rgba(76,175,128,0.35)',
              borderColor: '#4caf80',
              borderWidth: 1.5,
              pointRadius: 2,
              tension: 0.3,
              cubicInterpolationMode: 'monotone',
              fill: true,
              stack: 'reports',
            },
            {
              label: 'Other',
              data: reportsByDay.map(r => r.other ?? 0),
              backgroundColor: 'rgba(212,179,106,0.35)',
              borderColor: '#d4b36a',
              borderWidth: 1.5,
              pointRadius: 2,
              tension: 0.3,
              cubicInterpolationMode: 'monotone',
              fill: true,
              stack: 'reports',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: 'rgba(20,24,32,0.95)',
              borderColor: 'rgba(255,255,255,0.15)',
              borderWidth: 1,
              padding: 10,
              titleFont: { weight: '600' },
              callbacks: {
                title: items => _formatTooltipDate(items[0].label),
                label: ctx => `${ctx.dataset.label}: ${Number(ctx.parsed.y || 0).toLocaleString()}`,
                // Solid borderColor swatches so Web / Plugin / Other in
                // the tooltip match the actual line colors (default
                // backgroundColor is a faint fill that reads as white).
                labelColor: ctx => ({
                  borderColor: ctx.dataset.borderColor,
                  backgroundColor: ctx.dataset.borderColor,
                }),
                footer: items => {
                  const total = items.reduce((s, it) => s + Number(it.parsed.y || 0), 0);
                  return `Total: ${total.toLocaleString()}`;
                },
              },
            },
          },
          scales: {
            x: {
              ticks: { color: '#888', maxTicksLimit: 10 },
              grid: { color: 'rgba(255,255,255,0.05)' },
              stacked: true,
            },
            y: {
              ticks: { color: '#888', stepSize: 1 },
              grid: { color: 'rgba(255,255,255,0.05)' },
              beginAtZero: true,
              stacked: true,
              // +1 above the tallest stack keeps a clean gap without
              // dwarfing days that have few reports.
              grace: 1,
            },
          },
        },
      });
    }
  }
}
