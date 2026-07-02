// flagged (api) for the admin page.

import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=bd5a67c2';
import { appIdToDir } from '../../lib/app-id.js?v=18a73fb7';

export async function fetchFlaggedReports(session, { search, type, dateFrom, dateTo, sortField, sortDir } = {}) {
  // Query the unified flagged_reports log (covers both ProtonDB and Pulse reports)
  let url = `${SUPABASE_URL}/rest/v1/flagged_reports`
    + `?select=id,app_id,report_key,source,reason_category,reason_text,status,reporter_client_id,flagged_at,updated_at`
    + `&order=${encodeURIComponent(sortField === 'flagged_reason' ? 'reason_category' : sortField)}.${sortDir}`;

  if (dateFrom) url += `&flagged_at=gte.${encodeURIComponent(new Date(dateFrom).toISOString())}`;
  if (dateTo) {
    const end = new Date(dateTo);
    end.setDate(end.getDate() + 1);
    url += `&flagged_at=lte.${encodeURIComponent(end.toISOString())}`;
  }
  if (type) url += `&reason_category=eq.${encodeURIComponent(type)}`;

  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch flagged failed: ${res.status}`);
  let rows = await res.json();

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r =>
      String(r.app_id || '').includes(q) ||
      (r.reason_category || '').toLowerCase().includes(q) ||
      (r.reason_text || '').toLowerCase().includes(q) ||
      (r.source || '').toLowerCase().includes(q)
    );
  }

  return rows.map(r => ({
    ...r,
    // Map to field names the renderer expects
    title: `App ${r.app_id}`,
    flagged_reason: r.reason_category || null,
    is_hidden: false,
    _author: null,
  }));
}


export async function updateFlagStatus(session, id, status) {
  const url = `${SUPABASE_URL}/rest/v1/flagged_reports?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Update flag status failed: ${res.status}`);
}

export async function deleteFlaggedReport(session, id) {
  const url = `${SUPABASE_URL}/rest/v1/flagged_reports?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Delete flag failed: ${res.status}`);
}

// Legacy aliases kept so any other admin code that calls these still compiles
export const reinstateReport = (session, id) => updateFlagStatus(session, id, 'complete');
export const deleteReport = (session, id) => deleteFlaggedReport(session, id);

// --- Report-level moderation (Pulse reports only) -------------------------
// The flag row only references the report by (app_id, report_key). Resolve the
// underlying user_configs row id so we can shadow ban / release / delete the
// actual report content, not just the flag entry.
export async function findPulseConfigId(session, app_id, report_key) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?app_id=eq.${encodeURIComponent(app_id)}`
    + `&select=id,gpu,proton_version,created_at`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Lookup report failed: ${res.status}`);
  const rows = await res.json();
  const row = rows.find(r => {
    const ts = Math.floor(new Date(r.created_at).getTime() / 1000);
    const key = `${ts}:${(r.gpu || '').slice(0, 20)}:${(r.proton_version || '').slice(0, 15)}`;
    return key === report_key;
  });
  return row ? row.id : null;
}

// Current moderation state of a report so the detail view can show it and make
// Shadow ban a toggle. Returns { kind: 'pulse'|'mirror', state: 'visible'|'shadowbanned'|'deleted' }.
export async function fetchReportState(session, { app_id, report_key, source }) {
  // Pulse: does the user_configs row exist and is it hidden?
  try {
    const cfgUrl = `${SUPABASE_URL}/rest/v1/user_configs?app_id=eq.${encodeURIComponent(app_id)}`
      + `&select=id,gpu,proton_version,created_at,is_hidden`;
    const cfgRes = await fetch(cfgUrl, { headers: supabaseHeaders(session) });
    if (cfgRes.ok) {
      const rows = await cfgRes.json();
      const row = rows.find(r => {
        const ts = Math.floor(new Date(r.created_at).getTime() / 1000);
        return `${ts}:${(r.gpu || '').slice(0, 20)}:${(r.proton_version || '').slice(0, 15)}` === report_key;
      });
      if (row) return { kind: 'pulse', state: row.is_hidden ? 'shadowbanned' : 'visible' };
    }
  } catch { /* fall through to mirror check */ }
  // Mirror: is there a suppression row?
  try {
    const modUrl = `${SUPABASE_URL}/rest/v1/report_moderation?app_id=eq.${encodeURIComponent(app_id)}`
      + `&report_key=eq.${encodeURIComponent(report_key)}&source=eq.${encodeURIComponent(source || 'protondb')}&select=action`;
    const modRes = await fetch(modUrl, { headers: supabaseHeaders(session) });
    if (modRes.ok) {
      const rows = await modRes.json();
      if (rows.length) return { kind: 'mirror', state: rows[0].action === 'deleted' ? 'deleted' : 'shadowbanned' };
    }
  } catch { /* default below */ }
  const s = String(source || '').toLowerCase();
  return { kind: (s === 'pulse' || s === 'proton-pulse') ? 'pulse' : 'mirror', state: 'visible' };
}

async function _patchConfig(session, configId, body) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${configId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Update report failed: ${res.status}`);
}

// Shadow ban: hide the report from everyone except its submitter. The RLS
// policy "public read non-hidden configs" enforces the visibility.
export const shadowBanReport = (session, configId) =>
  _patchConfig(session, configId, { is_hidden: true, is_flagged: true });

// Release: the report is fine to keep. Clear the hidden + flagged state.
export const releaseReportContent = (session, configId) =>
  _patchConfig(session, configId, { is_hidden: false, is_flagged: false });

// Delete the actual report content (not just the flag entry).
export async function deleteReportContent(session, configId) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${configId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Delete report failed: ${res.status}`);
}

// --- Mirror report suppression (ProtonDB reports not in our DB) ------------
// ProtonDB reports come from the static mirror, so we cannot edit or delete
// them at the row level. Instead we record a suppression in report_moderation
// and the game page filters those out at render time. action is 'shadowban' or
// 'deleted' (both hide it from the site; the distinction is for the audit log).
export async function suppressMirrorReport(session, { flagId, appId, reportKey, source, action, flaggedAt, reason }) {
  // on_conflict names the unique key; without it PostgREST upserts on the PK and
  // a second action on the same report 409s instead of updating.
  const url = `${SUPABASE_URL}/rest/v1/report_moderation?on_conflict=app_id,report_key,source`;
  const res = await fetch(url, {
    method: 'POST',
    // merge-duplicates upserts on the (app_id, report_key, source) unique key
    headers: supabaseHeaders(session, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({
      flag_id: flagId ?? null,
      app_id: String(appId),
      report_key: reportKey,
      source: source || 'protondb',
      action: action || 'shadowban',
      flagged_at: flaggedAt ?? null,
      reason: reason ?? null,
    }),
  });
  if (!res.ok) throw new Error(`Suppress report failed: ${res.status}`);
}

export async function unsuppressMirrorReport(session, { appId, reportKey, source }) {
  const url = `${SUPABASE_URL}/rest/v1/report_moderation`
    + `?app_id=eq.${encodeURIComponent(appId)}`
    + `&report_key=eq.${encodeURIComponent(reportKey)}`
    + `&source=eq.${encodeURIComponent(source || 'protondb')}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Release report failed: ${res.status}`);
}

function _reportKey(r) {
  return `${r.timestamp}:${(r.gpu||'').slice(0,20)}:${(r.protonVersion||'').slice(0,15)}`;
}

export async function fetchFlagReportContent(session, { app_id, report_key, source }) {
  try {
    if (source === 'pulse' || source === 'proton-pulse') {
      const url = `${SUPABASE_URL}/rest/v1/user_configs?app_id=eq.${encodeURIComponent(app_id)}`
        + `&select=id,client_id,app_id,cpu,gpu,os,kernel,ram,proton_version,rating,duration,duration_minutes,notes,vram_mb,form_responses,created_at,updated_at,source`;
      const res = await fetch(url, { headers: supabaseHeaders(session) });
      if (!res.ok) return null;
      const rows = await res.json();
      const row = rows.find(r => {
        const ts = Math.floor(new Date(r.created_at).getTime() / 1000);
        const key = `${ts}:${(r.gpu||'').slice(0,20)}:${(r.proton_version||'').slice(0,15)}`;
        return key === report_key;
      });
      if (!row) return null;
      return {
        source:        row.source || 'proton-pulse',
        timestamp:     Math.floor(new Date(row.created_at).getTime() / 1000),
        rating:        row.rating || '',
        protonVersion: row.proton_version || '',
        gpu:           row.gpu || '',
        cpu:           row.cpu || '',
        os:            row.os || '',
        kernel:        row.kernel || '',
        ram:           row.ram || '',
        vramMb:        row.vram_mb ?? null,
        notes:         row.notes || '',
        duration:      row.duration || '',
        durationMinutes: row.duration_minutes ?? null,
        formResponses: row.form_responses ?? null,
      };
    }
    // ProtonDB: fetch CDN bundle
    const cdnBase = 'https://www.proton-pulse.com/data';
    const res = await fetch(`${cdnBase}/${encodeURIComponent(appIdToDir(app_id))}/latest.json`);
    if (!res.ok) return null;
    const reports = await res.json();
    const arr = Array.isArray(reports) ? reports : (reports.reports || reports.data || []);
    return arr.find(r => _reportKey(r) === report_key) || null;
  } catch {
    return null;
  }
}
