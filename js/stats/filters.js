// Stats page filter state and UI logic.

import { FILTER_DIMS, dimDef, label, fmt, sum } from './utils.js?v=9bcdac4f';

// Active filter. Only one dim active at a time (because the cross-tabs
// we ship only key off one dim), but multiple values within that dim.
// values is a Set for cheap toggle/has checks.
let filter = { dim: null, values: new Set() };

// Which dropdown is currently open (id from FILTER_DIMS). null = none.
let openDropdown = null;

// Callback set by main.js so filter changes trigger a re-render
let onFilterChange = null;

export function setFilterChangeCallback(fn) { onFilterChange = fn; }

export function getFilter() { return filter; }
export function setFilter(f) { filter = f; }

export function getOpenDropdown() { return openDropdown; }
export function setOpenDropdown(val) { openDropdown = val; }

// Reduce stats to the buckets the page renders, applying the active filter.
// Returns { rating, gpu, cpu, os, source, proton, device, total } each as
// { token: count }
export function applyFilter(stats) {
  if (!stats) return null;

  const noFilter = !filter.dim || filter.values.size === 0;
  if (noFilter) {
    return {
      rating: stats.by_rating || {},
      gpu:    stats.by_gpu_vendor || {},
      cpu:    stats.by_cpu_brand || {},
      os:     stats.by_os_family || {},
      proton: stats.by_proton_type || {},
      store:  stats.by_store || {},
      source: stats.by_source || {},
      device: stats.by_device_family || {},
      total:  stats.total_reports || 0,
    };
  }

  // Filtered: cross-tabs let us pivot rating-by-dim or dim-by-rating.
  // For multi-value within a dim, sum across the selected values.
  const out = {
    rating: {}, gpu: {}, cpu: {}, os: {}, proton: {}, store: {}, source: {}, device: {},
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

// Render one dropdown button + its (initially hidden) panel of checkboxes.
// Options come from the dim's single-dim counter in stats.json, sorted by
// count desc so the most-common values float to the top of each panel.
export function renderDropdownButton(d, stats) {
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
export function toggleFilterValue(dim, value) {
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
  if (onFilterChange) onFilterChange();
}

export function clearFilter() {
  filter = { dim: null, values: new Set() };
  pushFilterToUrl();
  if (onFilterChange) onFilterChange();
}

// Reflect filter state in URL so links survive copy/paste.
// ?dim=gpu&values=amd,nvidia
export function pushFilterToUrl() {
  const url = new URL(location.href);
  url.search = '';
  if (filter.dim && filter.values.size > 0) {
    url.searchParams.set('dim', filter.dim);
    url.searchParams.set('values', Array.from(filter.values).join(','));
  }
  history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
}

// Restore filter from query string. Supports both the new shape
// (?dim=gpu&values=amd,nvidia) and the legacy single-value shape
// (?dim=gpu&value=amd) so old bookmarks still work
export function restoreFilterFromUrl() {
  const params = new URLSearchParams(location.search);
  const qDim = params.get('dim');
  const qValues = params.get('values') || params.get('value');
  if (qDim && qValues) {
    filter = { dim: qDim, values: new Set(qValues.split(',').filter(Boolean)) };
  }
}
