// Canonical-id helpers shared across pages that fetch per-game data from the
// static CDN. Mirrors scripts/pipeline/common.py app_id_to_dir so the frontend
// requests the same directory the pipeline writes.

/**
 * Convert a canonical app_id (e.g. 'gog:123', 'epic:abc', or '730') to the
 * filesystem-safe directory name used under /data/. Replaces ':' with '_' so
 * GOG and Epic IDs resolve to data/gog_123/ rather than data/gog:123/.
 *
 * Keep this in sync with scripts/pipeline/common.py app_id_to_dir.
 *
 * @param {string|number} appId
 * @returns {string}
 */
export function appIdToDir(appId) {
  // replaceAll -- String.replace with a string literal only replaces the
  // FIRST occurrence, so pgwiki:The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay
  // kept the second colon and 404'd on R2. Must match the Python
  // scripts/pipeline/common.py app_id_to_dir which uses str.replace.
  return String(appId).replace(/:/g, '_');
}
