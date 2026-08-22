// Shared filter storage (#415 slice 2).
//
// The browse home page, per-game report page, and index page each carry
// their own filter surface (multi-select pill groups vs single-select
// dropdowns), but three fields have consistent semantics across all of
// them: rating / tier, source, and store. When the "Apply across the
// site" checkbox is ticked and the user presses Save, those three fields
// land in ONE key so every page that renders the same field reads it as
// the initial state on next load.
//
// Contract:
//   readShared()      -> { rating: string|Set<string>, source: ..., store: ..., _enabled: bool }
//   writeShared(obj)  -> { rating, source, store } shape; also flips _enabled true
//   clearShared()     -> drops the key entirely (unchecking the box + Save)
//   isEnabled()       -> reads the enabled flag without touching the snapshot
//
// Fields are stored as arrays (or scalars, both accepted on read) so
// multi-select pages (home) and single-select pages (game) can round-trip
// their state without losing information. Callers normalise as needed.

export const SHARED_KEY = 'pp:filters-shared';
export const SHARED_ENABLED_KEY = 'pp:filters-shared-enabled';

/**
 * Read the shared filter snapshot, or null when nothing is persisted or the
 * feature is disabled. Missing / malformed values return null so callers can
 * always short-circuit with `if (!shared) return`.
 */
export function readShared() {
  try {
    if (localStorage.getItem(SHARED_ENABLED_KEY) !== '1') return null;
    const raw = localStorage.getItem(SHARED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/**
 * Write the shared filter snapshot AND flip the enabled flag on. `partial`
 * accepts any subset of { rating, source, store } as scalars or arrays.
 * Callers that only own some fields (e.g. game page has no store filter)
 * pass just what they know.
 */
export function writeShared(partial) {
  if (!partial || typeof partial !== 'object') return;
  try {
    const existing = _readRawSnapshot() || {};
    // Merge so partial writes from different pages compose. E.g. the game
    // page setting rating + source does not stomp on the store the browse
    // page previously wrote.
    const merged = { ...existing };
    for (const k of ['rating', 'source', 'store']) {
      if (partial[k] !== undefined) merged[k] = partial[k];
    }
    localStorage.setItem(SHARED_KEY, JSON.stringify(merged));
    localStorage.setItem(SHARED_ENABLED_KEY, '1');
  } catch { /* quota / disabled - ignore */ }
}

/**
 * Drop the shared key + flag. Used when the user unticks "Apply across the
 * site" and presses Save.
 */
export function clearShared() {
  try {
    localStorage.removeItem(SHARED_KEY);
    localStorage.removeItem(SHARED_ENABLED_KEY);
  } catch { /* ignore */ }
}

/**
 * Whether the site-wide preference is currently on. Handy for rendering
 * the initial checkbox state without pulling the whole snapshot.
 */
export function isEnabled() {
  try { return localStorage.getItem(SHARED_ENABLED_KEY) === '1'; }
  catch { return false; }
}

/**
 * Convenience: pull a single field, normalising to an array. Consumers
 * that want a scalar can take `[0]` off the result. Returns [] when the
 * field is unset or the shared snapshot itself is missing.
 */
export function readSharedField(name) {
  const shared = readShared();
  if (!shared) return [];
  const v = shared[name];
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter(Boolean) : [String(v)];
}

function _readRawSnapshot() {
  try {
    const raw = localStorage.getItem(SHARED_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// CommonJS mirror so unit tests can require() the module directly.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SHARED_KEY,
    SHARED_ENABLED_KEY,
    readShared,
    writeShared,
    clearShared,
    isEnabled,
    readSharedField,
  };
}
