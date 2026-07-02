// Shared Supabase REST header builder for the profile page api layer.
import { SUPABASE_ANON_KEY } from '../config.js?v=87cd0f3d';

export function supabaseHeaders(session, extra) {
  const h = {
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
  // When signed in, use the user's access token so RLS sees them as authed.
  // Fall back to the anon key for pre-login reads.
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  else h.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return Object.assign(h, extra || {});
}
