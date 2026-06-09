// users (api) for the admin page.

import { SUPABASE_URL } from '../config.js';
import { supabaseHeaders, roleLabel } from '../utils.js';

export async function fetchAllUsers(session, { search } = {}) {
  async function fetchAllRows(table, select) {
    const limit = 1000;
    let offset = 0, rows = [];
    while (true) {
      const url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&limit=${limit}&offset=${offset}&order=updated_at.desc`;
      const res = await fetch(url, { headers: supabaseHeaders(session) });
      if (!res.ok) throw new Error(`Fetch ${table} failed: ${res.status}`);
      const batch = await res.json();
      rows.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return rows;
  }

  // Pull from both tables -- user_configs = submitted reports, user_proton_configs = cloud configs.
  const [configs, protonConfigs] = await Promise.all([
    fetchAllRows('user_configs', 'proton_pulse_user_id,client_id,updated_at'),
    fetchAllRows('user_proton_configs', 'proton_pulse_user_id,installation_id,updated_at'),
  ]);

  // Aggregate per unique identity across both tables.
  const byUser = new Map();

  function merge(protonPulseUserId, clientId, updatedAt, isReport) {
    const key = protonPulseUserId || clientId;
    if (!key) return;
    if (!byUser.has(key)) {
      byUser.set(key, {
        proton_pulse_user_id: protonPulseUserId || null,
        client_id: clientId || null,
        report_count: 0,
        last_active: updatedAt,
        display_name: null,
        role: null,
      });
    }
    const u = byUser.get(key);
    if (isReport) u.report_count++;
    if (updatedAt > u.last_active) u.last_active = updatedAt;
    if (!u.proton_pulse_user_id && protonPulseUserId) u.proton_pulse_user_id = protonPulseUserId;
    if (!u.client_id && clientId) u.client_id = clientId;
  }

  for (const r of configs) merge(r.proton_pulse_user_id, r.client_id, r.updated_at, true);
  for (const r of protonConfigs) merge(r.proton_pulse_user_id, r.installation_id, r.updated_at, false);

  // Enrich with display names from author_avatars.
  const uuids = [...byUser.values()].map(u => u.proton_pulse_user_id).filter(Boolean);
  if (uuids.length) {
    const avatarUrl = `${SUPABASE_URL}/rest/v1/author_avatars?select=proton_pulse_user_id,display_name&proton_pulse_user_id=in.(${uuids.join(',')})`;
    const avatarRes = await fetch(avatarUrl, { headers: supabaseHeaders(session) });
    if (avatarRes.ok) {
      const avatars = await avatarRes.json();
      for (const a of avatars) {
        const u = byUser.get(a.proton_pulse_user_id);
        if (u) u.display_name = a.display_name || null;
      }
    }
  }

  // Also check admins table for display names and roles.
  const adminsRes = await fetch(`${SUPABASE_URL}/rest/v1/admins?select=proton_pulse_user_id,steam_username,role`, { headers: supabaseHeaders(session) });
  if (adminsRes.ok) {
    const admins = await adminsRes.json();
    for (const a of admins) {
      const u = byUser.get(a.proton_pulse_user_id);
      if (u) {
        if (!u.display_name) u.display_name = a.steam_username;
        u.role = a.role || null;
      }
    }
  }

  // Counts over the full set, independent of the search filter. A user with a
  // proton_pulse_user_id signed in via Steam; client_id-only users are anonymous.
  const everyone = [...byUser.values()];
  const counts = {
    total: everyone.length,
    steam: everyone.filter(u => u.proton_pulse_user_id).length,
    anon: everyone.filter(u => !u.proton_pulse_user_id).length,
  };

  let rows = everyone.sort((a, b) => (b.last_active || '') > (a.last_active || '') ? 1 : -1);

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r =>
      (r.display_name || '').toLowerCase().includes(q) ||
      (r.proton_pulse_user_id || '').toLowerCase().includes(q) ||
      (r.client_id || '').toLowerCase().includes(q) ||
      roleLabel(r.role).toLowerCase().includes(q)
    );
  }

  return { rows, counts };
}
