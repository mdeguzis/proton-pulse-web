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
  // #147: same fallback-title resolution the list view runs.
  await resolveFallbackTitles(rows);
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

  // #147: rows submitted before the title resolver knew the app (e.g. before
  // the extended Steam index landed) stored title="App <id>" as a fallback.
  // Repair the display title at fetch time so admins see the real name.
  await resolveFallbackTitles(rows);

  if (status === 'pending') return rows.filter(r => r.is_pending);
  if (status === 'clean')   return rows.filter(r => !r.is_pending);
  return rows;
}

// Title was stored as the fallback "App <id>" (or empty) at submit time
// because the resolver could not find the app yet. Patch in-memory from
// search-index.json so the table cell shows the real game name. Cached
// behind a module-level promise so repeat fetches are free.
let _searchIndexPromise = null;
function _loadSearchIndexForTitles() {
  if (!_searchIndexPromise) {
    // Safe under tests where location is not defined. In a browser the
    // hostname check picks the prod CDN when we are on localhost/gh-io
    // staging.
    const host = (typeof location !== 'undefined' && location.hostname) || '';
    const url = /^localhost|\.github\.io$/.test(host)
      ? 'https://www.proton-pulse.com/search-index.json'
      : '/search-index.json';
    _searchIndexPromise = fetch(url)
      .then(r => r.ok ? r.json() : [])
      .then(entries => {
        const map = new Map();
        if (Array.isArray(entries)) {
          for (const e of entries) {
            if (Array.isArray(e) && e[0] != null && e[1]) map.set(String(e[0]), e[1]);
          }
        }
        return map;
      })
      .catch(() => new Map());
  }
  return _searchIndexPromise;
}

function _isFallbackTitle(t, appId) {
  if (!t) return true;
  if (t === String(appId)) return true;
  return /^App \d+$/.test(t);
}

async function resolveFallbackTitles(rows) {
  const needs = rows.filter(r => _isFallbackTitle(r.title, r.app_id));
  if (!needs.length) return;
  const map = await _loadSearchIndexForTitles();
  for (const r of needs) {
    const real = map.get(String(r.app_id));
    if (real) r.title = real;
  }
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

// Exact row counts per moderation status, for the Reports panel summary strip.
// Uses PostgREST's count=exact (the total comes back in the Content-Range
// header as "0-0/<total>"). pending = clean rows minus approved rows -- an
// approval row means the report was approved at least once; flagged/hidden are
// rare so this is a close, cheap dashboard figure without a DB function.
async function _count(session, table, selectCol, filter) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=${selectCol}${filter}`,
    { headers: supabaseHeaders(session, { Prefer: 'count=exact', Range: '0-0' }) },
  );
  if (!res.ok) return 0;
  const cr = res.headers.get('content-range') || '';
  const total = parseInt(cr.split('/')[1], 10);
  return Number.isFinite(total) ? total : 0;
}

export async function fetchStatusCounts(session) {
  // Exact counts via the DB function -- it does the approval join server-side,
  // so pending is precise even when a previously-approved report was later
  // flagged/hidden. Falls back to the cheap count-query approximation if the
  // RPC is unavailable (e.g. not migrated yet).
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_report_status_counts`, {
      method: 'POST',
      headers: supabaseHeaders(session, { 'Content-Type': 'application/json' }),
      body: '{}',
    });
    if (res.ok) {
      const rows = await res.json();
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (r && r.total != null) {
        return {
          total: Number(r.total) || 0,
          flagged: Number(r.flagged) || 0,
          hidden: Number(r.hidden) || 0,
          approved: Number(r.approved) || 0,
          pending: Number(r.pending) || 0,
        };
      }
    }
  } catch { /* fall through to the approximation */ }

  // Fallback. report_approvals is keyed by report_id (no `id` column), so the
  // count must select report_id -- a missing column 400s and returns 0.
  const [total, flagged, hidden, clean, approvals] = await Promise.all([
    _count(session, 'user_configs', 'id', ''),
    _count(session, 'user_configs', 'id', '&is_flagged=eq.true'),
    _count(session, 'user_configs', 'id', '&is_hidden=eq.true'),
    _count(session, 'user_configs', 'id', '&is_flagged=eq.false&is_hidden=eq.false'),
    _count(session, 'report_approvals', 'report_id', ''),
  ]);
  const pending = Math.max(0, clean - approvals);
  const approved = Math.max(0, clean - pending);
  return { total, flagged, hidden, pending, approved };
}
