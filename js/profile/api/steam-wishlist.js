// Wishlist helpers: read the cached row from user_steam_wishlist and
// trigger a fresh sync via the sync-steam-wishlist edge function (#266).
// Mirrors steam-library.js so both cards behave the same on profile.html.
import { SUPABASE_URL } from '../config.js?v=87cd0f3d';
import { supabaseHeaders } from './supabase.js?v=4889c5e6';

export async function fetchMyWishlistRow(session) {
  if (!session?.access_token) return null;
  const url = `${SUPABASE_URL}/rest/v1/user_steam_wishlist`
    + `?select=steam_id,item_count,appids,synced_at&limit=1`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.warn('[profile] fetchMyWishlistRow failed', { status: r.status, text, source: 'user_steam_wishlist' });
    throw new Error(`HTTP ${r.status}`);
  }
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function syncMyWishlist(session) {
  if (!session?.access_token) throw new Error('Sign in required');
  const r = await fetch(`${SUPABASE_URL}/functions/v1/sync-steam-wishlist`, {
    method: 'POST',
    headers: supabaseHeaders(session),
    body: '{}',
  });
  const text = await r.text();
  const payload = text ? (() => { try { return JSON.parse(text); } catch { return { error: text }; } })() : {};
  if (!r.ok) {
    console.warn('[profile] syncMyWishlist failed', { status: r.status, error: payload.error, source: 'sync-steam-wishlist' });
    throw new Error(payload.error || `HTTP ${r.status}`);
  }
  return payload;
}
