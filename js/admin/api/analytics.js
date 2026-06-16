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
  return res.json();
}
