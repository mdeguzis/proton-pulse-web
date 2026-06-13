// admins (api) for the admin page.

import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=86489fcb';

export async function fetchAdmins(session) {
  const url = `${SUPABASE_URL}/rest/v1/admins?select=proton_pulse_user_id,steam_username,role,added_at&order=added_at.asc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch admins failed: ${res.status}`);
  return res.json();
}


export async function addAdmin(session, { uuid, username, role }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admins`, {
    method: 'POST',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ proton_pulse_user_id: uuid, steam_username: username, role }),
  });
  if (!res.ok) throw new Error(`Add admin failed: ${res.status} ${await res.text()}`);
}


export async function removeAdmin(session, uuid) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${uuid}`, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Remove admin failed: ${res.status}`);
}


export async function updateAdminRole(session, uuid, role) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${uuid}`, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`Update role failed: ${res.status}`);
}
