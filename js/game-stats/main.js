// Entry module for game-stats.html. Migrated from game-stats.js.
import { computeGameStats } from '../lib/scoring/gameStats.js?v=6a63af50';
import { pulseTierFromReports } from '../shared/scoring.js?v=852c9d97';
import { mergeReportsById } from '../app/utils.js?v=4630c3d5';
import { isPreviewHardware, loadMyHardware, renderPreviewHardwareBanner, enhanceHardwareBanner } from '../shared/hardware.js?v=f7bfd747';
import { attachChartHover, attachClickToFilter, dispatchFilter, onFilterChange } from '../shared/chart-interactions.js?v=6b608095';
import { loadSteamImg as _loadSteamImg } from '../app/lib/steam-img.js?v=5adc7e54';
import { appIdToDir } from '../lib/app-id.js?v=6159afa9';
import { dataUrl } from '../lib/data-url.js?v=0de73aed';
import { getGamesByIds } from '../app/api/search-games.js?v=0e14d3ff';
import { detectGpuArch } from '../lib/gpu-arch-detector.js?v=b4fbb7ef';

// Per-game stats page (game-stats.html). Reads ?app=APPID from the URL,
// pulls the same CDN data the main app page uses, then renders a thoughtful
// breakdown via computeGameStats() from js/lib/scoring/gameStats.js.
//
// Same CDN base resolution as confidence.html so localhost dev preview works.

(function () {
  const root = document.getElementById('gs-root');
  const metaEl = document.getElementById('gs-meta');

  function esc(s) {
    // Full HTML entity escape INCLUDING quotes -- values land in attribute
    // contexts (href="...", data-tier="...") where an unescaped quote breaks
    // out of the attribute (CodeQL js/incomplete-html-attribute-sanitization).
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // --- CDN loaders ---

  async function loadGame(appId) {
    // Route through dataUrl() so per-env data host (R2) is honored. Direct
    // origin fetches only worked on GH Pages paths and returned empty on
    // staging.proton-pulse.com because data/ is not same-origin there.
    try {
      const r = await fetch(await dataUrl(`data/${appIdToDir(appId)}/latest.json`));
      if (!r.ok) return [];
      return await r.json();
    } catch { return []; }
  }

  // #410: title-matched FlightlessSomething benchmarks for this app. The
  // pipeline map keys benchmarks by app id; empty object when the file has
  // not been generated yet or the app has no matches.
  async function loadFlightlessEntry(appId) {
    try {
      const r = await fetch(await dataUrl('flightless-benchmarks.json'));
      if (!r.ok) return null;
      const map = await r.json();
      const entry = map?.[String(appId)] || null;
      console.debug('[game-stats] flightless lookup', { appId, found: !!entry, count: entry?.count || 0 });
      return entry;
    } catch { return null; }
  }

  // Mirror of the pipeline's search_url_for_title (flightless_benchmarks.py):
  // lowercase, alnum runs joined by +, so the empty-state link lands on the
  // exact search a matched game would have used.
  function flightlessSearchUrl(title) {
    const norm = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return `https://flightlesssomething.ambrosia.one/?search=${norm.split(' ').filter(Boolean).join('+')}`;
  }

  // Unverified-runtime FPS section: community benchmarks title-matched from
  // FlightlessSomething. Always renders BELOW the confirmed (Pulse-report)
  // FPS section, behind an explicit disclaimer -- these runs never say
  // whether Proton was in play, so they are context, not stats. Renders an
  // empty state (nothing found + the formatted search link) when no
  // benchmark matched, so users know we looked and where to look themselves.
  function renderFlightlessSection(entry, title) {
    if (!entry || !Array.isArray(entry.benchmarks) || !entry.benchmarks.length) {
      const url = flightlessSearchUrl(title);
      return `
      <section id="flightless-benchmarks">
        <div class="gs-section-head"><span>Community benchmarks (unverified runtime)</span></div>
        <div class="fl-banner">
          No community benchmarks found on
          <a href="https://flightlesssomething.ambrosia.one/" target="_blank" rel="noopener">FlightlessSomething</a>
          for this title. You can
          <a href="${esc(url)}" target="_blank" rel="noopener">search for it yourself -&gt;</a>
          or upload your own MangoHud capture there.
        </div>
      </section>`;
    }
    const searchUrl = String(entry.search_url || '').startsWith('https://flightlesssomething.ambrosia.one/')
      ? String(entry.search_url) : 'https://flightlesssomething.ambrosia.one/';
    const rows = entry.benchmarks.slice(0, 10).map(b => {
      const url = String(b.url || '').startsWith('https://flightlesssomething.ambrosia.one/') ? String(b.url) : searchUrl;
      const bid = Number(b.id) || 0;
      return `
        <tr>
          <td><a href="${esc(url)}" target="_blank" rel="noopener">${esc(String(b.title || 'Benchmark'))}</a></td>
          <td data-v="${Number(b.run_count) || 1}">${Number(b.run_count) || 1}</td>
          <td>${esc(String(b.specs || '').slice(0, 90))}</td>
          <td>${esc(String(b.created_at || '').slice(0, 10))}</td>
          <td>${bid ? `<button type="button" class="fl-expand-btn" data-fl-bench="${bid}">Show data &amp; graphs</button>` : ''}</td>
        </tr>
        ${bid ? `<tr class="fl-detail-row" data-fl-detail="${bid}" hidden><td colspan="5"><div class="fl-detail-host" data-fl-host="${bid}"></div></td></tr>` : ''}`;
    }).join('');
    const overflow = entry.benchmarks.length - 10;
    return `
      <section id="flightless-benchmarks">
        <div class="gs-section-head"><span>Community benchmarks (unverified runtime)</span></div>
        <div class="fl-banner">
          <strong>Title-matched, unverified runtime.</strong> These are community
          <a href="https://mangohud.com/" target="_blank" rel="noopener">MangoHud</a> captures from
          <a href="https://flightlesssomething.ambrosia.one/" target="_blank" rel="noopener">FlightlessSomething</a>,
          matched to this game by title only. MangoHud is a Linux overlay so most runs are Proton or
          native Linux, but the data does not say which (or on what Proton version). Shown as a helpful
          signal for how this game may perform -- never counted in ratings, confidence, or the
          confirmed FPS stats above.
        </div>
        <table class="gs-fps-table">
          <thead><tr><th>Benchmark</th><th>Runs</th><th>System</th><th>Date</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:0.78rem;margin-top:10px">
          ${overflow > 0 ? `+${overflow} more on ` : 'Browse all on '}
          <a href="${esc(searchUrl)}" target="_blank" rel="noopener">FlightlessSomething -&gt;</a>
        </p>
      </section>`;
  }

  // #410: on-demand expansion of a FlightlessSomething benchmark into the
  // same chart + table treatment the confirmed runs get. Fetches the
  // per-run stats anonymously at click time (never during page load --
  // ~10 benchmarks x full series would be megabytes) and renders each run
  // as an FPS-over-time line via a dedicated Chart.js instance.
  const _flDetailCache = new Map();
  const _flCharts = new Map();

  async function _fetchFlightlessRuns(benchId) {
    if (_flDetailCache.has(benchId)) return _flDetailCache.get(benchId);
    const p = (async () => {
      // FS's REST API sends no CORS headers, so the browser cannot call it
      // directly -- route through the flightless-benchmark edge fn proxy
      // (same pattern as protondb-summary / steam-appdetails).
      const r = await fetch(`https://ilsgdshkaocrmibwdezk.supabase.co/functions/v1/flightless-benchmark?id=${encodeURIComponent(benchId)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const payload = await r.json();
      const raw = Array.isArray(payload) ? payload : (payload.runs || []);
      return raw.map((run, i) => {
        const fps = (run.stats || {}).FPS || {};
        // series.FPS is LTTB-downsampled [x, y] pairs (max 2000 points).
        const pairs = Array.isArray(run.series?.FPS) ? run.series.FPS : [];
        return {
          name: String(run.label || `run ${i + 1}`),
          color: _FS_PALETTE[i % _FS_PALETTE.length],
          fpsMin: fps.min ?? null,
          fpsAvg: fps.avg ?? null,
          fpsMax: fps.max ?? null,
          fpsP1: fps.p01 ?? null,
          fpsP01: null,
          sampleCount: Number(fps.count || run.totalDataPoints || 0),
          series: pairs.map(pt => Number(Array.isArray(pt) ? pt[1] : pt)).filter(Number.isFinite),
          specs: [run.specGPU, run.specCPU, run.specOS].filter(Boolean).join(' / '),
        };
      });
    })();
    _flDetailCache.set(benchId, p);
    p.catch(() => _flDetailCache.delete(benchId));
    return p;
  }

  function _renderFlightlessDetail(host, benchId, runs) {
    const rows = runs.map(r => `
      <tr>
        <td><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${r.color};margin-right:6px"></span>${esc(r.name)}</td>
        <td>${r.fpsMin ?? '-'}</td><td>${r.fpsAvg ?? '-'}</td><td>${r.fpsMax ?? '-'}</td><td>${r.fpsP1 ?? '-'}</td>
        <td>${r.sampleCount.toLocaleString()}</td>
      </tr>`).join('');
    host.innerHTML = `
      <div class="gs-chart" style="margin-top:6px"><div class="gs-fps-canvas-wrap"><canvas id="fl-chart-${benchId}"></canvas></div></div>
      <table class="gs-fps-table">
        <thead><tr><th>Run</th><th>Min</th><th>Avg</th><th>Max</th><th>1% Low</th><th>Samples</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    const canvas = host.querySelector(`#fl-chart-${CSS.escape(String(benchId))}`);
    const withSeries = runs.filter(r => r.series.length > 1);
    if (!canvas || typeof window.Chart !== 'function' || !withSeries.length) return;
    const maxLen = Math.max(...withSeries.map(r => r.series.length));
    _flCharts.get(benchId)?.destroy();
    _flCharts.set(benchId, new window.Chart(canvas, {
      type: 'line',
      data: {
        labels: Array.from({ length: maxLen }, (_, i) => i + 1),
        datasets: withSeries.map(r => ({
          label: r.name, data: r.series, borderColor: r.color, backgroundColor: r.color + '22',
          fill: false, borderWidth: 1.4, pointRadius: 0, pointHitRadius: 8, tension: 0.2,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: _CHART_THEME.legend,
          tooltip: { ..._CHART_THEME.tooltip, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y} fps` } },
        },
        scales: {
          x: _CHART_THEME.axis('sample (downsampled by FlightlessSomething)'),
          y: { ..._CHART_THEME.axis('FPS'), beginAtZero: true },
        },
      },
    }));
  }

  function wireFlightlessSection(rootEl) {
    rootEl.querySelectorAll('.fl-expand-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const benchId = btn.dataset.flBench;
        const detail = rootEl.querySelector(`[data-fl-detail="${benchId}"]`);
        const host = rootEl.querySelector(`[data-fl-host="${benchId}"]`);
        if (!detail || !host) return;
        if (!detail.hidden) {
          detail.hidden = true;
          btn.textContent = 'Show data & graphs';
          return;
        }
        detail.hidden = false;
        btn.textContent = 'Hide data & graphs';
        if (host.dataset.loaded === '1') return;
        host.innerHTML = '<p style="font-size:0.8rem;color:var(--muted);padding:8px 0">Loading benchmark data from FlightlessSomething...</p>';
        try {
          const runs = await _fetchFlightlessRuns(benchId);
          _renderFlightlessDetail(host, benchId, runs);
          host.dataset.loaded = '1';
          console.debug('[game-stats] flightless detail loaded', { benchId, runs: runs.length });
        } catch (e) {
          host.innerHTML = `<p style="font-size:0.8rem;color:var(--muted);padding:8px 0">Could not load benchmark data (${esc(String(e && e.message || e))}). <a href="https://flightlesssomething.ambrosia.one/benchmarks/${esc(String(benchId))}" target="_blank" rel="noopener">Open on FlightlessSomething -&gt;</a></p>`;
        }
      });
    });
  }

  // --- Supabase native reports + configs (best effort, optional) ---

  // Pulse reports live in user_configs (same query shape the game page's
  // fetchNativeReports uses). The old code queried a 'native_reports' table
  // that does not exist, so every Pulse report silently vanished from this
  // page -- including the single-report slice target (#410).
  const SB_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
  const SB_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
  const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  async function loadPulseReports(appId) {
    try {
      const r = await fetch(
        `${SB_URL}/user_configs?app_id=eq.${encodeURIComponent(appId)}&is_flagged=neq.true&select=id,app_id,gpu,cpu,os,kernel,proton_version,rating,notes,fps_min,fps_avg,fps_max,run_type,form_responses,created_at,source&order=created_at.desc`,
        { headers: SB_HEADERS }
      );
      const rows = r.ok ? await r.json() : [];
      console.debug('[game-stats] loadPulseReports', { appId, count: rows.length, source: 'user_configs' });
      // #430: alias the Supabase primary key as `reportId` so mergeReportsById
      // can dedup against CDN pulse mirror rows (which carry `pulseId`).
      // Without this alias the merge helper cannot join and reports are
      // double-counted, same failure mode the confidence page had.
      return rows.map((r) => ({ ...r, reportId: r.id }));
    } catch (e) {
      console.debug('[game-stats] loadPulseReports failed', { appId, error: String(e && e.message || e) });
      return [];
    }
  }

  async function loadConfigs(appId) {
    // user_proton_configs.app_id is bigint (plugin configs are Steam-only);
    // non-numeric ids (pw_/gog:/epic:) would 400 -- skip them (#404 rule).
    if (!/^\d+$/.test(String(appId))) return [];
    try {
      const r = await fetch(
        `${SB_URL}/user_proton_configs?app_id=eq.${encodeURIComponent(appId)}&is_published=eq.true&select=id,app_id,config,updated_at`,
        { headers: SB_HEADERS }
      );
      return r.ok ? await r.json() : [];
    } catch { return []; }
  }

  // ProtonDB live summary via the same edge fn the game page uses. Gives us
  // an aggregate tier + total count so the stats page can still say something
  // useful when our CDN mirror has no reports for a game (#219 follow-up).
  const PROTONDB_LIVE_URL =
    'https://ilsgdshkaocrmibwdezk.supabase.co/functions/v1/protondb-summary';
  async function loadProtonDbLive(appId) {
    try {
      const r = await fetch(`${PROTONDB_LIVE_URL}?appId=${encodeURIComponent(appId)}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) {
        console.debug(`[game-stats] ProtonDB live check not ok | appId=${appId} status=${r.status} source=protondb-summary-proxy`);
        return null;
      }
      const data = await r.json();
      if (!data || data.found === false || !data.tier) {
        console.debug(`[game-stats] ProtonDB live check empty | appId=${appId} source=protondb-summary-proxy`);
        return null;
      }
      return { tier: data.tier, total: data.total || 0, score: data.score || 0, confidence: data.confidence || '' };
    } catch (e) {
      console.debug(`[game-stats] ProtonDB live check failed | appId=${appId} error=${e.message} source=protondb-summary-proxy`);
      return null;
    }
  }

  // --- header rendering ---

  function renderHeader(appId, title, { pulseCount = 0, protonDbCount = 0, liveTotal = 0 } = {}) {
    const headerImg = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${esc(appId)}/header.jpg`;
    const gameUrl = `app.html#/app/${esc(appId)}`;
    // Per-source split moved here from the game page hero so the numbers
    // still live SOMEWHERE without cluttering the hero on small screens.
    // When ProtonDB's live total exceeds our mirrored count, tag the effective
    // number so users see the true breadth (#219 follow-up).
    const effectiveProtonDb = Math.max(protonDbCount, liveTotal);
    const _liveTag = liveTotal > protonDbCount ? ' (live)' : '';
    const sourceBit = (pulseCount || effectiveProtonDb)
      ? ` &middot; <strong>${pulseCount}</strong> Pulse / <strong>${effectiveProtonDb.toLocaleString()}</strong> ProtonDB${_liveTag}`
      : '';
    // Whole left side (image + name + appid) is a single anchor so clicking
    // the boxart or title takes you back to the game page. The dedicated
    // "Back to game page" link stays on the right for keyboard/screen-reader
    // users who want an explicit affordance
    return `
      <div class="gs-header">
        <a class="gs-header-link" href="${gameUrl}" title="Back to ${esc(title || `App ${appId}`)}">
          <img src="${headerImg}" data-appid="${esc(appId)}" alt="" onerror="window.__steamImgLoad(this)">
          <div class="gs-header-info">
            <div class="name">${esc(title || `App ${appId}`)}</div>
            <div class="sub">App ${esc(appId)}${sourceBit}</div>
          </div>
        </a>
        <a class="gs-back" href="${gameUrl}">&larr; Back to game page</a>
      </div>
    `;
  }

  // --- section icons ---

  const ICON = {
    status: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 21h18M5 21V9l4 6 4-10 4 7 3-4v13"/></svg>',
    factors: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>',
    dist: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="3" height="9"/><rect x="9" y="7" width="3" height="13"/><rect x="15" y="3" width="3" height="17"/></svg>',
    versions: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    tips: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z"/></svg>',
    trend: '<svg viewBox="0 0 24 24" fill="none"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  };

  // --- status cards (working / confidence / freshness) ---

  function renderStatusCards(stats) {
    const ws = stats.workingStatus;
    const wsTone = ws.status === 'working' ? 'green' : ws.status === 'not_working' ? 'red' : ws.status === 'mixed' ? 'amber' : '';
    const wsLabel = ws.status === 'working' ? 'Working'
                  : ws.status === 'not_working' ? 'Not working'
                  : ws.status === 'mixed' ? 'Mixed signal' : 'Unknown';
    const wsSub = `Based on last ${ws.timeframe_days} days · ${ws.confidence} certainty`
                + (ws.recently_broken ? ' · Recently broken' : '');

    const confTone = stats.confidencePct >= 70 ? 'green' : stats.confidencePct >= 40 ? 'amber' : 'red';
    const confBucket = stats.confidenceBucket || '';
    const confSub = confBucket
      ? `${confBucket} confidence across ${stats.totalReports.toLocaleString()} report${stats.totalReports !== 1 ? 's' : ''}`
      : `Across ${stats.totalReports.toLocaleString()} report${stats.totalReports !== 1 ? 's' : ''}`;

    // Overall tier card mirrors the game page dial
    const TIER_COLORS = { platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0', bronze: '#b07040', borked: '#c85050', pending: '#3a4a5a' };
    const tierColor = TIER_COLORS[stats.overallTier] || TIER_COLORS.pending;
    const tierLabel = stats.overallTier === 'pending' ? 'Pending' : stats.overallTier.toUpperCase();

    const fresh = stats.freshness;
    const freshTone = fresh.is_stale ? 'red' : fresh.latest_report_age < 90 ? 'green' : 'amber';
    const freshSub = fresh.latest_report_age != null
      ? `Latest report ${fresh.latest_report_age} day${fresh.latest_report_age !== 1 ? 's' : ''} ago`
      : 'No timestamped reports';

    const lpRel = ws.last_positive_report_age;
    const lastPositive = lpRel != null
      ? `${lpRel} days ago`
      : '—';

    return `
      <div class="gs-status-grid">
        <div class="gs-card" style="border-left:3px solid ${tierColor}">
          <div class="label">Overall tier</div>
          <div class="value" style="color:${tierColor}">${tierLabel}</div>
          <div class="sub">${esc(wsLabel)} · ${ws.confidence} certainty</div>
        </div>
        <div class="gs-card ${wsTone}">
          <div class="label">Working status</div>
          <div class="value">${wsLabel}</div>
          <div class="sub">${esc(wsSub)}</div>
        </div>
        <div class="gs-card ${confTone}">
          <div class="label">Confidence</div>
          <div class="value">${stats.confidencePct}%</div>
          <div class="sub">${esc(confSub)}</div>
        </div>
        <div class="gs-card ${freshTone}">
          <div class="label">Freshness</div>
          <div class="value">${esc(fresh.label)}</div>
          <div class="sub">${esc(freshSub)}</div>
        </div>
        <div class="gs-card blue">
          <div class="label">Last positive report</div>
          <div class="value">${esc(lastPositive)}</div>
          <div class="sub">Across all data sources</div>
        </div>
      </div>
    `;
  }

  // --- monthly chart (SVG, 5-year window) ---
  //
  // Returns an object: { html, wire }. The caller injects html into the DOM
  // then calls wire(rootEl) once the chart is in the document so the hover
  // helper can attach to the live nodes (attachChartHover needs measured rects)
  function renderChart(months) {
    if (!months || months.length === 0) {
      return {
        html: `<div class="gs-chart" style="text-align:center;color:var(--muted);padding:40px 0">No timestamped reports.</div>`,
        wire: () => {},
      };
    }
    const now = new Date();
    const cutoff = new Date(now.getFullYear() - 5, now.getMonth(), 1);
    const filtered = months.filter(m => {
      const [y, mo] = m.month.split('-').map(Number);
      return new Date(y, mo - 1, 1) >= cutoff;
    });
    if (filtered.length === 0) {
      return {
        html: `<div class="gs-chart" style="text-align:center;color:var(--muted);padding:40px 0">No reports in the last 5 years.</div>`,
        wire: () => {},
      };
    }

    const w = 600, h = 200, pad = 36, chartW = w - pad - 20, chartH = h - 30;
    let maxVal = 1;
    filtered.forEach(m => { maxVal = Math.max(maxVal, m.positive, m.negative); });
    const x = i => pad + (i / (filtered.length - 1 || 1)) * chartW;
    const y = v => 10 + chartH - (v / maxVal) * chartH;
    const line = (data, key) => data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
    const area = (data, key) => `${line(data, key)} L${x(data.length - 1).toFixed(1)},${10 + chartH} L${pad},${10 + chartH} Z`;

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fmt = m => { const [y, mo] = m.split('-'); return `${MONTHS[+mo - 1]} '${y.slice(2)}`; };
    const step = Math.max(1, Math.floor(filtered.length / 8));
    let labels = '';
    for (let i = 0; i < filtered.length; i += step) {
      labels += `<text x="${x(i).toFixed(1)}" y="${h - 4}" fill="#7a9bb5" font-size="9" text-anchor="middle">${fmt(filtered[i].month)}</text>`;
    }

    // Single full-width hover target so the cursor tracks continuously
    // along the line; the helper picks the nearest data point on mousemove
    const targets = `<rect class="ci-hover-target ci-hover-full" x="${pad}" y="10" width="${chartW}" height="${chartH}" fill="transparent"/>`;

    const html = `
      <div class="gs-chart" id="gs-monthly-chart">
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="gpos" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#5bd17a" stop-opacity="0.4"/>
              <stop offset="100%" stop-color="#5bd17a" stop-opacity="0.05"/>
            </linearGradient>
            <linearGradient id="gneg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#ff6b6b" stop-opacity="0.4"/>
              <stop offset="100%" stop-color="#ff6b6b" stop-opacity="0.05"/>
            </linearGradient>
          </defs>
          <path d="${area(filtered, 'positive')}" fill="url(#gpos)"/>
          <path d="${line(filtered, 'positive')}" fill="none" stroke="#5bd17a" stroke-width="2"/>
          <path d="${area(filtered, 'negative')}" fill="url(#gneg)"/>
          <path d="${line(filtered, 'negative')}" fill="none" stroke="#ff6b6b" stroke-width="2"/>
          ${labels}
          <line class="ci-hover-guide" id="gs-mc-guide" x1="0" y1="10" x2="0" y2="${10 + chartH}"/>
          <circle class="ci-hover-dot" id="gs-mc-dot-pos" r="4" fill="#5bd17a"/>
          <circle class="ci-hover-dot" id="gs-mc-dot-neg" r="4" fill="#ff6b6b"/>
          ${targets}
        </svg>
        <div class="ci-tooltip" id="gs-mc-tip"></div>
        <div class="gs-chart-legend">
          <span><span class="dot" style="background:#5bd17a"></span>Positive (platinum/gold/silver)</span>
          <span><span class="dot" style="background:#ff6b6b"></span>Negative (bronze/borked)</span>
        </div>
      </div>
    `;

    const wire = () => {
      const host = document.getElementById('gs-monthly-chart');
      if (!host) return;
      const svg = host.querySelector('svg');
      const tooltip = document.getElementById('gs-mc-tip');
      const guide = document.getElementById('gs-mc-guide');
      const dotPos = document.getElementById('gs-mc-dot-pos');
      const dotNeg = document.getElementById('gs-mc-dot-neg');
      attachChartHover({
        svg, host, tooltip, guide,
        dots: [dotPos, dotNeg],
        data: filtered,
        getX: x,
        getYForDot: (item, dotIdx) => y(dotIdx === 0 ? item.positive : item.negative),
        renderTip: item => `
          <div class="ci-tip-month">${fmt(item.month)}</div>
          <div class="ci-tip-row">
            <span class="ci-tip-dot" style="background:#5bd17a"></span>
            <span>Positive</span>
            <span class="ci-tip-val">${item.positive}</span>
          </div>
          <div class="ci-tip-row">
            <span class="ci-tip-dot" style="background:#ff6b6b"></span>
            <span>Negative</span>
            <span class="ci-tip-val">${item.negative}</span>
          </div>
        `,
        // Click a month to filter the page below. Right now nothing listens
        // for this, but the event is dispatched for future per-month filter
        onClick: item => dispatchFilter({ key: 'month', value: item.month, label: fmt(item.month) }),
      });
    };

    return { html, wire };
  }

  // --- recent vs long-term trend ---
  //
  // Shows the positive-report ratio in the last 90 days side-by-side with
  // the 90-270 day window. Same numbers computeGameStats already produces;
  // this just visualises them so users can see "still working great" vs
  // "was working, broke recently" at a glance.
  function renderTrend(stats) {
    const recent = stats.recentPositiveRatio;
    const older = stats.olderPositiveRatio;
    if (recent == null || older == null) {
      return `<div style="color:var(--muted);font-size:0.85rem;padding:8px 0">
        Not enough timestamped reports across both windows to compute a trend.
        Need at least 5 reports in the last 90 days AND 5 in the prior 90-270d window.
      </div>`;
    }
    const recentPct = Math.round(recent * 100);
    const olderPct = Math.round(older * 100);
    const delta = recentPct - olderPct;
    const dirLabel = stats.trendDir === 'improving' ? 'Improving'
      : stats.trendDir === 'declining' ? 'Declining'
      : 'Stable';
    const dirColor = stats.trendDir === 'improving' ? '#5bd17a'
      : stats.trendDir === 'declining' ? '#ff6b6b'
      : '#7a9bb5';
    const arrow = stats.trendDir === 'improving' ? '↑'
      : stats.trendDir === 'declining' ? '↓'
      : '→';
    const tone = (pct) => pct >= 70 ? '#5bd17a' : pct >= 40 ? '#ffb84d' : '#ff6b6b';

    return `
      <div class="gs-trend">
        <div class="gs-trend-summary" style="border-left:3px solid ${dirColor}">
          <span class="gs-trend-arrow" style="color:${dirColor}">${arrow}</span>
          <span class="gs-trend-dir" style="color:${dirColor}">${dirLabel}</span>
          <span class="gs-trend-delta">${delta > 0 ? '+' : ''}${delta} pts vs prior window</span>
          <span class="gs-trend-meta">${stats.recentCount} reports last 90d &middot; ${stats.priorCount} prior 90-270d</span>
        </div>
        <div class="gs-trend-bars">
          <div class="gs-trend-row">
            <span class="gs-trend-lbl">Recent (90d)</span>
            <div class="gs-trend-bar"><div style="width:${recentPct}%;background:${tone(recentPct)}"></div></div>
            <span class="gs-trend-pct" style="color:${tone(recentPct)}">${recentPct}%</span>
          </div>
          <div class="gs-trend-row">
            <span class="gs-trend-lbl">Older (90-270d)</span>
            <div class="gs-trend-bar"><div style="width:${olderPct}%;background:${tone(olderPct)}"></div></div>
            <span class="gs-trend-pct" style="color:${tone(olderPct)}">${olderPct}%</span>
          </div>
        </div>
        <p class="gs-trend-explain">
          Each bar is the share of reports rated playable (Platinum, Gold, or Silver)
          in that window. <strong>Improving</strong> or <strong>declining</strong> means
          that playable share moved by at least 15 points between the two windows;
          anything smaller reads as <strong>stable</strong>. A shift between playable
          tiers, say Platinum down to Gold, does not count as a decline, because the
          game still runs. A direction only shows when both windows have at least 5
          reports, so a couple of old reports never drive the verdict.
        </p>
      </div>
    `;
  }

  // --- confidence factors ---

  function renderFactors(stats) {
    return stats.confFactors.map(f => {
      const tone = f.value >= 70 ? '#5bd17a' : f.value >= 40 ? '#ffb84d' : '#ff6b6b';
      return `
        <div class="gs-factor-row">
          <span class="lbl">${esc(f.label)}</span>
          <div class="bar"><div style="width:${f.value}%;background:${tone}"></div></div>
          <span class="pct">${f.value}%</span>
          <span class="det">${esc(f.detail)}</span>
        </div>
      `;
    }).join('');
  }

  // --- rating distribution chips ---

  function renderDistribution(stats) {
    // Match the global tier color set used elsewhere
    const TIERS = [
      { key: 'platinum', label: 'Plat', bg: '#bcd9ff', fg: '#0a1830' },
      { key: 'gold',     label: 'Gold', bg: '#f7c948', fg: '#3a2b00' },
      { key: 'silver',   label: 'Silv', bg: '#c0c8d4', fg: '#1a2030' },
      { key: 'bronze',   label: 'Bron', bg: '#d28846', fg: '#3a1d05' },
      { key: 'borked',   label: 'Bork', bg: '#e85a5a', fg: '#3a0606' },
    ];
    return `
      <div class="gs-dist">
        ${TIERS.map(t => `
          <div class="chip" data-tier="${t.key}" style="background:${t.bg};color:${t.fg}">
            <div class="tier">${t.label}</div>
            <div class="n">${stats.ratingCounts[t.key] || 0}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // --- Proton version success rates ---

  function renderVersions(stats) {
    if (!stats.versionStats.length) {
      return `<div style="color:var(--muted);font-size:0.85rem">No version data.</div>`;
    }
    return `
      <div class="gs-row-list">
        ${stats.versionStats.map(v => {
          const tone = v.pct >= 70 ? '#5bd17a' : v.pct >= 40 ? '#ffb84d' : '#ff6b6b';
          return `
            <div class="row" data-version="${esc(v.ver)}">
              <span class="name">${esc(v.ver)}</span>
              <span class="count">${v.total}</span>
              <div class="bar"><div style="width:${v.pct}%;background:${tone}"></div></div>
              <span class="pct">${v.pct}%</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // --- Settings tips (launch options from positive reports) ---

  function renderTips(stats) {
    if (!stats.settingsTips.length) {
      return `<div style="color:var(--muted);font-size:0.85rem">No launch options recorded in positive reports.</div>`;
    }
    return `
      <div class="gs-row-list">
        ${stats.settingsTips.map(t => `
          <div class="row">
            <span class="name">${esc(t.flag)}</span>
            <span class="count">${t.cnt} uses</span>
            <div class="bar"><div style="width:${t.pct}%;background:var(--accent)"></div></div>
            <span class="pct">${t.pct}%</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  // --- hardware comparison (#412) ---
  //
  // Turns the "Scoring against: <system>" selector into a real signal by
  // splitting the game's reports into three cohorts:
  //   arch   - same GPU vendor AND same GPU arch as viewer hw
  //   vendor - same GPU vendor, different arch
  //   other  - different vendor or unknown
  // and comparing tier distribution + working percentage of the arch cohort
  // against the overall pool. Empty state when no arch matches.

  const _TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
  const _TIER_WORKING = new Set(['platinum', 'gold', 'silver']);
  const _TIER_COLOR = {
    platinum: '#b9f2ff', gold: '#ffd166', silver: '#c0c0c0',
    bronze: '#cd7f32', borked: '#ef476f',
  };

  function _gpuVendorOf(g) {
    if (!g) return '';
    const l = String(g).toLowerCase();
    if (/nvidia|geforce|rtx|gtx/.test(l)) return 'nvidia';
    if (/\bamd\b|radeon/.test(l)) return 'amd';
    if (/\bintel\b|iris|arc\b/.test(l)) return 'intel';
    return '';
  }

  function _matchLevel(myHw, report) {
    if (!myHw) return 'none';
    const myVendor = (myHw.gpuVendor || _gpuVendorOf(myHw.gpu) || '').toLowerCase();
    const rVendor = _gpuVendorOf(report.gpu);
    if (!myVendor || !rVendor || myVendor !== rVendor) return 'none';
    const myArch = detectGpuArch(myHw.gpu);
    const rArch  = detectGpuArch(report.gpu);
    if (myArch && rArch && myArch === rArch) return 'arch';
    return 'vendor';
  }

  function _tierCounts(reports) {
    const counts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0, other: 0, total: reports.length };
    for (const r of reports) {
      const t = String(r.rating || '').toLowerCase();
      if (counts[t] != null && t !== 'other') counts[t] += 1;
      else counts.other += 1;
    }
    return counts;
  }

  function _workingPct(reports) {
    const graded = reports.filter(r => _TIER_ORDER.includes(String(r.rating || '').toLowerCase()));
    if (!graded.length) return null;
    const working = graded.filter(r => _TIER_WORKING.has(String(r.rating || '').toLowerCase())).length;
    return Math.round((working / graded.length) * 100);
  }

  function _modeTier(reports) {
    const counts = _tierCounts(reports);
    let best = null, bestN = 0;
    for (const t of _TIER_ORDER) {
      if (counts[t] > bestN) { best = t; bestN = counts[t]; }
    }
    return best;
  }

  function _tierBarHtml(counts) {
    const total = _TIER_ORDER.reduce((n, t) => n + counts[t], 0);
    if (!total) return '';
    return `<div class="gs-hw-tier-bar">${_TIER_ORDER.map(t => {
      const pct = Math.round((counts[t] / total) * 100);
      if (!counts[t]) return '';
      return `<span class="gs-hw-tier-seg" style="width:${pct}%;background:${_TIER_COLOR[t]}" title="${esc(t)}: ${counts[t]} (${pct}%)"></span>`;
    }).join('')}</div>`;
  }

  function renderHwComparison(allReports, myHw) {
    // Only render when we actually have a hw profile with a GPU. Nothing to
    // score against otherwise, and the banner already invites the viewer to
    // save specs on the profile page.
    if (!myHw || !(myHw.gpu || myHw.gpuVendor)) return '';
    const graded = allReports.filter(r => _TIER_ORDER.includes(String(r.rating || '').toLowerCase()));
    if (!graded.length) return '';

    const archCohort   = graded.filter(r => _matchLevel(myHw, r) === 'arch');
    const vendorCohort = graded.filter(r => _matchLevel(myHw, r) === 'vendor');
    const overallCounts = _tierCounts(graded);
    const archCounts    = _tierCounts(archCohort);
    const overallWorking = _workingPct(graded);
    const archWorking    = _workingPct(archCohort);
    const modeTier       = _modeTier(archCohort);

    const myVendor = (myHw.gpuVendor || _gpuVendorOf(myHw.gpu) || '').toLowerCase();
    const myArch   = detectGpuArch(myHw.gpu);
    const label    = myHw.gpu || (myVendor ? myVendor.toUpperCase() : 'your system');
    const previewNote = isPreviewHardware(myHw)
      ? `<span class="gs-hw-preview-note">(Steam Deck preview -- <a href="profile.html">save your own specs</a> for a real match)</span>`
      : '';

    if (!archCohort.length) {
      // No arch match. Fall back to vendor-only summary if we have any of those,
      // otherwise say so plainly. Never a dead panel.
      const vendorLine = vendorCohort.length
        ? `<p class="gs-hw-empty-line">${vendorCohort.length} of ${graded.length} report${graded.length === 1 ? '' : 's'} run other <strong>${esc(myVendor.toUpperCase())}</strong> GPUs. Overall working rate: <strong>${overallWorking == null ? 'n/a' : overallWorking + '%'}</strong>.</p>`
        : `<p class="gs-hw-empty-line">No report${graded.length === 1 ? '' : 's'} on this game match your <strong>${esc(label)}</strong>${myArch ? ' (' + esc(myArch) + ')' : ''}. Overall working rate: <strong>${overallWorking == null ? 'n/a' : overallWorking + '%'}</strong>.</p>`;
      return `
        <div class="gs-hw-comparison" id="hw-match-body">
          <div class="gs-hw-head-row">
            <span class="gs-hw-scoring-label">Scoring against <strong>${esc(label)}</strong>${myArch ? ' &middot; ' + esc(myArch) : ''}</span>
            ${previewNote}
          </div>
          ${vendorLine}
        </div>`;
    }

    const workingDelta = (archWorking != null && overallWorking != null)
      ? archWorking - overallWorking : null;
    const deltaClass = workingDelta == null ? '' : (workingDelta > 0 ? 'up' : workingDelta < 0 ? 'down' : 'flat');
    const deltaText  = workingDelta == null ? '' :
      (workingDelta > 0 ? `+${workingDelta} pts vs overall` :
       workingDelta < 0 ? `${workingDelta} pts vs overall` : 'same as overall');

    return `
      <div class="gs-hw-comparison" id="hw-match-body">
        <div class="gs-hw-head-row">
          <span class="gs-hw-scoring-label">Scoring against <strong>${esc(label)}</strong>${myArch ? ' &middot; ' + esc(myArch) : ''}</span>
          ${previewNote}
        </div>
        <div class="gs-hw-metric-row">
          <div class="gs-hw-metric">
            <span class="gs-hw-metric-label">Matching reports</span>
            <span class="gs-hw-metric-value">${archCohort.length} <span class="gs-hw-metric-sub">of ${graded.length}</span></span>
            ${vendorCohort.length ? `<span class="gs-hw-metric-note">+ ${vendorCohort.length} same-vendor</span>` : ''}
          </div>
          <div class="gs-hw-metric">
            <span class="gs-hw-metric-label">Working on your arch</span>
            <span class="gs-hw-metric-value">${archWorking == null ? 'n/a' : archWorking + '%'}</span>
            ${deltaText ? `<span class="gs-hw-metric-note gs-hw-delta gs-hw-delta-${deltaClass}">${esc(deltaText)}</span>` : ''}
          </div>
          <div class="gs-hw-metric">
            <span class="gs-hw-metric-label">Most likely tier</span>
            <span class="gs-hw-metric-value gs-tier-badge" data-tier="${esc(modeTier || 'pending')}">${esc((modeTier || 'pending').toUpperCase())}</span>
            <span class="gs-hw-metric-note">from ${archCohort.length} matching report${archCohort.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div class="gs-hw-bars">
          <div class="gs-hw-bar-row">
            <span class="gs-hw-bar-label">Your arch</span>
            ${_tierBarHtml(archCounts)}
          </div>
          <div class="gs-hw-bar-row">
            <span class="gs-hw-bar-label">Overall</span>
            ${_tierBarHtml(overallCounts)}
          </div>
        </div>
      </div>`;
  }

  // --- assemble everything ---

  // Returns { html, wire }. wire() runs after the html is injected so any
  // chart helpers (hover targets, click-to-filter) can attach to live DOM
  function renderAll(appId, title, stats, counts = {}, allReports = [], flightlessEntry = null, myHw = null) {
    // Each section carries an id so it can be deep-linked (e.g. the game page
    // trend line links to #trend). Anchor offset handled by scroll-margin-top
    // in CSS so the sticky-ish header does not cover the section title.
    const sectionHead = (icon, title, id = '') => `<div class="gs-section-head"${id ? ` id="${id}"` : ''}>${icon}<span>${title}</span></div>`;
    const chart = renderChart(stats.monthly);

    // #410: game-wide FPS section = every report's MangoHud runs, no report
    // filter. Sits at the BOTTOM of the page; the jump list gets it there.
    const gameFpsRuns = allReports.filter(r => {
      const fr = r?.form_responses || r?.formResponses || {};
      return Array.isArray(fr.fpsRuns) && fr.fpsRuns.length;
    });
    const fpsSectionHtml = gameFpsRuns.length
      ? renderFpsRunsSection({
          form_responses: {
            fpsRuns: gameFpsRuns.flatMap(r => {
              const fr = r.form_responses || r.formResponses || {};
              const rid = r.id ?? r.reportId;
              // Prefix each run with its report so the merged table stays
              // attributable (and the per-report slice link stays one click
              // away via the report cards).
              return fr.fpsRuns.map(run => ({ ...run, name: `#${rid ?? '?'} ${run.name || 'run'}` }));
            }),
          },
        })
      : '';

    // #412: hardware comparison section. Rendered when the viewer has a hw
    // profile with a GPU; empty string otherwise so we don't add dead chrome.
    const hwHtml = renderHwComparison(allReports, myHw);

    // Jump-to-section dropdown, same shape as the profile page's (#285).
    const jumpSections = [
      ['current-state', 'Current state'],
      ...(hwHtml ? [['hw-match', 'How your system compares']] : []),
      ['monthly', 'Monthly reports'],
      ['distribution', 'Rating distribution'],
      ['trend', 'Compatibility trend'],
      ['confidence', 'Confidence factors'],
      ['proton-versions', 'Per Proton version'],
      ['launch-options', 'Launch options'],
      ...(fpsSectionHtml ? [['fps-runs', 'FPS runs']] : []),
      ['flightless-benchmarks', 'Community benchmarks'],
    ];
    const jumpList = `
      <div class="gs-jump-nav">
        <label for="gs-jump-select" class="gs-jump-label">Jump to:</label>
        <select id="gs-jump-select" class="gs-jump-select">
          <option value="" selected>Section...</option>
          ${jumpSections.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}
        </select>
      </div>`;

    const html = `
      ${renderHeader(appId, title, counts)}
      ${jumpList}
      ${sectionHead(ICON.status, 'Current state', 'current-state')}
      ${renderStatusCards(stats)}

      ${hwHtml ? sectionHead(ICON.status, 'How your system compares', 'hw-match') + hwHtml : ''}

      ${sectionHead(ICON.chart, 'Monthly reports (last 5 years)', 'monthly')}
      ${chart.html}

      ${sectionHead(ICON.dist, 'Rating distribution', 'distribution')}
      ${renderDistribution(stats)}

      ${sectionHead(ICON.trend, 'Compatibility trend (recent vs older)', 'trend')}
      ${renderTrend(stats)}

      ${sectionHead(ICON.factors, 'Confidence factors', 'confidence')}
      ${renderFactors(stats)}

      <div class="gs-two-col" style="margin-top:8px">
        <div>
          ${sectionHead(ICON.versions, 'Per Proton version', 'proton-versions')}
          ${renderVersions(stats)}
        </div>
        <div>
          ${sectionHead(ICON.tips, 'Launch options that work', 'launch-options')}
          ${renderTips(stats)}
        </div>
      </div>

      ${fpsSectionHtml}
      ${renderFlightlessSection(flightlessEntry, title)}

      <a class="gs-back" href="app.html#/app/${esc(appId)}">&larr; Back to game page</a>
    `;

    const wire = () => {
      chart.wire();
      // Jump list: scroll to the picked section, then reset to "Section...".
      const jumpSelect = document.getElementById('gs-jump-select');
      jumpSelect?.addEventListener('change', () => {
        const target = jumpSelect.value ? document.getElementById(jumpSelect.value) : null;
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        jumpSelect.value = '';
      });
      // Click rating chips to dispatch a tier filter event. Future work will
      // listen for these on the report list below (task #73 follow-ups)
      attachClickToFilter({
        selector: '.gs-dist .chip',
        getFilter: el => ({ key: 'tier', value: el.getAttribute('data-tier'), label: el.getAttribute('data-tier') }),
      });
      // Click a version row to filter
      attachClickToFilter({
        selector: '.gs-row-list .row[data-version]',
        getFilter: el => ({ key: 'protonVersion', value: el.getAttribute('data-version'), label: el.getAttribute('data-version') }),
      });
    };

    return { html, wire };
  }

  // --- entry point ---

  // #410: per-run FPS section for the single-report slice, styled after
  // FlightlessSomething / MangoHudPy (github.com/mdeguzis/MangoHudPy
  // graph.py): an FPS-over-time line chart (one colored line per run,
  // toggleable via the legend), the Summary-tab horizontal bars (Average /
  // 1% Low / 0.1% Low per run), and a sortable + filterable table. Runs
  // come from form_responses.fpsRuns; each may carry a downsampled
  // `series` (new uploads) -- runs without one still get bars + table.
  const _FS_PALETTE = ['#7cb5ec', '#90ed7d', '#f7a35c', '#8085e9', '#f15c80', '#e4d354', '#2b908f', '#f45b5b', '#91e8e1', '#66c0f4'];

  // MangoHud names its logs <Game>_YYYY-MM-DD_HH-MM-SS.csv -- pull the date
  // out so the runs can be range-filtered. Null when the name has no date.
  function _runDateFromName(name) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(String(name || ''));
    return m ? m[1] : null;
  }

  function _sliceRuns(report) {
    const fr = report?.form_responses || report?.formResponses || {};
    const runs = Array.isArray(fr.fpsRuns) ? fr.fpsRuns.filter(x => x && typeof x === 'object') : [];
    return runs.map((r, i) => ({
      name: String(r.name || `run ${i + 1}`),
      date: _runDateFromName(r.name),
      color: _FS_PALETTE[i % _FS_PALETTE.length],
      fpsMin: r.fpsMin != null ? Number(r.fpsMin) : null,
      fpsAvg: r.fpsAvg != null ? Number(r.fpsAvg) : null,
      fpsMax: r.fpsMax != null ? Number(r.fpsMax) : null,
      fpsP1: r.fpsP1 != null ? Number(r.fpsP1) : null,
      fpsP01: r.fpsP01 != null ? Number(r.fpsP01) : null,
      sampleCount: Number(r.sampleCount || 0),
      series: Array.isArray(r.series) ? r.series.map(Number).filter(Number.isFinite) : [],
    }));
  }

  // Chart.js canvas host. The chart itself is instantiated in
  // wireFpsRunsSection (needs the live DOM); this emits the chrome:
  // toolbar with the download-as-JSON icon top right, then the canvas.
  // The graph ALWAYS renders: runs with a captured series get the
  // FPS-over-time line chart; runs without one (pre-#410 uploads) get a
  // grouped min / avg / 1% low / max bar chart from the stats they DO have.
  function _renderFpsLineChart(runs) {
    const withSeries = runs.filter(r => r.series.length > 1);
    return `
      <div class="gs-chart gs-fps-chart">
        <div class="gs-fps-chart-toolbar">
          <span class="gs-fps-chart-title">${withSeries.length ? 'FPS over time' : 'FPS per run (min / avg / 1% low / max)'}</span>
          <button type="button" id="fps-download-json" class="gs-fps-dl" title="Download this report's FPS data as JSON">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zm-14 9v2h14v-2H5z"/></svg>
          </button>
        </div>
        <div class="gs-fps-canvas-wrap"><canvas id="fps-runs-chart"></canvas></div>
      </div>`;
  }

  function _renderFpsSummaryBars(runs) {
    // FlightlessSomething "Summary" tab: Average / 1% Low / 0.1% Low.
    const rows = [
      { label: 'Average', get: r => r.fpsAvg, color: '#7cb5ec' },
      { label: '1% Low', get: r => r.fpsP1 ?? r.fpsMin, color: '#90ed7d' },
      { label: '0.1% Low', get: r => r.fpsP01 ?? r.fpsMin, color: '#f7a35c' },
    ];
    const maxV = Math.max(...runs.map(r => r.fpsAvg || 0), 1);
    const groups = rows.map(row => {
      const bars = runs.map(r => {
        const v = row.get(r);
        if (v == null) return '';
        const pct = Math.max(1.5, (v / maxV) * 100);
        return `<div class="gs-fps-bar-line">
          <span class="gs-fps-bar-run" title="${esc(r.name)}">${esc(r.name.length > 26 ? r.name.slice(0, 24) + '…' : r.name)}</span>
          <div class="gs-fps-bar-track"><div class="gs-fps-bar-fill" style="width:${pct.toFixed(1)}%;background:${row.color}"></div></div>
          <span class="gs-fps-bar-val">${v.toFixed(1)} fps</span>
        </div>`;
      }).join('');
      return `<div class="gs-fps-bar-group"><div class="gs-fps-bar-label">${row.label}</div>${bars}</div>`;
    }).join('');
    return `<div class="gs-fps-summary">${groups}</div>`;
  }

  function renderFpsRunsSection(report) {
    const runs = _sliceRuns(report);
    _fpsSectionRuns = runs;
    if (!runs.length) {
      // Focused slice with no MangoHud captures: say so instead of a blank
      // page. The aggregate trio may still exist on the report row.
      const agg = [report.fps_min ?? report.fpsMin, report.fps_avg ?? report.fpsAvg, report.fps_max ?? report.fpsMax];
      const aggLine = agg.some(v => v != null)
        ? `<p class="gs-fps-empty-agg">Reported FPS (min / avg / max): <code>${agg.map(v => v != null ? Number(v).toFixed(1) : '-').join(' / ')}</code></p>`
        : '';
      return `
        <section id="fps-runs">
          <div class="gs-section-head"><span>FPS runs</span></div>
          <div class="error-state" style="padding:24px">
            <p>This report has no per-run MangoHud captures.</p>
            ${aggLine}
            <p style="font-size:0.78rem;color:var(--muted);margin-top:8px">Per-run graphs appear when a report is submitted with the Upload MangoHud CSV / ZIP button.</p>
          </div>
        </section>`;
    }
    const rows = runs.map(r => `
      <tr data-run-row data-run-name="${esc(r.name.toLowerCase())}"${r.date ? ` data-run-date="${esc(r.date)}"` : ''}>
        <td><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${r.color};margin-right:6px"></span>${esc(r.name)}</td>
        <td data-v="${r.fpsMin ?? ''}">${r.fpsMin ?? '-'}</td>
        <td data-v="${r.fpsAvg ?? ''}">${r.fpsAvg ?? '-'}</td>
        <td data-v="${r.fpsMax ?? ''}">${r.fpsMax ?? '-'}</td>
        <td data-v="${r.fpsP1 ?? ''}">${r.fpsP1 ?? '-'}</td>
        <td data-v="${r.fpsP01 ?? ''}">${r.fpsP01 ?? '-'}</td>
        <td data-v="${r.sampleCount}">${r.sampleCount.toLocaleString()}</td>
      </tr>`).join('');
    return `
      <section id="fps-runs">
        <div class="gs-section-head"><span>FPS runs (${runs.length})</span></div>
        <p style="font-size:0.78rem;color:var(--muted);margin:4px 0 10px">Per-capture MangoHud stats submitted with this report. Click a legend entry to hide / show its line; click table headers to sort.</p>
        ${_renderFpsLineChart(runs)}
        ${_renderFpsSummaryBars(runs)}
        <div class="gs-fps-filter-row">
          <input type="search" id="fps-runs-filter" class="gs-fps-filter" placeholder="Filter runs by name...">
          <label class="gs-fps-date-label" for="fps-runs-from">From</label>
          <input type="date" id="fps-runs-from" class="gs-fps-date">
          <label class="gs-fps-date-label" for="fps-runs-to">To</label>
          <input type="date" id="fps-runs-to" class="gs-fps-date">
        </div>
        <table class="gs-fps-table" id="fps-runs-table">
          <thead><tr>
            <th data-sort="text">Run</th><th data-sort="num">Min</th><th data-sort="num">Avg</th><th data-sort="num">Max</th><th data-sort="num">1% Low</th><th data-sort="num">0.1% Low</th><th data-sort="num">Samples</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
  }

  // Kept on the closure so wireFpsRunsSection can build the chart + the
  // JSON download from the same data renderFpsRunsSection rendered.
  let _fpsSectionRuns = [];
  let _fpsChartInstance = null;

  function _downloadFpsJson(appId, reportId) {
    const payload = {
      app_id: String(appId),
      report_id: reportId != null ? String(reportId) : null,
      generated_at: new Date().toISOString(),
      source: 'proton-pulse report submission (MangoHud captures)',
      runs: _fpsSectionRuns.map(r => ({
        name: r.name,
        fps_min: r.fpsMin, fps_avg: r.fpsAvg, fps_max: r.fpsMax,
        fps_p1_low: r.fpsP1, fps_p01_low: r.fpsP01,
        sample_count: r.sampleCount,
        series_downsampled: r.series,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `proton-pulse-fps-${appId}${reportId ? `-report-${reportId}` : ''}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    console.debug('[game-stats] fps json downloaded', { appId, reportId, runs: _fpsSectionRuns.length });
  }

  const _CHART_THEME = {
    legend: {
      position: 'bottom',
      labels: {
        color: '#c7d5e0',
        boxWidth: 12,
        boxHeight: 12,
        font: { size: 11 },
        // Filled square while the dataset is visible, hollow (border-only)
        // once it is toggled off -- the fill state IS the on/off indicator.
        generateLabels(chart) {
          const items = window.Chart.defaults.plugins.legend.labels.generateLabels(chart);
          for (const it of items) {
            const ds = chart.data.datasets[it.datasetIndex] || {};
            const color = typeof ds.borderColor === 'string' ? ds.borderColor : '#7cb5ec';
            it.fillStyle = it.hidden ? 'transparent' : color;
            it.strokeStyle = color;
            it.lineWidth = 1.5;
          }
          return items;
        },
      },
    },
    tooltip: {
      backgroundColor: '#1E1E1E',
      borderColor: 'rgba(110,180,240,0.28)',
      borderWidth: 1,
      titleColor: '#c7d5e0',
      bodyColor: '#c7d5e0',
    },
    axis: (titleText) => ({
      title: { display: true, text: titleText, color: '#7a9bb5', font: { size: 10 } },
      ticks: { color: '#7a9bb5', maxTicksLimit: 12, font: { size: 10 } },
      grid: { color: 'rgba(255,255,255,0.07)' },
    }),
  };

  function _buildFpsChart(rootEl) {
    const canvas = rootEl.querySelector('#fps-runs-chart');
    if (!canvas || typeof window.Chart !== 'function' || !_fpsSectionRuns.length) return;
    const withSeries = _fpsSectionRuns.filter(r => r.series.length > 1);
    if (_fpsChartInstance) { _fpsChartInstance.destroy(); _fpsChartInstance = null; }

    if (withSeries.length) {
      // FPS-over-time line chart, one line per run.
      const maxLen = Math.max(...withSeries.map(r => r.series.length));
      _fpsChartInstance = new window.Chart(canvas, {
        type: 'line',
        data: {
          labels: Array.from({ length: maxLen }, (_, i) => i + 1),
          datasets: withSeries.map(r => ({
            label: r.name,
            data: r.series,
            borderColor: r.color,
            backgroundColor: r.color + '22',
            fill: true,
            borderWidth: 1.5,
            pointRadius: 0,
            pointHitRadius: 8,
            tension: 0.2,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: _CHART_THEME.legend,
            tooltip: { ..._CHART_THEME.tooltip, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y} fps` } },
          },
          scales: {
            x: _CHART_THEME.axis('sample (downsampled)'),
            y: { ..._CHART_THEME.axis('FPS'), beginAtZero: true },
          },
        },
      });
      return;
    }

    // No captured series (pre-#410 uploads): multi-line chart across runs --
    // one toggleable line per metric (Min / 1% Low / Average / Max), x axis
    // is the run. Chart.js legend clicks add/remove lines natively.
    const metrics = [
      { label: 'Max', get: r => r.fpsMax, color: '#8085e9' },
      { label: 'Average', get: r => r.fpsAvg, color: '#7cb5ec' },
      { label: '1% Low', get: r => r.fpsP1 ?? null, color: '#f7a35c' },
      { label: 'Min', get: r => r.fpsMin, color: '#90ed7d' },
    ].filter(m => _fpsSectionRuns.some(r => m.get(r) != null));
    _fpsChartInstance = new window.Chart(canvas, {
      type: 'line',
      data: {
        labels: _fpsSectionRuns.map(r => r.name.length > 26 ? r.name.slice(0, 24) + '…' : r.name),
        datasets: metrics.map(m => ({
          label: m.label,
          data: _fpsSectionRuns.map(r => m.get(r)),
          borderColor: m.color,
          backgroundColor: m.color + '22',
          fill: m.label === 'Min' ? 'origin' : false,
          borderWidth: 1.6,
          pointRadius: 3,
          pointBackgroundColor: m.color,
          pointHitRadius: 10,
          tension: 0.25,
          spanGaps: true,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: _CHART_THEME.legend,
          tooltip: { ..._CHART_THEME.tooltip, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y} fps` } },
        },
        scales: {
          x: { ..._CHART_THEME.axis('run'), ticks: { color: '#7a9bb5', font: { size: 9 }, maxRotation: 40, autoSkip: false } },
          y: { ..._CHART_THEME.axis('FPS'), beginAtZero: true },
        },
      },
    });
  }

  function wireFpsRunsSection(rootEl, appId, reportId) {
    _buildFpsChart(rootEl);
    rootEl.querySelector('#fps-download-json')?.addEventListener('click', () => _downloadFpsJson(appId, reportId));
    // Combined filters: name substring + date range (dates parsed from the
    // MangoHud filename, YYYY-MM-DD). Rows without a parseable date stay
    // visible under a date filter -- hiding them would silently drop runs.
    const filter = rootEl.querySelector('#fps-runs-filter');
    const fromEl = rootEl.querySelector('#fps-runs-from');
    const toEl = rootEl.querySelector('#fps-runs-to');
    const applyRunFilters = () => {
      const q = (filter?.value || '').trim().toLowerCase();
      const from = fromEl?.value || '';
      const to = toEl?.value || '';
      rootEl.querySelectorAll('#fps-runs-table [data-run-row]').forEach(tr => {
        const nameMiss = !!q && !(tr.dataset.runName || '').includes(q);
        const d = tr.dataset.runDate || '';
        const dateMiss = !!d && ((from && d < from) || (to && d > to));
        tr.hidden = nameMiss || dateMiss;
      });
    };
    filter?.addEventListener('input', applyRunFilters);
    fromEl?.addEventListener('change', applyRunFilters);
    toEl?.addEventListener('change', applyRunFilters);
    const table = rootEl.querySelector('#fps-runs-table');
    if (!table) return;
    table.querySelectorAll('th').forEach((th, colIdx) => {
      th.style.cursor = 'pointer';
      th.title = 'Sort';
      th.addEventListener('click', () => {
        const tbody = table.querySelector('tbody');
        const dir = th.dataset.dir === 'asc' ? -1 : 1;
        table.querySelectorAll('th').forEach(t => delete t.dataset.dir);
        th.dataset.dir = dir === 1 ? 'asc' : 'desc';
        const numeric = th.dataset.sort === 'num';
        Array.from(tbody.querySelectorAll('tr'))
          .sort((a, b) => {
            const av = a.cells[colIdx].dataset.v ?? a.cells[colIdx].textContent;
            const bv = b.cells[colIdx].dataset.v ?? b.cells[colIdx].textContent;
            return numeric ? dir * ((Number(av) || 0) - (Number(bv) || 0)) : dir * String(av).localeCompare(String(bv));
          })
          .forEach(tr => tbody.appendChild(tr));
      });
    });
  }

  async function run() {
    const params = new URLSearchParams(location.search);
    // App ids are numeric Steam ids or store-prefixed slugs (gog:, epic:,
    // pw_..., legacy pgwiki:). Restrict to that alphabet at the boundary so
    // the value can never carry markup into the innerHTML renders below
    // (CodeQL js/xss).
    const appRaw = params.get('app');
    const appId = (appRaw && /^[A-Za-z0-9:._-]+$/.test(appRaw)) ? appRaw : null;
    // #410: ?report=<id> renders the SAME stats page filtered down to one
    // report -- graphs, sections, and (below) the per-run FPS table all
    // compute from just that report's rows. Numeric-only, like the edit
    // param on submit.html, so it cannot reflect into markup.
    const reportRaw = params.get('report');
    const reportId = (reportRaw && /^[0-9]+$/.test(reportRaw)) ? reportRaw : null;
    if (!appId) {
      root.innerHTML = `<div class="error-state">
        <p>No app id in URL.</p>
        <p style="font-size:0.78rem;margin-top:8px">Expected <code>?app=1091500</code>.</p>
      </div>`;
      return;
    }

    metaEl.textContent = reportId
      ? `// app id ${appId} · report #${reportId} · single-report slice`
      : `// app id ${appId} · live computation from CDN + Pulse data`;

    // Pull search index in parallel with CDN + Pulse + live summary so the
    // page can still say something useful when the mirror is empty (#219).
    const [cdnReports, idxRow, pulseReports, configs, liveSummary, flightlessEntry] = await Promise.all([
      loadGame(appId),
      // #437: one id via the batch API (~2KB) instead of the 11.8MB blob.
      getGamesByIds([appId]).then(m => m.get(String(appId)) || null),
      loadPulseReports(appId),
      loadConfigs(appId),
      loadProtonDbLive(appId),
      loadFlightlessEntry(appId),
    ]);

    // The game's title comes from that one search-index row.
    let title = `App ${appId}`;
    if (idxRow && idxRow.title) title = idxRow.title;

    // #430: dedup CDN pulse mirror against live Pulse rows the same way the
    // game page does. Both surfaces feed computeGameStats/computeConfidence
    // downstream; without dedup the same submission is counted twice.
    let allReports = mergeReportsById(cdnReports, pulseReports);
    // #410: single-report slice. Every section below computes from the
    // filtered set, so the whole page becomes that report's stats.
    let sliceReport = null;
    if (reportId) {
      sliceReport = allReports.find(r => String(r.id ?? r.reportId ?? '') === reportId) || null;
      if (sliceReport) {
        allReports = [sliceReport];
        console.debug('[game-stats] single-report slice active', { appId, reportId, found: true });
      } else {
        console.debug('[game-stats] report id not found; falling back to full stats', { appId, reportId });
      }
    }
    if (allReports.length === 0 && configs.length === 0) {
      // Nothing mirrored -- but ProtonDB may still have an aggregate. Fall
      // through to a stub view that surfaces the live tier + total instead
      // of just saying "no data" (#219).
      const liveBlock = liveSummary
        ? `<div class="gs-live-summary">
            <div class="gs-live-summary-head">
              <span class="gs-live-summary-tier gs-live-summary-tier-${esc(String(liveSummary.tier).toLowerCase())}">${esc(String(liveSummary.tier).toUpperCase())}</span>
              <span class="gs-live-summary-total"><strong>${liveSummary.total.toLocaleString()}</strong> ProtonDB report${liveSummary.total !== 1 ? 's' : ''}</span>
              ${liveSummary.confidence ? `<span class="gs-live-summary-conf">${esc(liveSummary.confidence)} confidence</span>` : ''}
            </div>
            <p class="gs-live-summary-note">
              ProtonDB has aggregate data for this game but we haven't mirrored the individual reports yet, so the full per-report stats below are unavailable.
              <a href="https://www.protondb.com/app/${esc(appId)}" target="_blank" rel="noopener">Read them on ProtonDB &gt;</a>
            </p>
          </div>`
        : `<p style="font-size:0.78rem;margin-top:8px">
            Try <a href="app.html#/app/${esc(appId)}">the game page</a> and submit the first report.
          </p>`;
      // nosemgrep: javascript.browser.security.raw-html-concat.raw-html-concat — all user-derived values inside renderHeader() and liveBlock are wrapped in esc()
      root.innerHTML = renderHeader(appId, title, { pulseCount: pulseReports.length, protonDbCount: cdnReports.length, liveTotal: liveSummary?.total || 0 }) + `
        <div class="error-state">
          <p>${liveSummary ? 'No individual reports mirrored yet for this game.' : 'No reports or configs found for this game.'}</p>
          ${liveBlock}
        </div>
      ` + renderFlightlessSection(flightlessEntry, title);
      // #410: title-matched community benchmarks still render on the
      // no-reports stub -- a game with zero mirrored reports is exactly
      // where an external performance signal helps most.
      wireFlightlessSection(root);
      return;
    }

    // #361/#376: liveExcess (unmirrored ProtonDB reports) feeds
    // computeGameStats -> computeConfidence, the SAME canonical calc the
    // game page headline and confidence.html read. The tier stays derived
    // from actual report ratings via the recency-weighted algorithm.
    const liveTotal = liveSummary?.total || 0;
    const liveExcess = liveTotal > cdnReports.length ? liveTotal - cdnReports.length : 0;
    const stats = computeGameStats(allReports, configs, liveExcess);

    const combinedTier = pulseTierFromReports(allReports, liveExcess);
    stats.overallTier = allReports.length > 0
      ? combinedTier.tier
      : (liveSummary?.tier ? String(liveSummary.tier).toLowerCase() : 'pending');
    stats.totalReports = allReports.length + Math.max(0, liveTotal - cdnReports.length);
    stats.confidenceBucket = stats.confidencePct >= 80 ? 'high'
      : stats.confidencePct >= 50 ? 'moderate' : 'low';

    // Pull viewer hardware (real or Steam Deck preview fallback) so the
    // page can both surface the banner and feed personalised match scoring
    // into future sections (#74 will lean on this)
    const myHw = typeof loadMyHardware === 'function' ? loadMyHardware() : null;
    const previewBanner = renderPreviewHardwareBanner();

    const { html, wire } = renderAll(appId, title, stats, {
      pulseCount: pulseReports.length,
      protonDbCount: cdnReports.length,
      liveTotal: liveSummary?.total || 0,
    }, allReports, flightlessEntry, myHw);
    // #410: slice chrome. A banner up top saying whose stats these are +
    // the per-run FPS section (graph + sortable table) when the report
    // carries MangoHud runs. renderFpsRunsSection escapes all values.
    // #410: report-slice mode is FOCUSED -- the page shows ONLY that
    // report's stats (banner link up top + report facts + the FPS graphs
    // and table). The full game-wide sections render only in game mode.
    if (sliceReport) {
      // Plain header line, not chips: report id + the facts as one muted
      // mono line, with the view-the-report link at the end.
      const facts = [
        String(sliceReport.proton_version || sliceReport.protonVersion || 'unknown Proton'),
        String(sliceReport.gpu || 'unknown GPU'),
        sliceReport.os ? String(sliceReport.os) : null,
        sliceReport.rating ? String(sliceReport.rating).toUpperCase() : null,
      ].filter(Boolean);
      const sliceBanner = `
        <a class="gs-slice-banner gs-slice-banner--link" href="game-stats.html?app=${esc(String(appId))}">
          &#8592; Click here to view all game statistics for ${esc(title)}
        </a>
        <div class="gs-slice-head">
          <span class="gs-slice-head-title">Report #${esc(String(reportId))}</span>
          <span class="gs-slice-head-facts">${esc(facts.join(' · '))}</span>
          <a class="gs-slice-head-link" href="app.html#/app/${encodeURIComponent(String(appId))}#report-r${esc(String(reportId))}">View the report -&gt;</a>
        </div>`;
      // nosemgrep: javascript.browser.security.raw-html-concat.raw-html-concat — all user-derived values are escaped via esc()
      // No hardware-match banner in slice mode: nothing on this focused
      // view scores against the viewer's system, so "Scoring against:
      // <system>" would be a dead control. (The overall-stats hardware
      // comparison area is #412.)
      root.innerHTML = sliceBanner + renderFpsRunsSection(sliceReport);
      wireFpsRunsSection(root, appId, reportId);
      void enhanceHardwareBanner();
      return;
    }
    // nosemgrep: javascript.browser.security.raw-html-concat.raw-html-concat — all user-derived values are escaped via esc() inside renderAll() and renderPreviewHardwareBanner()
    root.innerHTML = previewBanner + html;
    // wire() must run AFTER innerHTML so the hover helper sees real DOM rects.
    // Also surface the filter event for future consumers (a debug log for now)
    wire();
    // Game-wide FPS section (bottom of the page): chart + download + table
    // sorting, same wiring as the slice, no report filter.
    wireFpsRunsSection(root, appId, null);
    wireFlightlessSection(root);
    void enhanceHardwareBanner();
    // Deep links from other pages (e.g. the game page trend line -> #trend)
    // land after this async render, so the browser has already given up on the
    // hash. Scroll the target section into view ourselves once it exists.
    if (location.hash.length > 1) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) {
        requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        console.debug('[game-stats] scrolled to deep-link section', { hash: location.hash, found: true });
      } else {
        console.debug('[game-stats] deep-link section not found', { hash: location.hash, found: false });
      }
    }
    onFilterChange(payload => {
      console.debug('[game-stats] chart-filter', payload);
      // Real list-filtering will land when we add the reports panel below
      // the stats sections (task #74 + follow-ups)
    });
  }

  run().catch(err => {
    console.error('[game-stats] failed', err);
    root.innerHTML = `<div class="error-state">Stats failed to load: ${esc(err && err.message || err)}</div>`; // nosemgrep: javascript.browser.security.raw-html-concat.raw-html-concat — error message is wrapped in esc()
  });
})();
