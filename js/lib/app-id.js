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
  // (#406 pw_ hash ids contain no colons, so this is a no-op for them.)
  return String(appId).replace(/:/g, '_');
}

const _PW_ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * #406: deterministic short id for a PCGamingWiki page slug -- `pw_` + 8
 * base36 chars from the first 48 bits of sha256(slug). MUST stay
 * byte-identical to scripts/pipeline/pcgamingwiki_catalog.py slug_to_pw_id;
 * the router uses it to redirect legacy #/app/pgwiki:<slug> URLs without
 * fetching the id map.
 *
 * Async because SubtleCrypto is. Callers on the redirect path already
 * await route resolution.
 *
 * @param {string} slug - wiki page slug (spaces already underscored)
 * @returns {Promise<string>} e.g. 'pw_xd71ad9b'
 */
export async function pcgwSlugToPwId(slug) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(slug)));
  const b = new Uint8Array(digest);
  // First 6 bytes as a 48-bit integer. 48 bits exceeds 2^32, so build it
  // with multiplication (bitwise ops in JS truncate to 32 bits).
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + b[i];
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += _PW_ID_CHARS[n % 36];
    n = Math.floor(n / 36);
  }
  return 'pw_' + out;
}
