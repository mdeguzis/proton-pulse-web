// flagged (api) for the admin page.

import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=86489fcb';

export async function fetchFlaggedReports(session, { search, type, dateFrom, dateTo, sortField, sortDir } = {}) {
  // Query the unified flagged_reports log (covers both ProtonDB and Pulse reports)
  let url = `${SUPABASE_URL}/rest/v1/flagged_reports`
    + `?select=id,app_id,report_key,source,reason_category,reason_text,status,reporter_client_id,flagged_at`
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
    const res = await fetch(`${cdnBase}/${encodeURIComponent(app_id)}/latest.json`);
    if (!res.ok) return null;
    const reports = await res.json();
    const arr = Array.isArray(reports) ? reports : (reports.reports || reports.data || []);
    return arr.find(r => _reportKey(r) === report_key) || null;
  } catch {
    return null;
  }
}
