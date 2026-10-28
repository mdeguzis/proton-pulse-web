// Read-only lookup of the game_hides table for the app-page frontend.
// Admin-facing writes live in js/admin/api/gameManager.js; the anon SELECT
// policy on the table lets browse / search / game-page reject hidden
// appids without needing a user session. Cached once per page load in a
// Promise so parallel callers share a single fetch.
import { SB_URL, SB_KEY } from '../config.js?v=7873e060';

let _hidesPromise = null;

/**
 * Returns a Set<string> of hidden app_ids. Empty Set on any error so a
 * failed fetch never blocks the whole browse experience.
 */
export function loadGameHides() {
  if (_hidesPromise) return _hidesPromise;
  _hidesPromise = (async () => {
    try {
      const url = `${SB_URL}/game_hides?select=app_id`;
      const r = await fetch(url, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
        cache: 'no-store',
      });
      if (!r.ok) {
        // Best effort: a failed lookup shows hidden games rather than
        // blocking browse, so say so loudly.
        console.warn('[game-hides] fetch failed, hidden games will show', { status: r.status, source: 'game_hides' });
        return new Set();
      }
      const rows = await r.json();
      const set = new Set();
      for (const row of (Array.isArray(rows) ? rows : [])) {
        if (row?.app_id) set.add(String(row.app_id));
      }
      console.debug('[game-hides] loaded', { count: set.size });
      return set;
    } catch (e) {
      console.warn('[game-hides] threw, hidden games will show', { error: e?.message, source: 'game_hides' });
      return new Set();
    }
  })();
  return _hidesPromise;
}

/** Force a refresh next call. Used after admin edits in the same session. */
export function invalidateGameHides() { _hidesPromise = null; }

/** Drop hidden app ids from a list of rows (#238). getId reads a row's id. */
export function withoutHidden(rows, hides, getId) {
  if (!hides || hides.size === 0) return rows;
  return (rows || []).filter((row) => !hides.has(String(getId(row))));
}

// ---- game_remaps (#238) --------------------------------------------------
// Admin-curated "from_app_id now lives at to_app_id". Only the public
// columns are read (#570 hides remapped_by from clients).

let _remapsPromise = null;

/**
 * Map<from_app_id, { to, reason }>. Empty Map on failure, logged: a failed
 * lookup just leaves the user on the page they asked for.
 */
export function loadGameRemaps() {
  if (_remapsPromise) return _remapsPromise;
  _remapsPromise = (async () => {
    try {
      const url = `${SB_URL}/game_remaps?select=from_app_id,to_app_id,reason`;
      const r = await fetch(url, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
        cache: 'no-store',
      });
      if (!r.ok) {
        console.warn('[game-remaps] fetch failed, remaps not followed', { status: r.status, source: 'game_remaps' });
        return new Map();
      }
      const rows = await r.json();
      const map = new Map();
      for (const row of (Array.isArray(rows) ? rows : [])) {
        if (row?.from_app_id && row?.to_app_id) {
          map.set(String(row.from_app_id), { to: String(row.to_app_id), reason: row.reason || '' });
        }
      }
      console.debug('[game-remaps] loaded', { count: map.size });
      return map;
    } catch (e) {
      console.warn('[game-remaps] threw, remaps not followed', { error: e?.message, source: 'game_remaps' });
      return new Map();
    }
  })();
  return _remapsPromise;
}

// App ids are numeric or store-prefixed (gog:123, epic:Name, pw_abc).
const SAFE_APP_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/**
 * Follow remaps from appId. Returns { target, reason, hops } or null when
 * appId isn't remapped. Stops at maxHops and on a loop (returns null, so a
 * bad admin edit can't bounce the page forever), and ignores a target that
 * isn't a plain app id.
 */
export function resolveRemap(appId, remaps, maxHops = 3) {
  if (!remaps || remaps.size === 0) return null;
  const start = String(appId);
  const seen = new Set([start]);
  let current = start;
  let first = null;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const next = remaps.get(current);
    if (!next) break;
    if (!SAFE_APP_ID.test(next.to) || seen.has(next.to)) return null;
    if (!first) first = next;
    seen.add(next.to);
    current = next.to;
  }
  if (current === start) return null;
  return { target: current, reason: first ? first.reason : '', hops: seen.size - 1 };
}

export function invalidateGameRemaps() { _remapsPromise = null; }

