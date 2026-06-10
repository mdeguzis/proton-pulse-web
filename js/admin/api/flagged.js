// flagged (api) for the admin page.

import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=bd5a67c2';

export async function fetchFlaggedReports(session, { search, type, dateFrom, dateTo, sortField, sortDir } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?is_flagged=eq.true`
    + `&select=id,app_id,title,proton_pulse_user_id,client_id,flagged_reason,flagged_at,is_hidden`
    + `&order=${encodeURIComponent(sortField)}.${sortDir}`;

  if (dateFrom) url += `&flagged_at=gte.${encodeURIComponent(new Date(dateFrom).toISOString())}`;
  if (dateTo) {
    const end = new Date(dateTo);
    end.setDate(end.getDate() + 1);
    url += `&flagged_at=lte.${encodeURIComponent(end.toISOString())}`;
  }
  if (type) url += `&flagged_reason=like.${encodeURIComponent(type + ':*')}`;

  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch flagged failed: ${res.status}`);
  let rows = await res.json();

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.flagged_reason || '').toLowerCase().includes(q)
    );
  }

  // Batch-fetch author display names from author_avatars.
  const userIds = [...new Set(rows.map(r => r.proton_pulse_user_id).filter(Boolean))];
  const avatarMap = {};
  if (userIds.length) {
    const ids = userIds.map(id => `"${id}"`).join(',');
    const avUrl = `${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=in.(${encodeURIComponent(ids)})&select=proton_pulse_user_id,display_name,steam_id`;
    const avRes = await fetch(avUrl, { headers: supabaseHeaders(session) });
    if (avRes.ok) {
      const avRows = await avRes.json();
      for (const av of avRows) avatarMap[av.proton_pulse_user_id] = av;
    }
  }

  return rows.map(r => ({ ...r, _author: avatarMap[r.proton_pulse_user_id] ?? null }));
}


export async function reinstateReport(session, id) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_flagged: false, is_hidden: false, flagged_reason: null, flagged_at: null }),
  });
  if (!res.ok) throw new Error(`Reinstate failed: ${res.status}`);
}


export async function deleteReport(session, id) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}
