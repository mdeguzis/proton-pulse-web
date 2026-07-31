// Admin API wrapper for the search_analytics RPC (#434 followup).
// Same auth shape as fetchAnalytics -- session-based, no service-role
// key on the client. Retention is 30 days server-side.

import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=2668b2f0';

export async function fetchSearchAnalytics(session, { daysBack = 7 } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/admin_search_analytics`;
  const res = await fetch(url, {
    method: 'POST',
    headers: supabaseHeaders(session),
    body: JSON.stringify({ days_back: daysBack }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`fetchSearchAnalytics failed (${res.status}): ${text}`);
  }
  return res.json();
}
