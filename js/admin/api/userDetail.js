// userDetail (api) for the admin page - fetches a single user's submitted reports.

import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=86489fcb';

export async function fetchUserReports(session, { userId, clientId }) {
  const select = 'id,app_id,title,rating,proton_version,launch_options,created_at,updated_at,is_hidden,is_flagged,source';
  let filter;
  if (userId) {
    filter = `proton_pulse_user_id=eq.${encodeURIComponent(userId)}`;
  } else if (clientId) {
    filter = `client_id=eq.${encodeURIComponent(clientId)}`;
  } else {
    return [];
  }
  const url = `${SUPABASE_URL}/rest/v1/user_configs?${filter}&select=${select}&order=created_at.desc&limit=100`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`fetchUserReports failed (${res.status}): ${text}`);
  }
  const rows = await res.json();
  console.debug('[userDetail] fetchUserReports', { userId, clientId, count: rows.length, source: 'user_configs', filter });
  return rows;
}
