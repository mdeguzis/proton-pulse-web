// Admin API client for the Game Manager panel (#234).
//
// Two tables: game_hides (blacklist) and game_remaps (from_app_id -> to_app_id).
// Both keyed on app_id TEXT so they work for Steam numeric ids and the
// prefixed non-Steam ids (`gog:123`, `epic:MyGame`).
//
// RLS gates every write on manage_games (super_admin gets it too). We still
// send the Authorization header so the RLS check has an authenticated caller.

import { SupaAuth, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=2668b2f0';

const SB = `${SUPABASE_URL}/rest/v1`;

async function _authedHeaders() {
  const session = await SupaAuth.getSession().catch(() => null);
  return supabaseHeaders(session);
}

// ── game_hides ─────────────────────────────────────────────────────────

/**
 * List every game hide, newest first. Returns an array of
 * { app_id, reason, hidden_by, hidden_at } rows (empty on error).
 */
export async function listGameHides() {
  try {
    const headers = await _authedHeaders();
    const res = await fetch(
      `${SB}/game_hides?select=app_id,reason,hidden_by,hidden_at&order=hidden_at.desc`,
      { headers, cache: 'no-store' },
    );
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/**
 * Add or update a hide entry. `reason` is required (RLS + panel enforce it).
 * Uses Prefer: resolution=merge-duplicates so a re-hide with a new reason
 * updates in place instead of failing on the primary key.
 */
export async function upsertGameHide(appId, reason) {
  if (!appId || !reason?.trim()) {
    return { ok: false, error: 'app_id and reason are required' };
  }
  const session = await SupaAuth.getSession().catch(() => null);
  const headers = {
    ...supabaseHeaders(session),
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  };
  const body = JSON.stringify([{
    app_id:    String(appId),
    reason:    reason.trim(),
    hidden_by: session?.user?.id || null,
  }]);
  try {
    const res = await fetch(`${SB}/game_hides?on_conflict=app_id`, {
      method: 'POST', headers, body, cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const rows = await res.json().catch(() => []);
    return { ok: true, row: rows[0] || null };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

/** Remove a hide entry so the game becomes visible again. */
export async function deleteGameHide(appId) {
  if (!appId) return { ok: false, error: 'app_id is required' };
  try {
    const headers = await _authedHeaders();
    const res = await fetch(
      `${SB}/game_hides?app_id=eq.${encodeURIComponent(String(appId))}`,
      { method: 'DELETE', headers, cache: 'no-store' },
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// ── game_remaps ────────────────────────────────────────────────────────

/**
 * List every remap, newest first. Returns an array of
 * { from_app_id, to_app_id, reason, remapped_by, created_at, updated_at } rows.
 */
export async function listGameRemaps() {
  try {
    const headers = await _authedHeaders();
    const res = await fetch(
      `${SB}/game_remaps?select=from_app_id,to_app_id,reason,remapped_by,created_at,updated_at&order=updated_at.desc`,
      { headers, cache: 'no-store' },
    );
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/**
 * Set or replace a remap. Panel-side validation guards against the self-loop
 * that the DB CHECK constraint would also catch; we do it here too so the
 * error message is friendlier.
 */
export async function upsertGameRemap(fromAppId, toAppId, reason) {
  if (!fromAppId || !toAppId || !reason?.trim()) {
    return { ok: false, error: 'from_app_id, to_app_id, and reason are required' };
  }
  if (String(fromAppId) === String(toAppId)) {
    return { ok: false, error: 'from and to app ids must differ' };
  }
  const session = await SupaAuth.getSession().catch(() => null);
  const headers = {
    ...supabaseHeaders(session),
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  };
  const body = JSON.stringify([{
    from_app_id: String(fromAppId),
    to_app_id:   String(toAppId),
    reason:      reason.trim(),
    remapped_by: session?.user?.id || null,
  }]);
  try {
    const res = await fetch(`${SB}/game_remaps?on_conflict=from_app_id`, {
      method: 'POST', headers, body, cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const rows = await res.json().catch(() => []);
    return { ok: true, row: rows[0] || null };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

/** Remove a remap so the original app id resolves to itself again. */
export async function deleteGameRemap(fromAppId) {
  if (!fromAppId) return { ok: false, error: 'from_app_id is required' };
  try {
    const headers = await _authedHeaders();
    const res = await fetch(
      `${SB}/game_remaps?from_app_id=eq.${encodeURIComponent(String(fromAppId))}`,
      { method: 'DELETE', headers, cache: 'no-store' },
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// ── Pipeline-flagged suspects (read-only) ─────────────────────────────

/**
 * Load the pipeline's app-id-redirects.json (produced by #233's validator).
 * Returns { <appId>: { status, replaced_by?, final_url? }, ... } or {} if
 * the file isn't published yet.
 */
export async function loadPipelineSuspects() {
  try {
    // The pipeline writes this file at the origin's data root during finalize.
    // Fetching relative keeps it on the current origin (staging vs prod).
    const parts = location.pathname.split('/').filter(Boolean);
    const base = parts[0] === 'proton-pulse-web' ? '/proton-pulse-web'
              : parts[0] === 'proton-pulse-web-staging' ? '/proton-pulse-web-staging'
              : '';
    const res = await fetch(`${base}/app-id-redirects.json`, { cache: 'no-store' });
    if (!res.ok) return {};
    return await res.json();
  } catch { return {}; }
}
