// Entry module for stats.html. Migrated from the page's classic stats.js
// script. Self-contained: no cross-module imports, all helpers are local.
(function () {
  const root = document.getElementById('stats-root');
  const metaEl = document.getElementById('stats-meta');

  let stats = null;        // raw stats.json payload
  let coverage = null;     // coverage-summary.json (Steam catalog / ProtonDB totals)
  // Active filter. Only one dim active at a time (because the cross-tabs
  // we ship only key off one dim), but multiple values within that dim.
  // values is a Set for cheap toggle/has checks.
  let filter = { dim: null, values: new Set() };

  // Which dropdown is currently open (id from FILTER_DIMS). null = none.
  let openDropdown = null;

  // Definition of every filter dimension: order shown in the UI, the cross-tab
  // key in stats.json, and a label for the dropdown button. Rating is included
  // since clicking a rating bar or trend-chart swatch sets dim='rating'.
  const FILTER_DIMS = [
    { id: 'gpu',    label: 'GPU',     statsKey: 'by_gpu_vendor',     crossKey: 'by_rating_x_gpu_vendor' },
    { id: 'cpu',    label: 'CPU',     statsKey: 'by_cpu_brand',      crossKey: 'by_rating_x_cpu_brand' },
    { id: 'os',     label: 'OS',      statsKey: 'by_os_family',      crossKey: 'by_rating_x_os_family' },
    { id: 'device', label: 'Device',  statsKey: 'by_device_family',  crossKey: 'by_rating_x_device_family' },
    { id: 'source', label: 'Source',  statsKey: 'by_source',         crossKey: 'by_rating_x_source' },
    { id: 'rating', label: 'Rating',  statsKey: 'by_rating',         crossKey: null },
  ];
  function dimDef(id) { return FILTER_DIMS.find(d => d.id === id) || null; }

  // Cosmetic labels for normalized tokens. Falls back to titlecase otherwise.
  const PRETTY = {
    amd: 'AMD', nvidia: 'NVIDIA', intel: 'Intel',
    other: 'Other', unknown: 'Unknown',
    steamos: 'SteamOS', bazzite: 'Bazzite', arch: 'Arch / derivatives',
    fedora: 'Fedora / derivatives', ubuntu: 'Ubuntu / derivatives',
    debian: 'Debian / derivatives', opensuse: 'openSUSE',
    nixos: 'NixOS', gentoo: 'Gentoo',
    'ge-proton': 'GE-Proton', 'proton-experimental': 'Proton Experimental',
    'proton-stable': 'Proton (stable)', 'proton-hotfix': 'Proton Hotfix',
    'proton-tkg': 'Proton-TKG', 'proton-next': 'Proton Next',
    'steam-linux-runtime': 'Steam Linux Runtime',
    native: 'Native',
    protondb: 'ProtonDB', pulse: 'Pulse',
    'steam-deck-lcd': 'Steam Deck LCD',
    'steam-deck-oled': 'Steam Deck OLED',
    desktop: 'Desktop / other',
    platinum: 'Platinum', gold: 'Gold', silver: 'Silver',
    bronze: 'Bronze', borked: 'Borked', pending: 'Pending',
  };
  function label(token) {
    return PRETTY[token] || (token.charAt(0).toUpperCase() + token.slice(1));
  }
  function fmt(n) { return (n || 0).toLocaleString(); }

  // The cross-tab payload is { dimValue: { rating: count, ... } }.
  // To pivot to "ratings given dim=value" we just read cross[value].
  // To pivot the OTHER way ("dim values given rating=X") we sum across.
  function pivotRatingByDim(cross, dimValue) {
    return cross[dimValue] || {};
  }
  // Sum across rating values to get the dim totals (after filtering by rating)
  function pivotDimByRating(cross, ratingValue) {
    const out = {};
    for (const [dim, bucket] of Object.entries(cross)) {
      out[dim] = bucket[ratingValue] || 0;
    }
    return out;
  }

  // Reduce stats to the buckets the page renders, applying the active filter
  // Returns { rating, gpu, cpu, os, source, proton, device, total } each as
  // { token: count }
  function applyFilter() {
    if (!stats) return null;

    const noFilter = !filter.dim || filter.values.size === 0;
    if (noFilter) {
      return {
        rating: stats.by_rating || {},
        gpu:    stats.by_gpu_vendor || {},
        cpu:    stats.by_cpu_brand || {},
        os:     stats.by_os_family || {},
        proton: stats.by_proton_type || {},
        source: stats.by_source || {},
        device: stats.by_device_family || {},
        total:  stats.total_reports || 0,
      };
    }

    // Filtered: cross-tabs let us pivot rating-by-dim or dim-by-rating.
    // For multi-value within a dim, sum across the selected values.
    const out = {
      rating: {}, gpu: {}, cpu: {}, os: {}, proton: {}, source: {}, device: {},
      total: 0,
    };
    const vals = Array.from(filter.values);

    if (filter.dim === 'rating') {
      // Filtering by rating(s): for each dim, sum dim counts across selected ratings
      const sumByRating = (crossKey) => {
        const cross = stats[crossKey] || {};
        const acc = {};
        for (const [dim, bucket] of Object.entries(cross)) {
          let n = 0;
          for (const r of vals) n += bucket[r] || 0;
          acc[dim] = n;
        }
        return acc;
      };
      out.gpu    = sumByRating('by_rating_x_gpu_vendor');
      out.cpu    = sumByRating('by_rating_x_cpu_brand');
      out.os     = sumByRating('by_rating_x_os_family');
      out.source = sumByRating('by_rating_x_source');
      out.device = sumByRating('by_rating_x_device_family');
      // Rating bucket shows only the selected ratings' counts
      for (const r of vals) {
        out.rating[r] = stats.by_rating?.[r] || 0;
      }
      out.total = sum(out.rating);
      return out;
    }

    // Other dims: rating comes from the cross-tab summed across selected values
    const def = dimDef(filter.dim);
    if (!def || !def.crossKey) return out;
    const cross = stats[def.crossKey] || {};
    for (const v of vals) {
      const bucket = cross[v] || {};
      for (const [rating, n] of Object.entries(bucket)) {
        out.rating[rating] = (out.rating[rating] || 0) + n;
      }
    }
    // Echo back which values are active on the filtered dim's own chart
    const selfBucket = stats[def.statsKey] || {};
    out[filter.dim] = Object.fromEntries(vals.map(v => [v, selfBucket[v] || 0]));
    out.total = sum(out.rating);
    return out;
  }
  function sum(obj) {
    return Object.values(obj).reduce((a, b) => a + (b || 0), 0);
  }

  // Render N horizontal bar rows sorted descending by count.
  // dataAttr is the data-* attribute name (rating, key) for per-row tinting.
  function renderBars(container, buckets, opts = {}) {
    const entries = Object.entries(buckets).filter(([k, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      container.innerHTML = '<div class="loading-state" style="padding:20px">No data for current filter</div>';
      return;
    }
    const max = Math.max(...entries.map(([, v]) => v));
    const limit = opts.limit || entries.length;
    container.innerHTML = entries.slice(0, limit).map(([token, count]) => {
      const pct = max ? (count / max * 100).toFixed(1) : 0;
      const attrs = opts.attr ? `${opts.attr}="${token}"` : '';
      const chipDim = opts.filterDim;
      const onClick = chipDim ? ` data-filter-dim="${chipDim}" data-filter-value="${token}" style="cursor:pointer"` : '';
      const niceLabel = label(token);
      // native title tooltip so the full text shows on hover when ellipsis truncates
      const rowTitle = `${niceLabel}: ${fmt(count)} reports${chipDim ? ' (click to filter)' : ''}`;
      return `<div class="bar-row" ${attrs}${onClick} title="${rowTitle}">
        <span class="name" title="${niceLabel}">${niceLabel}</span>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div>
        <span class="count">${fmt(count)}</span>
      </div>`;
    }).join('');
  }

  // Build the page skeleton + populate. Re-runs when the filter changes.
  function renderAll() {
    const data = applyFilter();
    if (!data) return;

    // ── Top numbers strip ──
    const totalReports = stats.total_reports || 0;
    const totalGames = stats.total_games || 0;
    const platinum = stats.by_rating?.platinum || 0;
    const platinumPct = totalReports ? (platinum / totalReports * 100).toFixed(1) : '0';
    const borked = stats.by_rating?.borked || 0;
    const borkedPct = totalReports ? (borked / totalReports * 100).toFixed(1) : '0';
    const pulseCount = stats.by_source?.pulse || 0;
    // Coverage numbers come from coverage-summary.json. Falls back to em-dash
    // placeholders if not loaded yet (older deploys, or fetch failed).
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
        ${FILTER_DIMS.map(d => renderDropdownButton(d)).join('')}
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
        // "since YEAR or later" reads more naturally than "since YEAR or earlier"
        // for a recency callout. cutoff = current_year - 2, so "no report in
        // cutoff+1 or later" is the actual condition.
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

    // ── Bind chart contents to data ──
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

    // Report freshness: bucket by_year totals into age windows. Always uses
    // the unfiltered by_year totals because the cross-tabs don't include year
    renderFreshness(stats.by_year || {});

    // Source donut (uses unfiltered split intentionally; filtering by source
    // would just collapse it to one slice)
    renderDonut(stats.by_source || {});

    // Frame generation usage section. Always renders, even if there are no
    // responses yet, so the empty-state messaging tells visitors what the
    // section will show once data accumulates
    renderFramegen(stats);

    // Year sparkline (also uses unfiltered data since cross-tabs by year
    // would be a big payload)
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
    // Render the new "worth re-testing" leaderboard (only if there are any).
    // Uses the same renderer as topgames but linked to data-index detail view.
    if (stats.stale_borked_count > 0) {
      renderTopGames(stats.worth_retesting || [], document.getElementById('retesting'));
    }
    renderRatingsTrend(stats.by_year_rating || {});

    // Update filter status line. Shows pretty-named values + total reports
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
        openDropdown = (openDropdown === dim) ? null : dim;
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

    // Wire legacy data-filter-dim/value chip clicks (still used by bar rows,
    // legend chips, source donut legend, ratings-trend tier swatches). These
    // are single-value sources; clicking them feeds into the toggle path so
    // user can click a bar to add that value to the active filter
    document.querySelectorAll('[data-filter-dim]').forEach(el => {
      el.addEventListener('click', (e) => {
        // Skip elements that are inside a dropdown panel (those use the new wiring)
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

    // Click outside any open dropdown panel closes it. Wire once per renderAll,
    // and clean up on the next render. capturing=false so dropdown internal
    // clicks (stopPropagation'd above) don't trigger this
    if (openDropdown) {
      const closer = (e) => {
        if (!e.target.closest('[data-dropdown-id]')) {
          openDropdown = null;
          document.removeEventListener('click', closer);
          renderAll();
        }
      };
      // queueMicrotask so the current click event finishes before binding
      queueMicrotask(() => document.addEventListener('click', closer));
    }
  }

  // Render one dropdown button + its (initially hidden) panel of checkboxes.
  // Options come from the dim's single-dim counter in stats.json, sorted by
  // count desc so the most-common values float to the top of each panel.
  function renderDropdownButton(d) {
    const isOpen = openDropdown === d.id;
    const activeValues = (filter.dim === d.id) ? filter.values : new Set();
    const activeCount = activeValues.size;
    const buckets = stats?.[d.statsKey] || {};
    // Sort options by count desc - typical "Most popular first" UX
    const options = Object.entries(buckets)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    if (!options.length) return '';

    const checkboxes = options.map(([token, count]) => {
      const checked = activeValues.has(token);
      const niceLabel = label(token);
      return `<label class="filter-check ${checked ? 'is-checked' : ''}">
        <input type="checkbox" data-dropdown-dim="${d.id}" data-dropdown-value="${token}" ${checked ? 'checked' : ''}>
        <span class="filter-check-label">${niceLabel}</span>
        <span class="filter-check-count">${fmt(count)}</span>
      </label>`;
    }).join('');

    const buttonLabel = activeCount > 0
      ? `${d.label} <span class="filter-btn-badge">${activeCount}</span>`
      : d.label;
    const summaryLine = activeCount > 0
      ? `<div class="filter-panel-summary">${activeCount} selected. <a href="#" data-filter-clear-dim="${d.id}">clear</a></div>`
      : '';

    return `<div class="filter-dropdown ${isOpen ? 'is-open' : ''}" data-dropdown-id="${d.id}">
      <button class="filter-button ${activeCount > 0 ? 'is-active' : ''}" data-dropdown-toggle="${d.id}">
        ${buttonLabel}
        <span class="filter-caret">${isOpen ? '▲' : '▾'}</span>
      </button>
      <div class="filter-panel">
        ${summaryLine}
        ${checkboxes}
      </div>
    </div>`;
  }

  // Apply a checkbox toggle. If user clicks a value in a different dim than
  // the current filter, replace the filter (since cross-tabs only let us
  // filter one dim at a time). Keeps the same dim's other selected values.
  function toggleFilterValue(dim, value) {
    if (filter.dim && filter.dim !== dim) {
      filter = { dim, values: new Set([value]) };
    } else {
      filter.dim = dim;
      if (filter.values.has(value)) {
        filter.values.delete(value);
        if (filter.values.size === 0) filter.dim = null;
      } else {
        filter.values.add(value);
      }
    }
    pushFilterToUrl();
    renderAll();
  }

  function clearFilter() {
    filter = { dim: null, values: new Set() };
    pushFilterToUrl();
    renderAll();
  }

  // Reflect filter state in URL so links survive copy/paste.
  // ?dim=gpu&values=amd,nvidia
  function pushFilterToUrl() {
    const url = new URL(location.href);
    url.search = '';
    if (filter.dim && filter.values.size > 0) {
      url.searchParams.set('dim', filter.dim);
      url.searchParams.set('values', Array.from(filter.values).join(','));
    }
    history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
  }

  // Bucket by_year totals into age windows so the page can show "X% of reports
  // are from the past 12 months" without baking the buckets into stats.json.
  // Uses current_year derived from the data itself (not Date.now()) so the
  // chart stays stable even if the user's clock is wrong.
  function renderFreshness(byYear) {
    const container = document.getElementById('chart-freshness');
    if (!container) return;
    const years = Object.keys(byYear).filter(y => /^\d{4}$/.test(y)).map(Number);
    if (!years.length) {
      container.innerHTML = '<div class="loading-state" style="padding:20px">No year data</div>';
      return;
    }
    const current = Math.max(...years);
    const buckets = {
      'past-year':    { label: 'Past 12 months',  range: y => y >= current },
      'one-to-two':   { label: '1-2 years old',   range: y => y === current - 1 },
      'two-to-five':  { label: '2-5 years old',   range: y => y >= current - 4 && y <= current - 2 },
      'older':        { label: '5+ years old',    range: y => y < current - 4 },
    };
    const counts = {};
    for (const [key, b] of Object.entries(buckets)) {
      counts[key] = 0;
      for (const y of years) {
        if (b.range(y)) counts[key] += byYear[String(y)] || 0;
      }
    }
    // Custom bar render since the existing renderBars uses the PRETTY map for
    // labels; freshness keys aren't in there. Build inline with the same DOM
    // shape so the existing .bar-row CSS picks it up
    const max = Math.max(...Object.values(counts), 1);
    container.innerHTML = Object.entries(buckets).map(([key, b]) => {
      const n = counts[key] || 0;
      const pct = (n / max * 100).toFixed(1);
      return `<div class="bar-row" title="${b.label}: ${fmt(n)} reports">
        <span class="name" title="${b.label}">${b.label}</span>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div>
        <span class="count">${fmt(n)}</span>
      </div>`;
    }).join('');
  }

  // Render the framegen section: headline rate + 4 cross-tab cards + top-games leaderboard.
  // Cross-tab data shape is { dimValue: { yes: N, no: N } }. For each dim we
  // render a "yes %" bar so the bar fill itself tells the story (Deck = mostly
  // full, high-VRAM = mostly empty)
  function renderFramegen(s) {
    const host = document.getElementById('framegen-section');
    if (!host) return;
    const total = s.framegen_total_responses || 0;
    const yes = s.framegen_yes_count || 0;
    const yesRate = s.framegen_yes_rate_pct;

    if (!total) {
      host.innerHTML = `<div class="chart-card" style="padding:24px"><div class="loading-state" style="padding:8px">No framegen responses yet. Submit a report to start filling this in.</div></div>`;
      return;
    }

    // PRETTY map already covers steam-deck-lcd/oled, amd/nvidia/intel, rating
    // tiers, etc. VRAM buckets are framegen-specific so they need labels here
    const VRAM_PRETTY = {
      low:     'Low VRAM (<4 GB)',
      mid:     'Mid VRAM (4-8 GB)',
      high:    'High VRAM (8 GB+)',
      unknown: 'Unknown',
    };
    function vramLabel(k) { return VRAM_PRETTY[k] || label(k); }

    host.innerHTML = `
      <div class="framegen-headline">
        <div class="fg-rate">
          <div class="fg-rate-value">${(yesRate || 0).toFixed(1)}<span class="fg-pct">%</span></div>
          <div class="fg-rate-caption">of ${fmt(total)} responses said framegen was required for smooth play</div>
        </div>
        <div class="fg-sub">
          <strong>${fmt(yes)}</strong> yes &nbsp;|&nbsp; <strong>${fmt(total - yes)}</strong> no
        </div>
      </div>

      <div class="chart-grid">
        <div class="chart-card">
          <h3>By device family</h3>
          <p class="fg-card-hint">Steam Deck leans on framegen way more than desktop. Same chips, smaller power budget.</p>
          <div class="bars" id="fg-by-device"></div>
        </div>
        <div class="chart-card">
          <h3>By GPU vendor</h3>
          <p class="fg-card-hint">AMD's rate skews high because every Steam Deck counts in this bucket.</p>
          <div class="bars" id="fg-by-gpu"></div>
        </div>
        <div class="chart-card">
          <h3>By VRAM tier</h3>
          <p class="fg-card-hint">Best proxy for "low-end hardware" - smaller frame buffers correlate strongly with needing framegen.</p>
          <div class="bars" id="fg-by-vram"></div>
        </div>
        <div class="chart-card">
          <h3>By rating</h3>
          <p class="fg-card-hint">Bronze/Silver games rely on framegen most. Platinum titles rarely need it.</p>
          <div class="bars" id="fg-by-rating"></div>
        </div>
      </div>

      <h3 class="fg-sub-h">Top games needing framegen</h3>
      <p class="meta">// Sorted by yes% (min 3 responses). Useful for spotting which titles users lean on FSR/LSFG/DLSS-G to keep playable. A high rate can mean genuinely demanding hardware - but often it just means the game ships poorly optimized and players reach for upscalers to compensate.</p>
      <div class="topgames" id="fg-topgames"></div>
    `;

    renderFramegenBars(document.getElementById('fg-by-device'),
      s.by_device_x_framegen || {}, label, 'device');
    renderFramegenBars(document.getElementById('fg-by-gpu'),
      s.by_gpu_x_framegen || {}, label, 'key');
    renderFramegenBars(document.getElementById('fg-by-vram'),
      s.by_vram_x_framegen || {}, vramLabel, 'vram');
    renderFramegenBars(document.getElementById('fg-by-rating'),
      s.by_rating_x_framegen || {}, label, 'rating');

    renderFramegenTopGames(s.top_games_needing_framegen || []);
  }

  // Render yes/no bars where the fill is the yes% per category.
  // labelFn(token) -> display label. attrName is the data-* attr used by
  // CSS to color the row (data-key for gpu, data-rating for rating, etc.)
  function renderFramegenBars(container, cross, labelFn, attrName) {
    const rows = Object.entries(cross)
      .map(([k, bucket]) => {
        const y = bucket.yes || 0;
        const n = bucket.no || 0;
        const total = y + n;
        return { key: k, yes: y, no: n, total, pct: total ? (y / total * 100) : 0 };
      })
      .filter(r => r.total > 0)
      .sort((a, b) => b.pct - a.pct);

    if (!rows.length) {
      container.innerHTML = '<div class="loading-state" style="padding:20px">No framegen data in this slice</div>';
      return;
    }

    container.innerHTML = rows.map(r => {
      const niceLabel = labelFn(r.key);
      const attrs = attrName ? ` data-${attrName}="${r.key}"` : '';
      const title = `${niceLabel}: ${r.yes} yes / ${r.no} no (${r.pct.toFixed(1)}% required framegen)`;
      return `<div class="bar-row fg-bar"${attrs} title="${title}">
        <span class="name" title="${niceLabel}">${niceLabel}</span>
        <div class="track"><div class="fill fg-fill" style="width:${r.pct.toFixed(1)}%"></div></div>
        <span class="count fg-count">${r.pct.toFixed(0)}<span class="fg-count-pct">%</span> <span class="fg-count-n">(${fmt(r.total)})</span></span>
      </div>`;
    }).join('');
  }

  // Custom topgames renderer for the framegen leaderboard. Tuple shape is
  // [appId, title, yes_count, total_responses, yes_pct]
  function renderFramegenTopGames(rows) {
    const container = document.getElementById('fg-topgames');
    if (!container) return;
    if (!rows.length) {
      container.innerHTML = '<div class="loading-state" style="padding:20px">No games with enough framegen reports yet.</div>';
      return;
    }
    container.innerHTML = rows.map((row, i) => {
      const [appId, title, yes, total, pct] = row;
      const rank = String(i + 1).padStart(2, '0');
      // link to the data-index detail view so visitors can pull up the actual reports
      return `<a href="data-index.html#/${appId}">
        <span class="rank">${rank}</span>
        <span class="title">${title || `(no title)`} <span class="appid">#${appId}</span></span>
        <span class="fg-pct-badge">${(pct || 0).toFixed(0)}%</span>
        <span class="count">${fmt(yes)} / ${fmt(total)}</span>
      </a>`;
    }).join('');
  }

  function renderDonut(bySource) {
    const protondb = bySource.protondb || 0;
    const pulse = bySource.pulse || 0;
    const total = protondb + pulse;
    const pulsePct = total ? (pulse / total * 100) : 0;
    const protondbPct = total ? (protondb / total * 100) : 0;
    const donut = document.getElementById('donut');
    if (donut) donut.style.setProperty('--pulse-pct', `${pulsePct}%`);
    const legend = document.getElementById('donut-legend');
    if (legend) {
      const isFilterProtondb = filter.dim === 'source' && filter.values.has('protondb');
      const isFilterPulse = filter.dim === 'source' && filter.values.has('pulse');
      // legend rows act as filter chips for source. clicking a row toggles
      // the source filter on/off; the global delegated click handler in
      // renderAll catches the data-filter-* attributes.
      legend.innerHTML = `
        <div class="row ${isFilterProtondb ? 'is-active' : ''}" data-filter-dim="source" data-filter-value="protondb" title="Click to filter by ProtonDB source">
          <span class="swatch protondb"></span>
          <span class="name">ProtonDB</span>
          <span class="count">${fmt(protondb)}<span class="pct"> (${protondbPct.toFixed(1)}%)</span></span>
        </div>
        <div class="row ${isFilterPulse ? 'is-active' : ''}" data-filter-dim="source" data-filter-value="pulse" title="Click to filter by Pulse source">
          <span class="swatch pulse"></span>
          <span class="name">Pulse</span>
          <span class="count">${fmt(pulse)}<span class="pct"> (${pulsePct.toFixed(1)}%)</span></span>
        </div>
      `;
    }
  }

  // Two-series sparkline: ProtonDB + Pulse, with Y-axis gridlines and hover tooltip
  function renderSparkline(byYear, byYearSource) {
    const years = Object.keys(byYear).filter(y => /^\d{4}$/.test(y)).sort();
    if (years.length < 2) {
      const svg = document.getElementById('sparkline');
      if (svg) svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--muted)" font-family="var(--mono)" font-size="12">not enough year data</text>';
      return;
    }
    const maxRaw = Math.max(...years.map(y => byYear[y] || 0));
    // Round the Y axis ceiling up to a "nice" number so the gridline labels read
    // cleanly (10K, 20K, etc.) instead of weird values like 47823
    const niceMax = niceCeil(maxRaw);

    // Chart geometry. Width derived from the wrap container so the chart
    // actually fills available horizontal space on wide screens. A fixed
    // viewBox + preserveAspectRatio would stretch text on ultrawide
    const wrap = document.getElementById('sparkline-wrap');
    const containerW = (wrap && wrap.clientWidth) || 720;
    const W = Math.max(400, Math.floor(containerW));
    const H = 200;
    const padL = 56, padR = 12, padT = 16, padB = 30;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const xStep = chartW / (years.length - 1);

    function getX(i) { return padL + i * xStep; }
    function getY(v) { return padT + chartH * (1 - (niceMax ? v / niceMax : 0)); }

    function path(getValue) {
      return years.map((y, i) => {
        const v = getValue(y) || 0;
        return `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(v).toFixed(1)}`;
      }).join(' ');
    }
    const totalPath = path(y => byYear[y]);
    const pulsePath = path(y => byYearSource[y]?.pulse || 0);

    // 5 horizontal gridlines from 0 to niceMax inclusive
    const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const val = niceMax * f;
      const yPos = getY(val);
      return `
        <line class="gridline" x1="${padL}" y1="${yPos}" x2="${W - padR}" y2="${yPos}"/>
        <text class="yaxis-label" x="${padL - 6}" y="${yPos + 3}">${formatAxisLabel(val)}</text>
      `;
    }).join('');

    // Invisible hover targets: one rect per year covering the full chart height.
    // CSS handles the show/hide of the guide line and dots via the `.is-hovered`
    // class on the card; we just toggle which year is active via data attribute
    const hoverTargets = years.map((y, i) => {
      const x = getX(i);
      const halfStep = xStep / 2;
      return `<rect class="hover-target" x="${x - halfStep}" y="${padT}" width="${xStep}" height="${chartH}" fill="transparent" data-year="${y}" data-idx="${i}"/>`;
    }).join('');

    const svg = document.getElementById('sparkline');
    // Match the viewBox to actual measured container width so the chart fills
    // the card width without preserveAspectRatio stretching distorting text
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = H + 'px';
    svg.innerHTML = `
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#66c0f4" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#66c0f4" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${totalPath} L ${getX(years.length - 1)} ${getY(0)} L ${getX(0)} ${getY(0)} Z" fill="url(#sparkFill)"/>
      <path d="${totalPath}" stroke="#66c0f4" stroke-width="1.5" fill="none"/>
      <path d="${pulsePath}" stroke="#beee11" stroke-width="1.5" fill="none" opacity="0.9"/>
      <line class="hover-guide" id="hover-guide" x1="0" y1="${padT}" x2="0" y2="${H - padB}"/>
      <circle class="hover-dot" id="hover-dot-protondb" r="4"/>
      <circle class="hover-dot pulse" id="hover-dot-pulse" r="4"/>
      ${hoverTargets}
    `;

    const axis = document.getElementById('sparkline-axis');
    if (axis) {
      axis.innerHTML = years.map(y => `<span>${y}</span>`).join('');
    }

    // Wire hover behavior. Use the parent card for is-hovered toggle so CSS
    // can show/hide the guide+dots in one rule; tooltip is a separate DOM node
    // wrap was captured earlier for sizing; reuse it here
    const card = document.getElementById('sparkline-card');
    const tooltip = document.getElementById('sparkline-tooltip');
    const guide = document.getElementById('hover-guide');
    const dotPdb = document.getElementById('hover-dot-protondb');
    const dotPulse = document.getElementById('hover-dot-pulse');

    svg.querySelectorAll('.hover-target').forEach(rect => {
      rect.addEventListener('mouseenter', () => {
        const y = rect.getAttribute('data-year');
        const i = parseInt(rect.getAttribute('data-idx'), 10);
        const total = byYear[y] || 0;
        const pulse = byYearSource[y]?.pulse || 0;
        const protondb = total - pulse;

        // position guide line + dots in SVG user coords
        const x = getX(i);
        guide.setAttribute('x1', x);
        guide.setAttribute('x2', x);
        dotPdb.setAttribute('cx', x);
        dotPdb.setAttribute('cy', getY(total));
        dotPulse.setAttribute('cx', x);
        dotPulse.setAttribute('cy', getY(pulse));

        card.classList.add('is-hovered');

        // Position tooltip near the cursor's X position. Convert SVG x to
        // CSS x using the wrap's bounding box so it stays aligned on resize
        const wrapRect = wrap.getBoundingClientRect();
        const svgX = (x / W) * wrapRect.width;
        const half = tooltip.offsetWidth / 2 || 100;
        let leftPx = svgX - half;
        if (leftPx < 4) leftPx = 4;
        if (leftPx + half * 2 > wrapRect.width - 4) leftPx = wrapRect.width - half * 2 - 4;
        tooltip.style.left = leftPx + 'px';
        tooltip.innerHTML = `
          <div class="year">${y}</div>
          <div class="row"><span class="swatch protondb"></span> ProtonDB <span class="val">${fmt(protondb)}</span></div>
          <div class="row"><span class="swatch pulse"></span> Pulse <span class="val">${fmt(pulse)}</span></div>
          <div class="row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><span style="color:var(--muted)">Total</span> <span class="val">${fmt(total)}</span></div>
        `;
        tooltip.classList.add('is-visible');
      });
    });
    svg.addEventListener('mouseleave', () => {
      card.classList.remove('is-hovered');
      tooltip.classList.remove('is-visible');
    });
  }

  // Round a number UP to a "nice" axis ceiling: 1, 2, or 5 * 10^N.
  // Example: 47823 -> 50000, 18234 -> 20000, 700 -> 1000.
  function niceCeil(n) {
    if (!n || n < 0) return 1;
    const exp = Math.floor(Math.log10(n));
    const base = Math.pow(10, exp);
    const norm = n / base;
    let nice;
    if (norm <= 1) nice = 1;
    else if (norm <= 2) nice = 2;
    else if (norm <= 5) nice = 5;
    else nice = 10;
    return nice * base;
  }

  // Format axis label as compact (10K, 1.5M, 423) for tight rendering
  function formatAxisLabel(n) {
    if (n === 0) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 && n < 1e4 ? 1 : 0) + 'K';
    return String(Math.round(n));
  }

  function renderTopGames(topGames, container) {
    const list = container || document.getElementById('topgames');
    if (!list) return;
    list.innerHTML = topGames.slice(0, 30).map((entry, i) => {
      // entry can be [appId, title, count] or [appId, title, count, newestYear]
      const [appId, title, count, newestYear] = entry;
      const safeTitle = (title || appId).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      const yearStr = newestYear ? `<span class="newest">last seen ${newestYear}</span>` : '';
      return `<a href="data-index.html#/${appId}">
        <span class="rank">#${i + 1}</span>
        <span class="title">${safeTitle}</span>
        <span class="appid">${appId}</span>
        ${yearStr}
        <span class="count">${fmt(count)} reports</span>
      </a>`;
    }).join('');
  }

  // ── Rating trend chart: 5 lines (one per rating) showing % per year ──
  // Tells the story of compatibility improving (or not) over time. Borked %
  // dropping + Platinum % rising = "Proton has gotten better".
  const TIER_COLORS = {
    platinum: '#b4c7dc',
    gold:     '#c8a050',
    silver:   '#8fa0b0',
    bronze:   '#b07040',
    borked:   '#c85050',
  };

  function renderRatingsTrend(byYearRating) {
    const wrap = document.getElementById('ratings-trend-wrap');
    const svg = document.getElementById('ratings-trend');
    const axis = document.getElementById('ratings-trend-axis');
    const legend = document.getElementById('ratings-trend-legend');
    const tooltip = document.getElementById('ratings-trend-tooltip');
    if (!svg || !wrap) return;

    const years = Object.keys(byYearRating).filter(y => /^\d{4}$/.test(y)).sort();
    if (years.length < 2) {
      svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--muted)" font-family="var(--mono)" font-size="12">not enough year data</text>';
      return;
    }

    // Pre-compute total per year + per-tier percent so the chart is normalized.
    // We deliberately render % rather than raw counts so the story shows the
    // shifting MIX rather than the growing volume.
    const tiers = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
    const pctByYear = {};
    years.forEach(y => {
      const buckets = byYearRating[y] || {};
      const total = tiers.reduce((s, t) => s + (buckets[t] || 0), 0);
      pctByYear[y] = {};
      tiers.forEach(t => {
        pctByYear[y][t] = total ? (buckets[t] || 0) / total * 100 : 0;
      });
    });

    const containerW = (wrap && wrap.clientWidth) || 720;
    const W = Math.max(400, Math.floor(containerW));
    const H = 220;
    const padL = 50, padR = 12, padT = 14, padB = 30;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const xStep = chartW / (years.length - 1);

    function getX(i) { return padL + i * xStep; }
    function getY(pct) { return padT + chartH * (1 - pct / 100); }

    // Y axis: 0%, 25%, 50%, 75%, 100%
    const gridLines = [0, 25, 50, 75, 100].map(p => {
      const yPos = getY(p);
      return `
        <line class="gridline" x1="${padL}" y1="${yPos}" x2="${W - padR}" y2="${yPos}"/>
        <text class="yaxis-label" x="${padL - 6}" y="${yPos + 3}">${p}%</text>
      `;
    }).join('');

    // One path per tier
    const tierPaths = tiers.map(t => {
      const d = years.map((y, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(pctByYear[y][t]).toFixed(1)}`).join(' ');
      return `<path d="${d}" stroke="${TIER_COLORS[t]}" stroke-width="1.6" fill="none" data-tier="${t}"/>`;
    }).join('');

    // Hover targets: invisible vertical rects per year
    const hoverTargets = years.map((y, i) => {
      const x = getX(i);
      const halfStep = xStep / 2;
      return `<rect class="hover-target" x="${x - halfStep}" y="${padT}" width="${xStep}" height="${chartH}" fill="transparent" data-year="${y}" data-idx="${i}"/>`;
    }).join('');

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = H + 'px';
    svg.innerHTML = `
      ${gridLines}
      ${tierPaths}
      <line class="hover-guide" id="trend-hover-guide" x1="0" y1="${padT}" x2="0" y2="${H - padB}"/>
      ${tiers.map(t => `<circle class="hover-dot" id="trend-dot-${t}" r="3.5" fill="${TIER_COLORS[t]}"/>`).join('')}
      ${hoverTargets}
    `;

    if (axis) axis.innerHTML = years.map(y => `<span>${y}</span>`).join('');

    // Tier legend doubles as filter chips - click a tier to filter the rest
    // of the page by that rating. The global delegated handler in renderAll
    // catches the data-filter-* attrs and re-renders
    if (legend) {
      legend.innerHTML = tiers.map(t => {
        const isActive = filter.dim === 'rating' && filter.values.has(t);
        return `<span class="legend-item legend-clickable ${isActive ? 'is-active' : ''}"
          data-filter-dim="rating" data-filter-value="${t}"
          title="Click to filter by ${label(t)}">
          <span class="legend-swatch" style="background:${TIER_COLORS[t]}"></span>
          ${t}
        </span>`;
      }).join('');
    }

    const card = document.getElementById('ratings-trend-card');
    const guide = document.getElementById('trend-hover-guide');
    svg.querySelectorAll('.hover-target').forEach(rect => {
      rect.addEventListener('mouseenter', () => {
        const y = rect.getAttribute('data-year');
        const i = parseInt(rect.getAttribute('data-idx'), 10);
        const x = getX(i);
        guide.setAttribute('x1', x);
        guide.setAttribute('x2', x);
        tiers.forEach(t => {
          const dot = document.getElementById('trend-dot-' + t);
          dot.setAttribute('cx', x);
          dot.setAttribute('cy', getY(pctByYear[y][t]));
        });
        card.classList.add('is-hovered');

        // Tooltip
        const wrapRect = wrap.getBoundingClientRect();
        const svgX = (x / W) * wrapRect.width;
        const half = tooltip.offsetWidth / 2 || 100;
        let leftPx = svgX - half;
        if (leftPx < 4) leftPx = 4;
        if (leftPx + half * 2 > wrapRect.width - 4) leftPx = wrapRect.width - half * 2 - 4;
        tooltip.style.left = leftPx + 'px';
        tooltip.innerHTML = `
          <div class="year">${y}</div>
          ${tiers.map(t => `
            <div class="row">
              <span class="swatch" style="background:${TIER_COLORS[t]}"></span>
              ${t} <span class="val">${pctByYear[y][t].toFixed(1)}%</span>
            </div>
          `).join('')}
        `;
        tooltip.classList.add('is-visible');
      });
    });
    svg.addEventListener('mouseleave', () => {
      card.classList.remove('is-hovered');
      tooltip.classList.remove('is-visible');
    });
  }

  // Restore filter from query string on load. Supports both the new shape
  // (?dim=gpu&values=amd,nvidia) and the legacy single-value shape
  // (?dim=gpu&value=amd) so old bookmarks still work
  const params = new URLSearchParams(location.search);
  const qDim = params.get('dim');
  const qValues = params.get('values') || params.get('value');
  if (qDim && qValues) {
    filter = { dim: qDim, values: new Set(qValues.split(',').filter(Boolean)) };
  }

  // Fetch stats.json (required) and coverage-summary.json (optional) in
  // parallel. Coverage gives us steam catalog totals for the % tiles; if it
  // fetches fail we still render with em-dash fallbacks in those tiles.
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
})();
