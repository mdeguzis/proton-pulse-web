// user_systems REST helpers: list, set/clear default, rename, delete.
import { SUPABASE_URL } from '../config.js?v=87cd0f3d';
import { supabaseHeaders } from './supabase.js?v=bdf4b262';

export function supabaseUserSystemsUrl(query) {
  return `${SUPABASE_URL}/rest/v1/user_systems${query ? '?' + query : ''}`;
}
export async function listUserSystems(protonPulseUserId, session) {
  const url = supabaseUserSystemsUrl(
    `proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&order=updated_at.desc`,
  );
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Lookup failed: HTTP ${r.status}`);
  return await r.json();
}

export async function setDefaultSystem(protonPulseUserId, deviceId, session) {
  // Clear all, then set the chosen one. Two PATCHes; partial unique index
  // protects against a race if another tab is doing the same thing
  const base = supabaseUserSystemsUrl(`proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`);
  const r1 = await fetch(base, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: false }),
  });
  if (!r1.ok) throw new Error(`Clear default failed: HTTP ${r1.status}`);
  const specific = supabaseUserSystemsUrl(
    `proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
  );
  const r2 = await fetch(specific, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: true }),
  });
  if (!r2.ok) throw new Error(`Set default failed: HTTP ${r2.status}`);
}

// Turn OFF the default flag across every row for this user. We don't target a
// single device here because "no default" is the desired end state and going
// row-by-row would risk a brief window where two rows are default at once
export async function clearDefaultSystem(protonPulseUserId, session) {
  const base = supabaseUserSystemsUrl(`proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`);
  const r = await fetch(base, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: false }),
  });
  if (!r.ok) throw new Error(`Clear default failed: HTTP ${r.status}`);
}

export async function updateSystemLabel(protonPulseUserId, deviceId, label, session) {
  const url = supabaseUserSystemsUrl(
    `proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
  );
  const r = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ label }),
  });
  if (!r.ok) throw new Error(`Update label failed: HTTP ${r.status}`);
}

export async function deleteSystem(protonPulseUserId, deviceId, session) {
  const url = supabaseUserSystemsUrl(
    `proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
  );
  const r = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!r.ok) throw new Error(`Delete failed: HTTP ${r.status}`);
}
