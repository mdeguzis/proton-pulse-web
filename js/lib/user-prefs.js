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
// Corner ownership badges (library / wishlist) on browse-card artwork.
// Opt-in only: default off. Syncs to the same user_preferences bag when
// signed in so a toggle on one device follows the user to the next.
export const SHOW_OWNER_BADGES_KEY = 'pp:show-owner-badges';

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

// ---------- Generic boolean pref sync (#266 groundwork) -----------------
// Everything below reuses the same jsonb bag on user_preferences with a
// caller-supplied key (e.g. "show-owner-badges"). Local storage caches
// the value under `pp:<key>` so first paint is zero-flash; the async
// pull-from-server updates only when the server has a stored value AND
// it differs from local. Signed-out users stay on localStorage only.
// Adding a new synced boolean pref: pick a key, define read/write local
// wrappers if you want typed API, then call setPrefBool / pullPrefBool.

export function readPrefBoolLocal(key, dflt = false) {
  try {
    const raw = localStorage.getItem(`pp:${key}`);
    if (raw === 'on') return true;
    if (raw === 'off') return false;
    return dflt;
  } catch { return dflt; }
}

export function writePrefBoolLocal(key, on) {
  try { localStorage.setItem(`pp:${key}`, on ? 'on' : 'off'); } catch { /* private mode */ }
}

export async function setPrefBool(key, on) {
  writePrefBoolLocal(key, on);
  const auth = await _signedIn();
  if (!auth) return { synced: false };
  try {
    const cur = await fetch(
      `${SB_URL}/rest/v1/user_preferences?user_id=eq.${auth.userId}&select=prefs`,
      { headers: auth.headers },
    );
    const rows = cur.ok ? await cur.json() : [];
    const prefs = { ...((rows[0] && rows[0].prefs) || {}), [key]: on ? 'on' : 'off' };
    const res = await fetch(`${SB_URL}/rest/v1/user_preferences?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...auth.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: auth.userId, prefs, updated_at: new Date().toISOString() }),
    });
    return { synced: res.ok };
  } catch { return { synced: false }; }
}

export async function pullPrefBool(key, dflt = false) {
  const auth = await _signedIn();
  const localValue = readPrefBoolLocal(key, dflt);
  if (!auth) return { changed: false, value: localValue };
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/user_preferences?user_id=eq.${auth.userId}&select=prefs`,
      { headers: auth.headers },
    );
    if (!res.ok) return { changed: false, value: localValue };
    const rows = await res.json();
    const serverVal = rows[0] && rows[0].prefs && rows[0].prefs[key];
    if (serverVal !== 'on' && serverVal !== 'off') return { changed: false, value: localValue };
    const next = serverVal === 'on';
    writePrefBoolLocal(key, next);
    return { changed: next !== localValue, value: next };
  } catch { return { changed: false, value: localValue }; }
}

// Named helpers for the corner-badge pref (#266 refinement).
export function readShowOwnerBadgesLocal() { return readPrefBoolLocal('show-owner-badges', false); }
export function setShowOwnerBadges(on)     { return setPrefBool('show-owner-badges', on); }
export function pullShowOwnerBadges()      { return pullPrefBool('show-owner-badges', false); }
