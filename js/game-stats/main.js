// Entry module for game-stats.html. Migrated from game-stats.js.
import { computeGameStats } from '../lib/scoring/gameStats.js?v=1c1b7f9d';
import { pulseTierFromReports } from '../shared/scoring.js?v=8051e115';
import { isPreviewHardware, loadMyHardware, renderPreviewHardwareBanner } from '../shared/hardware.js?v=6a1246aa';
import { attachChartHover, attachClickToFilter, dispatchFilter, onFilterChange } from '../shared/chart-interactions.js?v=6b608095';
import { loadSteamImg as _loadSteamImg } from '../app/lib/steam-img.js?v=ba0d7848';
import { appIdToDir } from '../lib/app-id.js?v=18a73fb7';

// Per-game stats page (game-stats.html). Reads ?app=APPID from the URL,
// pulls the same CDN data the main app page uses, then renders a thoughtful
// breakdown via computeGameStats() from js/lib/scoring/gameStats.js.
//
// Same CDN base resolution as confidence.html so localhost dev preview works.

(function () {
  const root = document.getElementById('gs-root');
  const metaEl = document.getElementById('gs-meta');

  const SITE_BASE = (() => {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'proton-pulse-web-staging') return '/proton-pulse-web-staging';
    if (parts[0] === 'proton-pulse-web') return '/proton-pulse-web';
    return '';
  })();
  const IS_LOCAL_DEV = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);
  const CDN_BASE = IS_LOCAL_DEV
    ? 'https://www.proton-pulse.com/data'
    : `${location.origin}${SITE_BASE}/data`;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  }

  // --- CDN loaders ---

  async function loadGame(appId) {
    try {
      const r = await fetch(`${CDN_BASE}/${appIdToDir(appId)}/latest.json`);
      if (!r.ok) return [];
      return await r.json();
    } catch { return []; }
  }

  async function loadSearchIndex() {
    try {
      const url = IS_LOCAL_DEV
        ? 'https://www.proton-pulse.com/search-index.json'
        : `${location.origin}${SITE_BASE}/search-index.json`;
      const r = await fetch(url);
      return r.ok ? await r.json() : [];
    } catch { return []; }
  }

  // --- Supabase native reports + configs (best effort, optional) ---

  async function loadPulseReports(appId) {
    try {
      if (!window.protonPulseSupabase) return [];
      const { data } = await window.protonPulseSupabase
        .from('native_reports')
        .select('*')
        .eq('app_id', appId);
      return data || [];
    } catch { return []; }
  }

  async function loadConfigs(appId) {
    try {
      if (!window.protonPulseSupabase) return [];
      const { data } = await window.protonPulseSupabase
        .from('pulse_configs')
        .select('*')
        .eq('app_id', appId);
      return data || [];
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
    const headerImg = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
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
          <img src="${headerImg}" data-appid="${appId}" alt="" onerror="window.__steamImgLoad(this)">
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
    tier: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
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

  // --- tier derivation breakdown ("why this tier") ---

  function renderTierBreakdown(allReports, stats) {
    if (!allReports.length) return '';
    const SCORE = { platinum: 1.0, gold: 0.8, silver: 0.6, bronze: 0.4, borked: 0.0 };
    const TIER_COLORS = { platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0', bronze: '#b07040', borked: '#c85050' };
    const TIER_THRESHOLDS = [
      { tier: 'platinum', min: 0.85 },
      { tier: 'gold', min: 0.65 },
      { tier: 'silver', min: 0.40 },
      { tier: 'bronze', min: 0.15 },
      { tier: 'borked', min: 0.00 },
    ];
    const RECENCY_LABELS = [
      { max: 30, weight: 1.0, label: '<30d' },
      { max: 90, weight: 0.85, label: '30-90d' },
      { max: 180, weight: 0.65, label: '90-180d' },
      { max: 365, weight: 0.40, label: '180d-1y' },
      { max: 730, weight: 0.20, label: '1-2y' },
      { max: 1095, weight: 0.10, label: '2-3y' },
      { max: 1825, weight: 0.05, label: '3-5y' },
      { max: Infinity, weight: 0.02, label: '5y+' },
    ];

    const now = Date.now() / 1000;
    let wSum = 0, wTotal = 0;
    const perReport = [];
    for (const r of allReports) {
      const days = Math.round((now - (r.timestamp || 0)) / 86400);
      const recencyBucket = RECENCY_LABELS.find(b => days < b.max) || RECENCY_LABELS[RECENCY_LABELS.length - 1];
      const score = SCORE[r.rating] ?? 0.5;
      const weighted = score * recencyBucket.weight;
      wSum += weighted;
      wTotal += recencyBucket.weight;
      perReport.push({ rating: r.rating, days, recencyWeight: recencyBucket.weight, score, weighted, recencyLabel: recencyBucket.label });
    }
    const avg = wTotal > 0 ? wSum / wTotal : 0;

    // Per-tier contribution summary
    const tiers = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
    const tierRows = tiers.map(t => {
      const reports = perReport.filter(r => r.rating === t);
      if (!reports.length) return '';
      const tierWeightedSum = reports.reduce((s, r) => s + r.weighted, 0);
      const tierWeightTotal = reports.reduce((s, r) => s + r.recencyWeight, 0);
      return `
        <tr>
          <td><span class="gs-tb-tier" style="color:${TIER_COLORS[t]}">${t.toUpperCase()}</span></td>
          <td class="gs-tb-num">${reports.length}</td>
          <td class="gs-tb-num">${SCORE[t].toFixed(1)}</td>
          <td class="gs-tb-num">${tierWeightTotal.toFixed(2)}</td>
          <td class="gs-tb-num">${tierWeightedSum.toFixed(2)}</td>
        </tr>`;
    }).filter(Boolean).join('');

    // Threshold marker
    const thresholdRows = TIER_THRESHOLDS.map(t => {
      const active = stats.overallTier === t.tier;
      return `<span class="gs-tb-thresh${active ? ' gs-tb-thresh--active' : ''}" style="border-color:${TIER_COLORS[t.tier]}">
        <strong>${t.tier}</strong> &ge; ${t.min}
      </span>`;
    }).join('');

    // Recency weight legend
    const recencyRows = RECENCY_LABELS.map(b => {
      const count = perReport.filter(r => r.recencyLabel === b.label).length;
      if (!count) return '';
      return `<span class="gs-tb-recency">${b.label}: <strong>${b.weight}x</strong> (${count})</span>`;
    }).filter(Boolean).join('');

    // Per-source contribution
    const pdbReports = perReport.filter((_, i) => (allReports[i].source || '').toLowerCase() === 'protondb');
    const pulseReports = perReport.filter((_, i) => (allReports[i].source || '').toLowerCase() !== 'protondb');
    const sourceRows = [];
    if (pdbReports.length) {
      const pdbWSum = pdbReports.reduce((s, r) => s + r.weighted, 0);
      const pdbWTotal = pdbReports.reduce((s, r) => s + r.recencyWeight, 0);
      sourceRows.push(`<span class="gs-tb-source">ProtonDB: <strong>${pdbReports.length}</strong> reports, &Sigma;weighted=${pdbWSum.toFixed(2)}</span>`);
    }
    if (pulseReports.length) {
      const pulseWSum = pulseReports.reduce((s, r) => s + r.weighted, 0);
      const pulseWTotal = pulseReports.reduce((s, r) => s + r.recencyWeight, 0);
      sourceRows.push(`<span class="gs-tb-source">Pulse: <strong>${pulseReports.length}</strong> reports, &Sigma;weighted=${pulseWSum.toFixed(2)}</span>`);
    }
    const sourceSection = sourceRows.length > 1 ? `
      <div class="gs-tb-section">
        <div class="gs-tb-section-title">Per-source contribution</div>
        <div class="gs-tb-recency-row">${sourceRows.join('')}</div>
      </div>` : '';

    return `
      <div class="gs-tier-breakdown">
        <div class="gs-tb-result">
          <span class="gs-tb-result-label">Weighted average:</span>
          <span class="gs-tb-result-value" style="color:${TIER_COLORS[stats.overallTier] || '#7a9bb5'}">${avg.toFixed(3)}</span>
          <span class="gs-tb-result-arrow">&rarr;</span>
          <span class="gs-tb-result-tier" style="color:${TIER_COLORS[stats.overallTier] || '#7a9bb5'}">${(stats.overallTier || 'pending').toUpperCase()}</span>
        </div>
        <table class="gs-tb-table">
          <thead><tr><th>Tier</th><th>Reports</th><th>Score</th><th>&Sigma; Weight</th><th>&Sigma; Weighted</th></tr></thead>
          <tbody>${tierRows}</tbody>
          <tfoot><tr><td colspan="3"><strong>Total</strong></td><td class="gs-tb-num"><strong>${wTotal.toFixed(2)}</strong></td><td class="gs-tb-num"><strong>${wSum.toFixed(2)}</strong></td></tr></tfoot>
        </table>
        ${sourceSection}
        <div class="gs-tb-section">
          <div class="gs-tb-section-title">Tier thresholds</div>
          <div class="gs-tb-thresholds">${thresholdRows}</div>
        </div>
        <div class="gs-tb-section">
          <div class="gs-tb-section-title">Recency weights applied</div>
          <div class="gs-tb-recency-row">${recencyRows}</div>
        </div>
        <p class="gs-tb-explain">
          Each report contributes <code>score &times; recency_weight</code> to the sum.
          The weighted average (<code>&Sigma;weighted / &Sigma;weight</code> = ${wSum.toFixed(2)} / ${wTotal.toFixed(2)} = <strong>${avg.toFixed(3)}</strong>)
          is compared against the tier thresholds above to produce the final rating.
          Recent reports count more; very old reports fade toward zero influence.
          All sources (ProtonDB + Pulse) are weighted identically — source does not affect scoring.
        </p>
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

  // --- assemble everything ---

  // Returns { html, wire }. wire() runs after the html is injected so any
  // chart helpers (hover targets, click-to-filter) can attach to live DOM
  function renderAll(appId, title, stats, counts = {}, allReports = []) {
    // Each section carries an id so it can be deep-linked (e.g. the game page
    // trend line links to #trend). Anchor offset handled by scroll-margin-top
    // in CSS so the sticky-ish header does not cover the section title.
    const sectionHead = (icon, title, id = '') => `<div class="gs-section-head"${id ? ` id="${id}"` : ''}>${icon}<span>${title}</span></div>`;
    const chart = renderChart(stats.monthly);

    const html = `
      ${renderHeader(appId, title, counts)}
      ${sectionHead(ICON.status, 'Current state', 'current-state')}
      ${renderStatusCards(stats)}

      ${sectionHead(ICON.tier, 'Why this tier', 'tier-breakdown')}
      ${renderTierBreakdown(allReports, stats)}

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

      <a class="gs-back" href="app.html#/app/${esc(appId)}">&larr; Back to game page</a>
    `;

    const wire = () => {
      chart.wire();
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

  async function run() {
    const params = new URLSearchParams(location.search);
    const appId = params.get('app');
    if (!appId) {
      root.innerHTML = `<div class="error-state">
        <p>No app id in URL.</p>
        <p style="font-size:0.78rem;margin-top:8px">Expected <code>?app=1091500</code>.</p>
      </div>`;
      return;
    }

    metaEl.textContent = `// app id ${appId} · live computation from CDN + Pulse data`;

    // Pull search index in parallel with CDN + Pulse + live summary so the
    // page can still say something useful when the mirror is empty (#219).
    const [cdnReports, searchIndex, pulseReports, configs, liveSummary] = await Promise.all([
      loadGame(appId),
      loadSearchIndex(),
      loadPulseReports(appId),
      loadConfigs(appId),
      loadProtonDbLive(appId),
    ]);

    // Find the game's title - search index entries are [appId, title, ...] tuples
    let title = `App ${appId}`;
    if (Array.isArray(searchIndex)) {
      const hit = searchIndex.find(row => Array.isArray(row) && String(row[0]) === String(appId));
      if (hit && hit[1]) title = hit[1];
    }

    const allReports = [...cdnReports, ...pulseReports];
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
      root.innerHTML = renderHeader(appId, title, { pulseCount: pulseReports.length, protonDbCount: cdnReports.length, liveTotal: liveSummary?.total || 0 }) + `
        <div class="error-state">
          <p>${liveSummary ? 'No individual reports mirrored yet for this game.' : 'No reports or configs found for this game.'}</p>
          ${liveBlock}
        </div>
      `;
      return;
    }

    const stats = computeGameStats(allReports, configs);

    // Align tier + confidence with the game page: recency-weighted algorithm
    // across ALL reports regardless of source. The live total fills in evidence
    // for reports we haven't mirrored so confidence scales with ProtonDB's real
    // breadth, but the tier itself is always derived from actual report ratings.
    const liveTotal = liveSummary?.total || 0;
    const liveExcess = liveTotal > cdnReports.length ? liveTotal - cdnReports.length : 0;
    const combinedTier = pulseTierFromReports(allReports, liveExcess);
    stats.overallTier = allReports.length > 0
      ? combinedTier.tier
      : (liveSummary?.tier ? String(liveSummary.tier).toLowerCase() : 'pending');
    stats.confidencePct = combinedTier.confidencePct || stats.confidencePct;
    stats.totalReports = allReports.length + Math.max(0, liveTotal - cdnReports.length);
    stats.confidenceBucket = stats.confidencePct >= 80 ? 'high'
      : stats.confidencePct >= 50 ? 'moderate' : 'low';

    // Pull viewer hardware (real or Steam Deck preview fallback) so the
    // page can both surface the banner and feed personalised match scoring
    // into future sections (#74 will lean on this)
    const myHw = typeof loadMyHardware === 'function' ? loadMyHardware() : null;
    const previewBanner = (myHw && isPreviewHardware(myHw))
      ? renderPreviewHardwareBanner() : '';

    const { html, wire } = renderAll(appId, title, stats, {
      pulseCount: pulseReports.length,
      protonDbCount: cdnReports.length,
      liveTotal: liveSummary?.total || 0,
    }, allReports);
    root.innerHTML = previewBanner + html;
    // wire() must run AFTER innerHTML so the hover helper sees real DOM rects.
    // Also surface the filter event for future consumers (a debug log for now)
    wire();
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
    root.innerHTML = `<div class="error-state">Stats failed to load: ${esc(err && err.message || err)}</div>`;
  });
})();
