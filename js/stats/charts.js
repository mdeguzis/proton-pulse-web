// Stats page chart renderers.

import { label, fmt, niceCeil, formatAxisLabel, vramLabel, TIER_COLORS } from './utils.js?v=ceb23379';
import { getFilter } from './filters.js?v=bfe27ee2';

// Render N horizontal bar rows sorted descending by count.
// dataAttr is the data-* attribute name (rating, key) for per-row tinting.
export function renderBars(container, buckets, opts = {}) {
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

// Bucket by_year totals into age windows so the page can show "X% of reports
// are from the past 12 months" without baking the buckets into stats.json.
export function renderFreshness(byYear) {
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
export function renderFramegen(s) {
  const host = document.getElementById('framegen-section');
  if (!host) return;
  const total = s.framegen_total_responses || 0;
  const yes = s.framegen_yes_count || 0;
  const yesRate = s.framegen_yes_rate_pct;

  if (!total) {
    host.innerHTML = `<div class="chart-card" style="padding:24px"><div class="loading-state" style="padding:8px">No framegen responses yet. Submit a report to start filling this in.</div></div>`;
    return;
  }

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
export function renderFramegenBars(container, cross, labelFn, attrName) {
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
export function renderFramegenTopGames(rows) {
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

export function renderDonut(bySource) {
  const filter = getFilter();
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
export function renderSparkline(byYear, byYearSource) {
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

  // Wire hover behavior
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

      // Position tooltip near the cursor's X position
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

export function renderTopGames(topGames, container) {
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

// Rating trend chart: 5 lines (one per rating) showing % per year.
// Tells the story of compatibility improving (or not) over time.
export function renderRatingsTrend(byYearRating) {
  const filter = getFilter();
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

  // Tier legend doubles as filter chips
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
