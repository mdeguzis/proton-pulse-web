// Steam library helpers: read the cached row from user_steam_library and
// trigger a fresh sync via the sync-steam-library edge function (#199).
import { SUPABASE_URL } from '../config.js?v=87cd0f3d';
import { supabaseHeaders } from './supabase.js?v=4889c5e6';

export async function fetchMyLibraryRow(session) {
  if (!session?.access_token) return null;
  const url = `${SUPABASE_URL}/rest/v1/user_steam_library`
    + `?select=steam_id,game_count,appids,synced_at&limit=1`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.warn('[profile] fetchMyLibraryRow failed', { status: r.status, text, source: 'user_steam_library' });
    throw new Error(`HTTP ${r.status}`);
  }
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function syncMyLibrary(session) {
  if (!session?.access_token) throw new Error('Sign in required');
  const r = await fetch(`${SUPABASE_URL}/functions/v1/sync-steam-library`, {
    method: 'POST',
    headers: supabaseHeaders(session),
    body: '{}',
  });
  const text = await r.text();
  const payload = text ? (() => { try { return JSON.parse(text); } catch { return { error: text }; } })() : {};
  if (!r.ok) {
    console.warn('[profile] syncMyLibrary failed', { status: r.status, error: payload.error, source: 'sync-steam-library' });
    throw new Error(payload.error || `HTTP ${r.status}`);
  }
  return payload;
}
