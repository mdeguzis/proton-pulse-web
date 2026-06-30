import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=bd5a67c2';

// #48: flagged_reason on rows so the All Reports table can surface why a
// row was flagged. flagged_at on detail to show when the flag landed.
const COLS = 'id,app_id,title,client_id,proton_pulse_user_id,rating,source,app_type,is_flagged,is_hidden,flagged_reason,created_at';
const DETAIL_COLS = 'id,app_id,title,client_id,proton_pulse_user_id,rating,proton_version,cpu,gpu,gpu_driver,gpu_vendor,gpu_architecture,ram,vram_mb,os,kernel,duration,duration_minutes,notes,form_responses,config_key,game_owned,source,app_type,is_flagged,is_hidden,flagged_reason,flagged_at,created_at,updated_at';

export async function fetchReportById(session, id) {
  const [res, approvalRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${encodeURIComponent(id)}&select=${DETAIL_COLS}&limit=1`,
      { headers: supabaseHeaders(session) },
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/report_approvals?report_id=eq.${encodeURIComponent(id)}&select=report_id&limit=1`,
      { headers: supabaseHeaders(session) },
    ).catch(() => ({ ok: false })),
  ]);
  if (!res.ok) throw new Error(`Failed to fetch report: ${res.status}`);
  const rows = await res.json();
  if (!rows.length) throw new Error('Report not found');
  const approvals = approvalRes.ok ? await approvalRes.json() : [];
  rows[0].is_pending = approvals.length === 0;
  return rows[0];
}

export async function fetchAllReports(session, { search = '', status = 'clean', appType = '', dateFrom = '', dateTo = '', limit = 500 } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/user_configs?select=${COLS}&order=created_at.desc&limit=${limit}`;

  if (search) {
    const q = encodeURIComponent(search.trim());
    url += `&or=(app_id.eq.${q},title.ilike.*${q}*)`;
  }

  // Hard server-side filters (cheap). 'pending' and 'clean' both need to know
  // about report_approvals, so they're applied client-side below.
  if (status === 'flagged') url += '&is_flagged=eq.true';
  if (status === 'hidden')  url += '&is_hidden=eq.true';
  if (status === 'clean' || status === 'pending') url += '&is_flagged=eq.false&is_hidden=eq.false';

  if (appType) url += `&app_type=eq.${encodeURIComponent(appType)}`;

  if (dateFrom) url += `&created_at=gte.${encodeURIComponent(dateFrom)}`;
  if (dateTo)   url += `&created_at=lte.${encodeURIComponent(dateTo + 'T23:59:59')}`;

  const [res, approvalRes] = await Promise.all([
    fetch(url, { headers: supabaseHeaders(session) }),
    // Approval rows are keyed by report_id. Existence = approved at least once.
    // The public app additionally compares the stored hash to the row's current
    // content (and hides the report on mismatch); the admin view treats any
    // approval row as "approved" so moderators can see edit history without
    // a stale-hash false negative.
    fetch(`${SUPABASE_URL}/rest/v1/report_approvals?select=report_id`, {
      headers: supabaseHeaders(session),
    }).catch(() => ({ ok: false })),
  ]);
  if (!res.ok) throw new Error(`Failed to fetch reports: ${res.status}`);

  const rows = await res.json();
  const approvals = approvalRes.ok ? await approvalRes.json() : [];
  const approvedIds = new Set(approvals.map(a => a.report_id));

  for (const row of rows) row.is_pending = !approvedIds.has(row.id);

  if (status === 'pending') return rows.filter(r => r.is_pending);
  if (status === 'clean')   return rows.filter(r => !r.is_pending);
  return rows;
}

export async function patchReportFlags(session, id, patch) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`Patch failed: ${res.status}`);
}
