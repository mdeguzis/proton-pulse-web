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
  return data;
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
