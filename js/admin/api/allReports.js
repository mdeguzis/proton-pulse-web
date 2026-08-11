import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=2668b2f0';
import { getGamesByIds } from '../../app/api/search-games.js?v=0e14d3ff';

// #48: flagged_reason on rows so the All Reports table can surface why a
// row was flagged. flagged_at on detail to show when the flag landed.
// installation_id is the Deck-plugin signature -- the web submit path never
// sets it -- so classifyReportSource can distinguish a real plugin
// submission from a web (or imported) row whose source string happens to be
// 'user' / 'protondb' / etc.
const COLS = 'id,app_id,title,client_id,proton_pulse_user_id,installation_id,rating,source,app_type,is_flagged,is_hidden,flagged_reason,created_at';
const DETAIL_COLS = 'id,app_id,title,client_id,proton_pulse_user_id,installation_id,rating,proton_version,cpu,gpu,gpu_driver,gpu_vendor,gpu_architecture,ram,vram_mb,os,kernel,duration,duration_minutes,notes,form_responses,config_key,game_owned,source,app_type,is_flagged,is_hidden,flagged_reason,flagged_at,created_at,updated_at';

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
  // Reporter identity for the admin detail view. Public reports show the author
  // as anonymous, but moderators need the real Steam profile to review. Resolve
  // it from author_avatars by proton_pulse_user_id (admins can read that table).
  const uid = rows[0].proton_pulse_user_id;
  if (uid) {
    try {
      const avRes = await fetch(
        `${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=eq.${encodeURIComponent(uid)}&select=display_name,steam_id&limit=1`,
        { headers: supabaseHeaders(session) },
      );
      if (avRes.ok) {
        const av = await avRes.json();
        if (av.length) {
          rows[0].steam_username = av[0].display_name || null;
          rows[0].steam_id = av[0].steam_id || null;
        }
      } else {
        console.warn('fetchReportById: author_avatars lookup failed', { uid, status: avRes.status });
      }
    } catch (e) {
      console.warn('fetchReportById: author_avatars lookup threw', { uid, error: String(e) });
    }
  }
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

  // Orphan flag rows -- flagged_reports entries whose report_key does not
  // resolve back to a live user_configs row (deleted report, account cleanup,
  // stale CDN mirror). Moderation history is permanent: a flag has to remain
  // reviewable + countable even if the underlying report is gone. Fetched
  // whenever the Flagged status is requested (or no filter at all so the
  // "all statuses" view surfaces them too). See migration
  // 20260811010000_flagged_reports_include_orphans.sql.
  const wantOrphans = status === 'flagged' || status === '';

  const [res, approvalRes, orphanRes] = await Promise.all([
    fetch(url, { headers: supabaseHeaders(session) }),
    // Approval rows are keyed by report_id. Existence = approved at least once.
    // The public app additionally compares the stored hash to the row's current
    // content (and hides the report on mismatch); the admin view treats any
    // approval row as "approved" so moderators can see edit history without
    // a stale-hash false negative.
    fetch(`${SUPABASE_URL}/rest/v1/report_approvals?select=report_id`, {
      headers: supabaseHeaders(session),
    }).catch(() => ({ ok: false })),
    wantOrphans
      ? fetch(`${SUPABASE_URL}/rest/v1/rpc/get_orphan_flag_reports`, {
          method: 'POST',
          headers: supabaseHeaders(session, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ p_app_id: search && /^\d+$/.test(search.trim()) ? search.trim() : null }),
        }).catch(() => ({ ok: false }))
      : Promise.resolve({ ok: false }),
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

  let out;
  if (status === 'pending')      out = rows.filter(r => r.is_pending);
  else if (status === 'clean')   out = rows.filter(r => !r.is_pending);
  else                            out = rows;

  // Merge orphan flags. Synthesize rows in the same shape the render expects,
  // marked with is_orphan_flag=true so the UI can badge them and route detail
  // clicks to the Flagged Reports tab (the underlying user_configs row is
  // gone -- there is no report detail to open, only the flag record).
  if (wantOrphans && orphanRes && orphanRes.ok) {
    let orphans = [];
    try { orphans = await orphanRes.json(); } catch { orphans = []; }
    // Optional client-side filters that were server-side above.
    if (appType) orphans = orphans.filter(o => (o.app_type || '') === appType || appType === 'steam');
    if (dateFrom) orphans = orphans.filter(o => o.flagged_at >= dateFrom);
    if (dateTo) orphans = orphans.filter(o => o.flagged_at <= dateTo + 'T23:59:59');
    if (search) {
      const s = search.trim().toLowerCase();
      orphans = orphans.filter(o => String(o.app_id || '').includes(s));
    }
    const synthetic = orphans.map(o => {
      // Parse the JS reportKey() format: "<int-epoch>:<gpu[:20]>:<proton[:15]>".
      // Fills the title cell with what the admin actually cares about (which
      // GPU + Proton got flagged) instead of a scary "deleted" label. The
      // report may or may not actually be deleted -- it might just be a stale
      // CDN mirror snapshot whose backing user_configs row is gone; either
      // way, the flag is real and the admin needs the details.
      const parts = String(o.report_key || '').split(':');
      const gpu = (parts[1] || '').trim();
      const proton = (parts[2] || '').trim();
      const titleBits = [];
      if (gpu) titleBits.push(gpu);
      if (proton) titleBits.push(proton);
      const title = titleBits.length ? titleBits.join(' / ') : '(no report details)';
      return {
        // Namespace the id so it never collides with a real user_configs.id.
        // The row-detail path checks is_orphan_flag before treating id as numeric.
        id: `flag-${o.id}`,
        app_id: o.app_id,
        title,
        source: o.source,
        app_type: 'steam',
        client_id: o.reporter_client_id || null,
        proton_pulse_user_id: null,
        installation_id: null,
        rating: null,
        is_flagged: true,
        is_hidden: false,
        is_pending: false,
        flagged_reason: o.reason_category || o.reason_text || null,
        flagged_at: o.flagged_at,
        created_at: o.flagged_at,
        report_key: o.report_key,
        reason_text: o.reason_text || null,
        is_orphan_flag: true,
      };
    });
    out = [...synthetic, ...out];
  }
  return out;
}

// Title was stored as the fallback "App <id>" (or empty) at submit time
// because the resolver could not find the app yet. Patch in-memory via the
// search-games batch API (#437) so the table cell shows the real game name.
// Only the ids that actually need a title are fetched, instead of pulling the
// whole 11.8MB search-index.json blob.
function _isFallbackTitle(t, appId) {
  if (!t) return true;
  if (t === String(appId)) return true;
  return /^App \d+$/.test(t);
}

async function resolveFallbackTitles(rows) {
  const needs = rows.filter(r => _isFallbackTitle(r.title, r.app_id));
  if (!needs.length) return;
  const byId = await getGamesByIds(needs.map(r => r.app_id));
  for (const r of needs) {
    const row = byId.get(String(r.app_id));
    if (row && row.title) r.title = row.title;
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
