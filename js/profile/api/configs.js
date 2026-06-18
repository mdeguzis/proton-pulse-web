// user_configs + user_proton_configs REST helpers: fetch/publish/delete
// reports, fetch history, and patch report/cloud config rows.
import { SUPABASE_URL } from '../config.js?v=87cd0f3d';
import { supabaseHeaders } from './supabase.js?v=bdf4b262';

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

export async function fetchAllMyData(protonPulseUserId, clientId, session) {
  const h = supabaseHeaders(session);
  const uid = protonPulseUserId ? encodeURIComponent(protonPulseUserId) : null;
  const cid = clientId ? encodeURIComponent(clientId) : null;
  const get = (url) => fetch(url, { headers: h }).then((r) => r.ok ? r.json() : []);
  const [configs, protonConfigs, systems, votes, avatar, configsByClient, events, history] = await Promise.all([
    uid ? get(`${SUPABASE_URL}/rest/v1/user_configs?proton_pulse_user_id=eq.${uid}&select=*`) : Promise.resolve([]),
    uid ? get(`${SUPABASE_URL}/rest/v1/user_proton_configs?proton_pulse_user_id=eq.${uid}&select=*`) : Promise.resolve([]),
    uid ? get(`${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${uid}&select=*`) : Promise.resolve([]),
    uid ? get(`${SUPABASE_URL}/rest/v1/report_votes?voter_id=eq.${uid}&select=*`) : Promise.resolve([]),
    uid ? get(`${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=eq.${uid}&select=*`) : Promise.resolve([]),
    cid ? get(`${SUPABASE_URL}/rest/v1/user_configs?client_id=eq.${cid}&select=*`) : Promise.resolve([]),
    uid ? get(`${SUPABASE_URL}/rest/v1/site_events?proton_pulse_user_id=eq.${uid}&select=*`) : Promise.resolve([]),
    Promise.resolve([]),
  ]);
  const mergedConfigs = [...configs];
  for (const row of configsByClient) {
    if (!mergedConfigs.some((r) => r.id === row.id)) mergedConfigs.push(row);
  }
  // Fetch history for all user_configs rows (linked by config_id, not user_id)
  let historyRows = [];
  if (mergedConfigs.length) {
    const ids = mergedConfigs.map((r) => r.id).join(',');
    historyRows = await get(`${SUPABASE_URL}/rest/v1/user_configs_history?config_id=in.(${ids})&select=*`);
  }
  return { user_configs: mergedConfigs, user_proton_configs: protonConfigs, user_systems: systems, report_votes: votes, author_avatars: avatar, site_events: events, user_configs_history: historyRows };
}

export async function checkMyDataExists(protonPulseUserId, clientId, session) {
  const data = await fetchAllMyData(protonPulseUserId, clientId, session);
  return {
    user_configs: data.user_configs.length,
    user_proton_configs: data.user_proton_configs.length,
    user_systems: data.user_systems.length,
    report_votes: data.report_votes.length,
    author_avatars: data.author_avatars.length,
    site_events: data.site_events.length,
    user_configs_history: data.user_configs_history.length,
  };
}

export async function deleteAllMyData(protonPulseUserId, clientId, session) {
  const headers = { ...supabaseHeaders(session), Prefer: 'return=minimal' };
  // Delete history first (linked by config_id -- must happen before user_configs is deleted)
  if (protonPulseUserId) {
    const uid = encodeURIComponent(protonPulseUserId);
    const idsResp = await fetch(`${SUPABASE_URL}/rest/v1/user_configs?proton_pulse_user_id=eq.${uid}&select=id`, { headers: supabaseHeaders(session) });
    if (idsResp.ok) {
      const rows = await idsResp.json();
      if (rows.length) {
        const ids = rows.map((r) => r.id).join(',');
        const r = await fetch(`${SUPABASE_URL}/rest/v1/user_configs_history?config_id=in.(${ids})`, { method: 'DELETE', headers });
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          console.error('[profile] deleteAllMyData history failed', { status: r.status, body });
          throw new Error(`Delete history failed: HTTP ${r.status}`);
        }
      }
    }
  }
  const deletes = [];
  if (protonPulseUserId) {
    const uid = encodeURIComponent(protonPulseUserId);
    deletes.push(fetch(`${SUPABASE_URL}/rest/v1/user_configs?proton_pulse_user_id=eq.${uid}`, { method: 'DELETE', headers }));
    deletes.push(fetch(`${SUPABASE_URL}/rest/v1/user_proton_configs?proton_pulse_user_id=eq.${uid}`, { method: 'DELETE', headers }));
    deletes.push(fetch(`${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${uid}`, { method: 'DELETE', headers }));
    deletes.push(fetch(`${SUPABASE_URL}/rest/v1/report_votes?voter_id=eq.${uid}`, { method: 'DELETE', headers }));
    deletes.push(fetch(`${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=eq.${uid}`, { method: 'DELETE', headers }));
    deletes.push(fetch(`${SUPABASE_URL}/rest/v1/site_events?proton_pulse_user_id=eq.${uid}`, { method: 'DELETE', headers }));
  }
  if (clientId) {
    deletes.push(fetch(`${SUPABASE_URL}/rest/v1/user_configs?client_id=eq.${encodeURIComponent(clientId)}`, { method: 'DELETE', headers }));
  }
  const results = await Promise.all(deletes);
  const failed = results.find((r) => !r.ok);
  if (failed) {
    const body = await failed.text().catch(() => '');
    console.error('[profile] deleteAllMyData failed', { status: failed.status, body });
    throw new Error(`Delete failed: HTTP ${failed.status}`);
  }
}

export async function fetchMyFlags(clientId) {
  if (!clientId) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/flagged_reports`
      + `?reporter_client_id=eq.${encodeURIComponent(clientId)}`
      + `&select=id,app_id,source,reason_category,reason_text,status,flagged_at`
      + `&order=flagged_at.desc`;
    const r = await fetch(url, { headers: supabaseHeaders(null) });
    return r.ok ? await r.json() : [];
  } catch { return []; }
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
