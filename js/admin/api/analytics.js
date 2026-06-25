import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=86489fcb';

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

async function fetchReportsByDay(session, daysBack) {
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const url = `${SUPABASE_URL}/rest/v1/user_configs?select=created_at&created_at=gte.${since}T00:00:00&order=created_at.asc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) return [];
  const rows = await res.json();
  const counts = {};
  for (const r of rows) {
    const day = r.created_at?.slice(0, 10);
    if (day) counts[day] = (counts[day] || 0) + 1;
  }
  return Object.entries(counts).map(([day, count]) => ({ day, count }));
}
