// user_configs + user_proton_configs REST helpers: fetch/publish/delete
// reports, fetch history, and patch report/cloud config rows.
import { SUPABASE_URL } from '../config.js?v=87cd0f3d';
import { supabaseHeaders } from './supabase.js?v=4889c5e6';

export async function fetchMyUserConfigs(protonPulseUserId, clientId, session) {
  // Public Pulse reports that show up on game pages.
  const filters = [];
  if (protonPulseUserId) {
    filters.push(`proton_pulse_user_id.eq.${encodeURIComponent(protonPulseUserId)}`);
  }
  if (clientId) {
    filters.push(`client_id.eq.${encodeURIComponent(clientId)}`);
  }
  if (!filters.length) return [];
  const url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?or=(${filters.join(',')})`
    + `&select=id,app_id,title,proton_version,rating,created_at,updated_at,is_flagged,is_hidden,flagged_reason`
    + `&order=created_at.desc`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error('[profile] fetchMyUserConfigs failed', { status: r.status, body });
    throw new Error(`Reports lookup failed: HTTP ${r.status}${body ? ' - ' + body : ''}`);
  }
  return await r.json();
}

export async function fetchMyCloudConfigs(protonPulseUserId, session) {
  if (!protonPulseUserId) return [];
  const url = `${SUPABASE_URL}/rest/v1/user_proton_configs`
    + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
    + `&select=app_id,app_name,updated_at,config,is_published`
    + `&order=updated_at.desc`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error('[profile] fetchMyCloudConfigs failed', { status: r.status, body });
    throw new Error(`Cloud configs lookup failed: HTTP ${r.status}${body ? ' - ' + body : ''}`);
  }
  return await r.json();
}

export async function publishMyCloudConfig(protonPulseUserId, appId, session) {
  if (!protonPulseUserId || !appId) throw new Error('Missing report owner');
  const url = `${SUPABASE_URL}/rest/v1/user_proton_configs`
    + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
    + `&app_id=eq.${encodeURIComponent(appId)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(session), Prefer: 'return=minimal' },
    body: JSON.stringify({ is_published: true }),
  });
  if (!r.ok) throw new Error(`Publish failed: HTTP ${r.status}`);
}

export async function deleteMyReportsEverywhere(protonPulseUserId, clientId, appId, session) {
  const headers = { ...supabaseHeaders(session), Prefer: 'return=minimal' };
  const deletes = [];
  if (protonPulseUserId) {
    deletes.push(fetch(
      `${SUPABASE_URL}/rest/v1/user_proton_configs`
        + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
        + `&app_id=eq.${encodeURIComponent(appId)}`,
      { method: 'DELETE', headers },
    ));
    deletes.push(fetch(
      `${SUPABASE_URL}/rest/v1/user_configs`
        + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
        + `&app_id=eq.${encodeURIComponent(appId)}`,
      { method: 'DELETE', headers },
    ));
  }
  if (clientId) {
    deletes.push(fetch(
      `${SUPABASE_URL}/rest/v1/user_configs`
        + `?client_id=eq.${encodeURIComponent(clientId)}`
        + `&app_id=eq.${encodeURIComponent(appId)}`,
      { method: 'DELETE', headers },
    ));
  }

  const results = await Promise.all(deletes);
  const failed = results.find((r) => !r.ok);
  if (failed) throw new Error(`Delete failed: HTTP ${failed.status}`);
}

export async function fetchFullUserConfig(reportId, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?id=eq.${encodeURIComponent(reportId)}`
    + `&select=id,app_id,title,rating,proton_version,os,notes,config_key,created_at,updated_at`
    + `&limit=1`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Fetch report failed: HTTP ${r.status}`);
  const rows = await r.json();
  return rows[0] ?? null;
}

export async function fetchReportHistory(reportId, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs_history`
    + `?config_id=eq.${encodeURIComponent(reportId)}`
    + `&select=id,rating,proton_version,os,notes,config_key,recorded_at`
    + `&order=recorded_at.desc`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`History fetch failed: HTTP ${r.status}`);
  return await r.json();
}

export async function patchUserConfig(reportId, fields, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${encodeURIComponent(reportId)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(session), Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`Update failed: HTTP ${r.status}`);
}

export async function fetchCloudConfig(protonPulseUserId, appId, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_proton_configs`
    + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
    + `&app_id=eq.${encodeURIComponent(appId)}`
    + `&select=id,app_id,app_name,config,is_published`
    + `&limit=1`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Fetch config failed: HTTP ${r.status}`);
  const rows = await r.json();
  return rows[0] ?? null;
}

export async function patchCloudConfig(protonPulseUserId, appId, configPatch, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_proton_configs`
    + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
    + `&app_id=eq.${encodeURIComponent(appId)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(session), Prefer: 'return=minimal' },
    body: JSON.stringify({ config: configPatch }),
  });
  if (!r.ok) throw new Error(`Config update failed: HTTP ${r.status}`);
}
