// Per-user preference sync (#170).
//
// localStorage is the synchronous source of truth for rendering (zero-flash):
// the adult filter and topbar read it directly and can't await a network call.
// For signed-in users we additionally sync the value to a per-user
// user_preferences row in Supabase so the setting follows them across devices.
// Signed-out users use localStorage only.
//
// The Supabase side is a single jsonb `prefs` bag keyed by auth user id, so
// future prefs (theme, sort defaults, ...) reuse this module without schema
// changes. Writes read-modify-write the bag so unrelated keys are preserved.

export const SHOW_ADULT_KEY = 'pp:show-adult';

const SB_URL =
  (typeof window !== 'undefined' && window.SUPABASE_URL) ||
  'https://ilsgdshkaocrmibwdezk.supabase.co';

function _auth() {
  return (typeof window !== 'undefined' && window.SupaAuth) || null;
}

export function readShowAdultLocal() {
  try {
    return localStorage.getItem(SHOW_ADULT_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeShowAdultLocal(on) {
  try {
    localStorage.setItem(SHOW_ADULT_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode / storage disabled -- pref just won't persist */
  }
}

// Resolve { session, headers } when signed in, else null. Kept small so the
// callers stay tidy and the tests can stub window.SupaAuth.
async function _signedIn() {
  const sa = _auth();
  if (!sa) return null;
  try {
    const session = await sa.getSession();
    if (!session || !session.user || !session.user.id) return null;
    const headers = await sa.authHeaders();
    return { userId: session.user.id, headers };
  } catch {
    return null;
  }
}

// Persist a new value: immediate local write (zero-flash), then a server upsert
// when signed in. Returns { synced } so the UI can note whether it stored to the
// account. Merges into the existing prefs bag to preserve other keys.
export async function setShowAdult(on) {
  writeShowAdultLocal(on);
  const auth = await _signedIn();
  if (!auth) return { synced: false };
  try {
    const cur = await fetch(
      `${SB_URL}/rest/v1/user_preferences?user_id=eq.${auth.userId}&select=prefs`,
      { headers: auth.headers },
    );
    const rows = cur.ok ? await cur.json() : [];
    const prefs = { ...((rows[0] && rows[0].prefs) || {}), 'show-adult': on ? 'on' : 'off' };
    const res = await fetch(`${SB_URL}/rest/v1/user_preferences?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...auth.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: auth.userId, prefs, updated_at: new Date().toISOString() }),
    });
    return { synced: res.ok };
  } catch {
    return { synced: false };
  }
}

// Pull the server value into localStorage so this device reflects a change made
// on another one. Returns { changed, value }. No-op (reads local) when signed
// out or when the server has no stored value yet.
export async function pullShowAdult() {
  const auth = await _signedIn();
  if (!auth) return { changed: false, value: readShowAdultLocal() };
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/user_preferences?user_id=eq.${auth.userId}&select=prefs`,
      { headers: auth.headers },
    );
    if (!res.ok) return { changed: false, value: readShowAdultLocal() };
    const rows = await res.json();
    const serverVal = rows[0] && rows[0].prefs && rows[0].prefs['show-adult'];
    if (serverVal !== 'on' && serverVal !== 'off') {
      return { changed: false, value: readShowAdultLocal() };
    }
    const before = readShowAdultLocal();
    const next = serverVal === 'on';
    writeShowAdultLocal(next);
    return { changed: next !== before, value: next };
  } catch {
    return { changed: false, value: readShowAdultLocal() };
  }
}
