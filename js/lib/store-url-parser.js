// Parse a Steam / GOG / Epic store URL into { store, appId, slug, canonicalId }.
//
// The topbar search, the app-page grouped search dispatch, and the submit
// form's app-id field all take user input. Today they only handle numeric
// Steam ids and title text -- pasting a store URL gets treated as free text
// and misses the exact match. This parser runs before that dispatch so a
// URL routes straight to the game's page.
//
// Steam URLs carry the canonical Steam appId directly in the path. GOG and
// Epic URLs carry a human slug instead (canonical id lookup requires the
// catalog files; that resolution is a caller concern, not this parser's).
//
// Returns null if the input isn't a recognised store URL so the caller can
// fall back to free-text search.

const STEAM_HOSTS = new Set([
  'store.steampowered.com',
  'steamcommunity.com',
  's.team',
]);
const GOG_HOSTS = new Set(['www.gog.com', 'gog.com']);
const EPIC_HOSTS = new Set(['store.epicgames.com', 'www.epicgames.com']);

const LOCALE_RE = /^[a-z]{2}(-[a-z]{2})?$/i;

function _tryUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // Accept bare host-less input (e.g. store.steampowered.com/app/...) too --
  // users often strip the protocol when pasting.
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withProto);
  } catch {
    return null;
  }
}

// Extract Steam appId from any of:
//   /app/480490
//   /app/480490/
//   /app/480490/Prey/
//   /sub/12345 (package -- skipped; we don't index those)
//   /agecheck/app/480490 (age gate wrapper)
function _steamFromUrl(u) {
  const parts = u.pathname.split('/').filter(Boolean);
  // Walk the parts looking for an "app" segment followed by a numeric id.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toLowerCase() === 'app') {
      const id = parts[i + 1];
      if (/^\d+$/.test(id)) return { store: 'steam', appId: id, canonicalId: id, slug: null };
    }
  }
  return null;
}

// GOG URL shapes:
//   https://www.gog.com/en/game/star_wars_knights_of_the_old_republic
//   https://www.gog.com/game/witcher_3          (no locale)
//   https://www.gog.com/en/movie/...            (not a game -- skip)
// The slug is not the canonical id we store (which is gog:<numericProductId>).
// Callers that need the canonical id look up the slug in gog-catalog-cache.json.
function _gogFromUrl(u) {
  const parts = u.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  // Optional locale prefix ("en", "de", "pt-br", etc.).
  let idx = 0;
  if (LOCALE_RE.test(parts[0])) idx = 1;
  if (parts[idx] !== 'game') return null;
  const slug = parts[idx + 1];
  if (!slug) return null;
  return { store: 'gog', appId: null, canonicalId: null, slug };
}

// Epic URL shapes:
//   https://store.epicgames.com/en-US/p/portal-2-cf80c3
//   https://store.epicgames.com/p/portal-2                 (no locale)
//   https://store.epicgames.com/en-US/product/portal-2     (older /product/ path)
// Same slug -> canonical (epic:<namespace>) resolution note as GOG.
function _epicFromUrl(u) {
  const parts = u.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  let idx = 0;
  if (LOCALE_RE.test(parts[0])) idx = 1;
  const kind = parts[idx];
  if (kind !== 'p' && kind !== 'product') return null;
  const slug = parts[idx + 1];
  if (!slug) return null;
  return { store: 'epic', appId: null, canonicalId: null, slug };
}

export function parseStoreUrl(input) {
  const u = _tryUrl(input);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (STEAM_HOSTS.has(host)) return _steamFromUrl(u);
  if (GOG_HOSTS.has(host))   return _gogFromUrl(u);
  if (EPIC_HOSTS.has(host))  return _epicFromUrl(u);
  return null;
}
