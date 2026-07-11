// Read-only lookup of the game_hides table for the app-page frontend.
// Admin-facing writes live in js/admin/api/gameManager.js; the anon SELECT
// policy on the table lets browse / search / game-page reject hidden
// appids without needing a user session. Cached once per page load in a
// Promise so parallel callers share a single fetch.
import { SB_URL, SB_KEY } from '../config.js?v=f9591262';

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
        console.debug('[game-hides] fetch failed', { status: r.status });
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
      console.debug('[game-hides] threw', { error: e?.message });
      return new Set();
    }
  })();
  return _hidesPromise;
}

/** Force a refresh next call. Used after admin edits in the same session. */
export function invalidateGameHides() { _hidesPromise = null; }
