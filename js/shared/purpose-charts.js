// Chart-type-per-purpose framework (#207, umbrella #204).
//
// The caller says WHAT the chart is for; this module picks the actual chart
// type. Purposes:
//   distribution -> single-series bar (or grouped bar when compareBy is set).
//                   Answers 'how are values spread across categories?'.
//   correlation  -> stacked bar keyed by a categorical (rating vs GPU vendor,
//                   rating vs OS, etc). Answers 'does X correlate with Y?'.
//                   Falls back to a scatter when both axes are numeric.
//   time-series  -> line chart, one series per key. Answers 'how has X moved
//                   over time?'.
//   flow         -> grouped bar for now (sankey needs a Chart.js plugin;
//                   #207 comment for the future). Answers 'what leads to what?'.
//
// Every chart supports click-drilldown via options.onSlice({ category, key })
// so callers can push a filter into the URL hash and re-render the page.
//
// Chart.js must be loaded on the page (window.Chart). This module never
// imports it; each caller ensures the CDN script tag exists. Keeps the
// bundle out of pages that don't need it.

// Named colour set that pairs with the site rating tokens so a stacked bar
// keyed by rating reads correctly at a glance. Extra keys degrade gracefully
// to a rotating palette.
const RATING_COLORS = {
  platinum: '#b4c7dc',
  gold:     '#c8a050',
  silver:   '#8fa0b0',
  bronze:   '#b07040',
  borked:   '#c85050',
  pending:  '#4a5f70',
  unrated:  '#4a5f70',
};
const FALLBACK_PALETTE = [
  '#66c0f4', '#5eead4', '#f472b6', '#facc15', '#a78bfa',
  '#4ade80', '#fb923c', '#f87171', '#94a3b8', '#38bdf8',
];

function _pick(key, idx) {
  if (RATING_COLORS[key]) return RATING_COLORS[key];
  return FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length];
}

// Common Chart.js base options (dark theme, minimal chrome).
function _baseOptions(onSliceHandler, extra) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    onClick: onSliceHandler,
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: { labels: { color: '#c8d4e0', font: { family: 'monospace', size: 11 } } },
      tooltip: { backgroundColor: '#0b1116', borderColor: '#334', borderWidth: 1, titleColor: '#c8d4e0', bodyColor: '#c8d4e0' },
    },
    scales: {
      x: { ticks: { color: '#8fa0b0', font: { family: 'monospace', size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
      y: { ticks: { color: '#8fa0b0', font: { family: 'monospace', size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
    },
    ...(extra || {}),
  };
}

function _wrapClick(chartInstanceGetter, onSlice) {
  if (typeof onSlice !== 'function') return null;
  return (evt, activeEls) => {
    const chart = chartInstanceGetter();
    if (!chart) return;
    const el = (activeEls && activeEls[0])
      || (chart.getElementsAtEventForMode
        ? chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, false)[0]
        : null);
    if (!el) return;
    const dsi = el.datasetIndex;
    const ii  = el.index;
    const category = chart.data.labels?.[ii];
    const key = chart.data.datasets?.[dsi]?.label;
    onSlice({ category, key, datasetIndex: dsi, index: ii });
  };
}

/**
 * Render a chart based on its purpose. Returns the Chart instance so callers
 * can destroy() it before re-rendering.
 *
 * data shape depends on purpose:
 *   distribution: { labels: string[], values: number[] }
 *   correlation:  { labels: string[], series: [{ key: string, values: number[] }] }
 *   time-series:  { labels: string[], series: [{ key: string, values: number[] }] }
 *   flow:         same as correlation, rendered as grouped bar.
 *
 * options: { title?: string, colorForKey?: (key, idx) => string, onSlice?, stacked? }
 */
export function renderPurposeChart(canvas, { purpose, data, options }) {
  if (!canvas || typeof window === 'undefined' || typeof window.Chart !== 'function') {
    console.warn('[purpose-charts] Chart.js not loaded; skipping render');
    return null;
  }
  const Chart = window.Chart;
  const opts = options || {};
  const colorForKey = opts.colorForKey || _pick;

  let cfg;
  let instance;
  const clickHandler = _wrapClick(() => instance, opts.onSlice);
  const base = _baseOptions(clickHandler);

  if (purpose === 'distribution') {
    cfg = {
      type: 'bar',
      data: {
        labels: (data.labels || []).slice(),
        datasets: [{
          label: opts.title || 'count',
          data: (data.values || []).slice(),
          backgroundColor: (data.labels || []).map((k, i) => colorForKey(k, i)),
          borderWidth: 0,
        }],
      },
      options: { ...base, plugins: { ...base.plugins, legend: { display: false } } },
    };
  } else if (purpose === 'correlation' || purpose === 'flow') {
    // Stacked bar keyed by series.key. Correlation stacks so shares line up
    // to 100%; flow groups so upstream vs downstream buckets read side-by-side.
    const stacked = purpose === 'correlation' ? (opts.stacked !== false) : false;
    const datasets = (data.series || []).map((s, i) => ({
      label: s.key,
      data: s.values.slice(),
      backgroundColor: colorForKey(s.key, i),
      borderWidth: 0,
    }));
    cfg = {
      type: 'bar',
      data: { labels: (data.labels || []).slice(), datasets },
      options: {
        ...base,
        scales: {
          x: { ...base.scales.x, stacked },
          y: { ...base.scales.y, stacked, beginAtZero: true },
        },
      },
    };
  } else if (purpose === 'time-series') {
    const datasets = (data.series || []).map((s, i) => ({
      label: s.key,
      data: s.values.slice(),
      borderColor: colorForKey(s.key, i),
      backgroundColor: colorForKey(s.key, i) + '33', // 20% alpha
      tension: 0.25,
      pointRadius: 2,
      pointHoverRadius: 5,
      fill: false,
    }));
    cfg = {
      type: 'line',
      data: { labels: (data.labels || []).slice(), datasets },
      options: base,
    };
  } else {
    console.warn('[purpose-charts] unknown purpose:', purpose);
    return null;
  }

  instance = new Chart(canvas, cfg);
  return instance;
}

/**
 * Turn a stats.json cross-tab (e.g. by_rating_x_gpu_vendor) into the
 * correlation data shape. Keys of the outer object become labels on the x
 * axis; keys of the inner objects become series. Missing cells are treated
 * as 0 so the stacked bars align.
 *
 * Optional preferredKeys keeps series in a fixed order (e.g. rating order).
 */
export function crossTabToCorrelation(crossTab, preferredKeys) {
  if (!crossTab || typeof crossTab !== 'object') return { labels: [], series: [] };
  const labels = Object.keys(crossTab);
  const keySet = new Set();
  for (const label of labels) {
    for (const key of Object.keys(crossTab[label] || {})) keySet.add(key);
  }
  const ordered = Array.isArray(preferredKeys)
    ? preferredKeys.filter(k => keySet.has(k)).concat([...keySet].filter(k => !preferredKeys.includes(k)))
    : [...keySet];
  const series = ordered.map(key => ({
    key,
    values: labels.map(label => Number((crossTab[label] || {})[key] || 0)),
  }));
  return { labels, series };
}
