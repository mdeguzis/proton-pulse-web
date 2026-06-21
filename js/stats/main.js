// Entry module for stats.html. Orchestrates data fetch, filter state, and
// chart rendering by delegating to utils, filters, and charts modules.

import { FILTER_DIMS, dimDef, label, fmt } from './utils.js?v=ceb23379';
import {
  applyFilter, getFilter, getOpenDropdown, setOpenDropdown,
  renderDropdownButton, toggleFilterValue, clearFilter,
  setFilterChangeCallback, restoreFilterFromUrl,
} from './filters.js?v=bfe27ee2';
import {
  renderBars, renderFreshness, renderFramegen, renderDonut,
  renderSparkline, renderTopGames, renderRatingsTrend,
} from './charts.js?v=f5fe3e5f';

const root = document.getElementById('stats-root');
const metaEl = document.getElementById('stats-meta');

let stats = null;        // raw stats.json payload
let coverage = null;     // coverage-summary.json (Steam catalog / ProtonDB totals)

// Wire filter changes to trigger a full re-render
setFilterChangeCallback(() => renderAll());

// Build the page skeleton + populate. Re-runs when the filter changes.
function renderAll() {
  const filter = getFilter();
  const data = applyFilter(stats);
  if (!data) return;

  // Top numbers strip
  const totalReports = stats.total_reports || 0;
  const totalGames = stats.total_games || 0;
  const platinum = stats.by_rating?.platinum || 0;
  const platinumPct = totalReports ? (platinum / totalReports * 100).toFixed(1) : '0';
  const borked = stats.by_rating?.borked || 0;
  const borkedPct = totalReports ? (borked / totalReports * 100).toFixed(1) : '0';
  const pulseCount = stats.by_source?.pulse || 0;
  // Coverage numbers come from coverage-summary.json
  const steamGames = coverage?.steam_games || null;
  const protondbGames = coverage?.protondb_games || null;
  const pctOfSteam = coverage?.pct_of_steam ?? null;
  const pctOfProtondb = coverage?.pct_of_protondb ?? null;

  // Pre-render the layout once, then bind dynamic regions
  root.innerHTML = `
    <div class="stat-strip">
      <div class="stat-tile">
        <div class="label">Total reports</div>
        <div class="value">${fmt(totalReports)}</div>
        <div class="detail">across <strong>${fmt(totalGames)}</strong> games</div>
      </div>
      <div class="stat-tile" title="Share of the full Steam catalog (~${fmt(steamGames)} games) we have compatibility data for">
        <div class="label">Of Steam catalog</div>
        <div class="value">${pctOfSteam != null ? pctOfSteam.toFixed(1) : '—'}<span style="font-size:0.7em;color:var(--muted);margin-left:2px">%</span></div>
        <div class="detail">${steamGames ? `<strong>${fmt(totalGames)}</strong> of <strong>${fmt(steamGames)}</strong> Steam games` : 'awaiting next pipeline run'}</div>
      </div>
      <div class="stat-tile" title="Share of games on ProtonDB that have local mirror data">
        <div class="label">Of ProtonDB</div>
        <div class="value">${pctOfProtondb != null ? pctOfProtondb.toFixed(1) : '—'}<span style="font-size:0.7em;color:var(--muted);margin-left:2px">%</span></div>
        <div class="detail">${protondbGames ? `<strong>${fmt(totalGames)}</strong> of <strong>${fmt(protondbGames)}</strong> on ProtonDB` : 'awaiting next pipeline run'}</div>
      </div>
      <div class="stat-tile">
        <div class="label">Platinum rate</div>
        <div class="value">${platinumPct}<span style="font-size:0.7em;color:var(--muted);margin-left:2px">%</span></div>
        <div class="detail">${fmt(platinum)} platinum reports</div>
      </div>
      <div class="stat-tile">
        <div class="label">Borked rate</div>
        <div class="value">${borkedPct}<span style="font-size:0.7em;color:var(--muted);margin-left:2px">%</span></div>
        <div class="detail">${fmt(borked)} broken reports</div>
      </div>
      <div class="stat-tile">
        <div class="label">Pulse Reports</div>
        <div class="value">${fmt(pulseCount)}</div>
        <div class="detail">community-submitted via plugin/web</div>
      </div>
    </div>

    <div class="filter-row" id="filter-row">
      <span class="label">Filter:</span>
      ${FILTER_DIMS.map(d => renderDropdownButton(d, stats)).join('')}
      <span class="filter-status" id="filter-status"></span>
    </div>

    <div class="chart-grid">
      <div class="chart-card">
        <h3>Ratings ${filter.dim ? '(filtered)' : ''}</h3>
        <div class="bars" id="chart-rating"></div>
      </div>

      <div class="chart-card donut-card">
        <h3 style="width:100%">Source split</h3>
        <div class="donut" id="donut" style="--pulse-pct: 0%"></div>
        <div class="donut-legend" id="donut-legend"></div>
      </div>

      <div class="chart-card">
        <h3>GPU vendor</h3>
        <div class="bars" id="chart-gpu"></div>
      </div>
      <div class="chart-card">
        <h3>CPU brand</h3>
        <div class="bars" id="chart-cpu"></div>
      </div>

      <div class="chart-card">
        <h3>OS family (top 10)</h3>
        <div class="bars" id="chart-os"></div>
      </div>
      <div class="chart-card">
        <h3>Proton type</h3>
        <div class="bars" id="chart-proton"></div>
      </div>

      <div class="chart-card">
        <h3>Device family</h3>
        <div class="bars" id="chart-device"></div>
      </div>
      <div class="chart-card">
        <h3>Report freshness</h3>
        <p class="fg-card-hint">How recent are the reports? Older data is less reliable since Proton compatibility keeps improving.</p>
        <div class="bars" id="chart-freshness"></div>
      </div>
    </div>

    <h2>Frame generation usage</h2>
    <p class="meta">// Only counts reports that explicitly answered yes/no. Legacy ProtonDB reports never had the question, so the sample skews toward Pulse submissions.</p>
    <div id="framegen-section"></div>

    <h2>Reports over time</h2>
    <div class="chart-card sparkline-card" id="sparkline-card">
      <div class="sparkline-wrap" id="sparkline-wrap">
        <svg id="sparkline" viewBox="0 0 500 180" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="sparkline-tooltip" id="sparkline-tooltip"></div>
      </div>
      <div class="axis" id="sparkline-axis"></div>
    </div>

    <h2>How ratings have shifted over time</h2>
    <p class="meta">// % of reports per year by rating. Newer Proton versions tend to lift more games into Gold and Platinum.</p>
    <div class="chart-card sparkline-card" id="ratings-trend-card">
      <div class="sparkline-wrap" id="ratings-trend-wrap">
        <svg id="ratings-trend" viewBox="0 0 500 200" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="sparkline-tooltip" id="ratings-trend-tooltip"></div>
      </div>
      <div class="axis" id="ratings-trend-axis"></div>
      <div class="trend-legend" id="ratings-trend-legend"></div>
    </div>

    ${stats.stale_borked_count > 0 ? (() => {
      const sinceYear = stats.stale_borked_cutoff_year ? stats.stale_borked_cutoff_year + 1 : null;
      const sinceLabel = sinceYear ? `<strong>${sinceYear}</strong> or later` : '<strong>—</strong>';
      return `
    <div class="retest-callout">
      <div class="retest-headline">
        <strong>${fmt(stats.stale_borked_count)}</strong> games are rated <span class="retest-borked">borked</span>
        but have no report from ${sinceLabel}
      </div>
      <div class="retest-sub">Proton has come a long way. Many of these probably work now - if you own one, a fresh report would help.</div>
    </div>
    <h2>Worth re-testing</h2>
    <p class="meta">// Top borked games by report volume with no report from ${sinceLabel}.</p>
    <div class="topgames" id="retesting"></div>
    `;
    })() : ''}

    <h2>Top games by report volume</h2>
    <div class="topgames" id="topgames"></div>
  `;

  // Bind chart contents to data
  renderBars(document.getElementById('chart-rating'),
    data.rating, { attr: 'data-rating', filterDim: 'rating' });
  renderBars(document.getElementById('chart-gpu'),
    data.gpu, { attr: 'data-key', filterDim: 'gpu' });
  renderBars(document.getElementById('chart-cpu'),
    data.cpu, { attr: 'data-key', filterDim: 'cpu' });
  renderBars(document.getElementById('chart-os'),
    data.os, { limit: 10, filterDim: 'os' });
  renderBars(document.getElementById('chart-proton'),
    data.proton, { limit: 10 });
  renderBars(document.getElementById('chart-device'),
    data.device, { filterDim: 'device' });

  // Report freshness: always uses unfiltered by_year totals
  renderFreshness(stats.by_year || {});

  // Source donut (uses unfiltered split intentionally)
  renderDonut(stats.by_source || {});

  // Frame generation usage section
  renderFramegen(stats);

  // Year sparkline (also uses unfiltered data)
  renderSparkline(stats.by_year || {}, stats.by_year_source || {});
  // Re-render the sparkline on window resize so the chart width tracks the
  // container. Debounce so we don't thrash during a drag-resize.
  if (!window._sparklineResizeWired) {
    window._sparklineResizeWired = true;
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!stats) return;
        renderSparkline(stats.by_year || {}, stats.by_year_source || {});
        renderRatingsTrend(stats.by_year_rating || {});
      }, 150);
    });
  }

  // Top games (unfiltered)
  renderTopGames(stats.top_games || []);
  if (stats.stale_borked_count > 0) {
    renderTopGames(stats.worth_retesting || [], document.getElementById('retesting'));
  }
  renderRatingsTrend(stats.by_year_rating || {});

  // Update filter status line
  const status = document.getElementById('filter-status');
  if (status && filter.dim && filter.values.size > 0) {
    const def = dimDef(filter.dim);
    const valueList = Array.from(filter.values).map(v => label(v)).join(', ');
    status.innerHTML = `Filtered: <strong>${def ? def.label : filter.dim}</strong> = ${valueList} &middot; ${fmt(data.total)} reports <a href="#" id="clear-filter">clear all</a>`;
    status.querySelector('#clear-filter')?.addEventListener('click', e => {
      e.preventDefault();
      clearFilter();
    });
  }

  // Wire dropdown toggle buttons
  document.querySelectorAll('[data-dropdown-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dim = btn.getAttribute('data-dropdown-toggle');
      setOpenDropdown(getOpenDropdown() === dim ? null : dim);
      renderAll();
    });
  });

  // Wire checkbox changes inside dropdown panels
  document.querySelectorAll('input[data-dropdown-dim]').forEach(cb => {
    cb.addEventListener('change', () => {
      const dim = cb.getAttribute('data-dropdown-dim');
      const value = cb.getAttribute('data-dropdown-value');
      toggleFilterValue(dim, value);
    });
  });

  // Wire per-dim clear links inside dropdown panels
  document.querySelectorAll('[data-filter-clear-dim]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dim = a.getAttribute('data-filter-clear-dim');
      if (filter.dim === dim) clearFilter();
    });
  });

  // Wire legacy data-filter-dim/value chip clicks (bar rows, legend chips,
  // source donut legend, ratings-trend tier swatches)
  document.querySelectorAll('[data-filter-dim]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (el.closest('[data-dropdown-id]')) return;
      const dim = el.getAttribute('data-filter-dim');
      const value = el.getAttribute('data-filter-value');
      if (!dim || !value) {
        clearFilter();
      } else {
        toggleFilterValue(dim, value);
      }
    });
  });

  // Click outside any open dropdown panel closes it
  if (getOpenDropdown()) {
    const closer = (e) => {
      if (!e.target.closest('[data-dropdown-id]')) {
        setOpenDropdown(null);
        document.removeEventListener('click', closer);
        renderAll();
      }
    };
    queueMicrotask(() => document.addEventListener('click', closer));
  }
}

// Restore filter from URL on load
restoreFilterFromUrl();

// Fetch stats.json (required) and coverage-summary.json (optional) in parallel
Promise.all([
  fetch('stats.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(r.status)),
  fetch('coverage-summary.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
])
  .then(([statsPayload, coveragePayload]) => {
    stats = statsPayload;
    coverage = coveragePayload;
    metaEl.textContent = `// Generated: ${stats.generated_at || 'unknown'} - ${fmt(stats.total_reports)} reports across ${fmt(stats.total_games)} games`;
    renderAll();
  })
  .catch(err => {
    root.innerHTML = `<div class="error-state">
      <p>Stats not available (${err}).</p>
      <p style="margin-top:8px;font-size:0.74rem">stats.json is built by the data pipeline. If you're in local dev,
      the next deployment will populate it.</p>
    </div>`;
    metaEl.textContent = `// stats.json fetch failed`;
  });
