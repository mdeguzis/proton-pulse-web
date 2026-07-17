import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=2668b2f0';

export async function fetchAnalytics(session, { daysBack = 30 } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/admin_analytics`;
  const res = await fetch(url, {
    method: 'POST',
    headers: supabaseHeaders(session),
    body: JSON.stringify({ days_back: daysBack }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`fetchAnalytics failed (${res.status}): ${text}`);
  }
  const data = await res.json();

  const reportsByDay = await fetchReportsByDay(session, daysBack).catch(() => []);
  data.reports_by_day = reportsByDay;
  data.sw_cache = await fetchSwCacheStats(session, daysBack).catch(() => null);
  return data;
}

// Service worker image cache stats. Each session reports one sw_cache event with
// { hits, misses } in metadata (see js/lib/topbar.js). We sum those into an
// overall hit rate plus a per-day series, computed client-side so no RPC change
// is needed.
async function fetchSwCacheStats(session, daysBack) {
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const url = `${SUPABASE_URL}/rest/v1/site_events?event_type=eq.sw_cache&select=metadata,created_at&created_at=gte.${since}T00:00:00&order=created_at.asc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) return null;
  const rows = await res.json();
  let hits = 0, misses = 0;
  const byDay = {};
  for (const r of rows) {
    const m = r.metadata || {};
    const h = Number(m.hits) || 0;
    const ms = Number(m.misses) || 0;
    hits += h; misses += ms;
    const day = r.created_at?.slice(0, 10);
    if (day) {
      if (!byDay[day]) byDay[day] = { hits: 0, misses: 0 };
      byDay[day].hits += h;
      byDay[day].misses += ms;
    }
  }
  const total = hits + misses;
  return {
    sessions: rows.length,
    hits,
    misses,
    served: hits,
    hit_rate: total ? Math.round((hits / total) * 100) : 0,
    by_day: Object.entries(byDay).map(([day, v]) => ({
      day,
      hit_rate: (v.hits + v.misses) ? Math.round((v.hits / (v.hits + v.misses)) * 100) : 0,
    })),
  };
}

// #76: broken down by source so the chart can show web vs plugin vs other.
// The decky-proton-pulse plugin's submit path (src/lib/userConfigs.ts) sends
// source = 'user' | 'protondb' | 'protondb-local' -- none of those start
// with the 'plugin' prefix, so every plugin submission was silently landing
// in the "other" bucket. Recognize the three plugin-produced values here
// and reserve 'plugin*' as a forward-looking prefix for a future plugin
// release that may adopt it. Web submissions still use 'web-<platform>'.
const PLUGIN_SOURCES = new Set(['user', 'protondb', 'protondb-local']);
function classifyReportSource(src) {
  const s = (src || '').toLowerCase();
  if (s.startsWith('web')) return 'web';
  if (s.startsWith('plugin')) return 'plugin';
  if (PLUGIN_SOURCES.has(s)) return 'plugin';
  return 'other';
}

async function fetchReportsByDay(session, daysBack) {
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const url = `${SUPABASE_URL}/rest/v1/user_configs?select=created_at,source&created_at=gte.${since}T00:00:00&order=created_at.asc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) return [];
  const rows = await res.json();
  // { '2026-06-30': { web: 3, plugin: 1, other: 0, count: 4 }, ... }
  const buckets = {};
  for (const r of rows) {
    const day = r.created_at?.slice(0, 10);
    if (!day) continue;
    if (!buckets[day]) buckets[day] = { web: 0, plugin: 0, other: 0, count: 0 };
    const bucket = classifyReportSource(r.source);
    buckets[day][bucket] += 1;
    buckets[day].count += 1;
  }
  // Pad every day in the range with a zero-count row so the chart plots a
  // continuous line instead of skipping missing days. Without this, a 90-day
  // range with sparse reports collapses to a handful of x-axis ticks and
  // hides the "0 reports today" signal admins actually want to see.
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(since + 'T00:00:00Z');
  const end   = new Date(today + 'T00:00:00Z');
  const out = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const b = buckets[day] || { web: 0, plugin: 0, other: 0, count: 0 };
    out.push({ day, count: b.count, web: b.web, plugin: b.plugin, other: b.other });
  }
  return out;
}
