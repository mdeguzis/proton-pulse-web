// analytics-history.js -- read-side helper for site_stats_daily (#208).
//
// site_stats_daily has one row per (snapshot_date, store, tier, hardware_bucket).
// This module pulls a date window from Supabase's REST endpoint and reshapes
// the rows into the { labels, series } format that js/shared/purpose-charts.js
// consumes for the time-series chart type.
//
// The fetch layer and the reshape layer are separate so the reshape is unit
// testable without a live Supabase.

const REST_PATH = '/rest/v1/site_stats_daily';

function _isoDate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function _windowRange(windowDays) {
  const to = new Date();
  const from = new Date(to.getTime() - (windowDays - 1) * 86400000);
  return { from: _isoDate(from), to: _isoDate(to) };
}

/**
 * Fetch raw site_stats_daily rows for a window. Callers pass either
 * `{ windowDays }` or `{ from, to }` (ISO date strings or Date objects).
 * Optional `filters` narrow the query server-side; missing keys are ignored.
 *
 * Requires `window.SUPABASE_URL` and `window.SUPABASE_ANON_KEY` to be set
 * (js/lib/supabase-client.js does this).
 */
export async function fetchStatsHistory({
  windowDays,
  from,
  to,
  filters,
  fetchImpl,
  supabaseUrl,
  supabaseAnonKey,
} = {}) {
  const url  = supabaseUrl    || (typeof window !== 'undefined' ? window.SUPABASE_URL      : null);
  const key  = supabaseAnonKey || (typeof window !== 'undefined' ? window.SUPABASE_ANON_KEY : null);
  const fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!url || !key || !fetchFn) {
    console.warn('[analytics-history] missing SUPABASE_URL / anon key / fetch');
    return [];
  }
  const range = (from && to)
    ? { from: _isoDate(from), to: _isoDate(to) }
    : _windowRange(windowDays || 30);
  const params = new URLSearchParams();
  params.set('select', 'snapshot_date,store,tier,hardware_bucket,report_count,verified_owner_count,avg_playtime_minutes');
  params.append('snapshot_date', `gte.${range.from}`);
  params.append('snapshot_date', `lte.${range.to}`);
  params.set('order', 'snapshot_date.asc');
  if (filters?.store)    params.append('store',           `eq.${filters.store}`);
  if (filters?.tier)     params.append('tier',            `eq.${filters.tier}`);
  if (filters?.hardware) params.append('hardware_bucket', `eq.${filters.hardware}`);

  const resp = await fetchFn(`${url}${REST_PATH}?${params.toString()}`, {
    headers: { apikey: key, Accept: 'application/json' },
  });
  if (!resp.ok) {
    console.warn('[analytics-history] fetch failed', resp.status);
    return [];
  }
  return resp.json();
}

/**
 * Reshape rows into { labels, series } for a time-series chart.
 *
 * groupBy picks which dimension becomes a series line:
 *   'tier'            -> one line per rating
 *   'store'           -> one line per platform
 *   'hardware_bucket' -> one line per GPU family
 *   'total'           -> single line summing everything (default)
 *
 * metric picks which column feeds the y-axis:
 *   'report_count'         (default)
 *   'verified_owner_count'
 *   'avg_playtime_minutes' (row-weighted average across buckets on the same day)
 *
 * Rows for the same (date, groupKey) are summed. avg_playtime_minutes is
 * combined as a weighted mean using report_count as the weight so buckets
 * with 1 report don't dominate buckets with 100.
 */
export function historyToTimeSeries(rows, { groupBy = 'total', metric = 'report_count' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { labels: [], series: [] };

  const dates = new Set();
  const byGroup = new Map();

  for (const row of rows) {
    const date = row.snapshot_date;
    dates.add(date);
    const key = groupBy === 'total' ? 'total' : (row[groupBy] || 'unknown');
    if (!byGroup.has(key)) byGroup.set(key, new Map());
    const bucket = byGroup.get(key);
    const existing = bucket.get(date) || { sum: 0, weight: 0 };
    if (metric === 'avg_playtime_minutes') {
      const avg = Number(row.avg_playtime_minutes || 0);
      const w   = Number(row.report_count || 0);
      existing.sum    += avg * w;
      existing.weight += w;
    } else {
      existing.sum += Number(row[metric] || 0);
    }
    bucket.set(date, existing);
  }

  const labels = [...dates].sort();
  const series = [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => ({
      key,
      values: labels.map(date => {
        const cell = bucket.get(date);
        if (!cell) return 0;
        if (metric === 'avg_playtime_minutes') {
          return cell.weight > 0 ? Math.round((cell.sum / cell.weight) * 100) / 100 : 0;
        }
        return cell.sum;
      }),
    }));

  return { labels, series };
}
