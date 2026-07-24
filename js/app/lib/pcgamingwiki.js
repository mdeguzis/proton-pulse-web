// PCGamingWiki lookup (#377 slice 2).
//
// Reads data/pcgamingwiki.json published nightly by the pipeline. Format:
//   { "<steamAppId>": { "os": ["windows"|"linux"|"os x"|"dos", ...],
//                       "engine": "Unreal Engine 4" | null } }
//
// Data source: pcgamingwiki.com (CC BY-NC-SA 3.0). Any user-facing surface
// that shows this data must credit PCGamingWiki and link back to the source
// -- the metadata modal renders a "Source: PCGamingWiki" line for this
// reason. This lib stays tiny on purpose: memoized fetch + null-safe getter.

import { dataUrl } from '../../lib/data-url.js?v=0de73aed';

let _cache = null;
let _pending = null;

/**
 * Load + memoize the PCGamingWiki table. Never throws -- a missing or 404
 * response resolves to an empty {} so the modal quietly hides the section
 * when no data is available for the current build.
 */
export async function loadPCGamingWikiMap() {
  if (_cache !== null) return _cache;
  if (_pending) return _pending;
  _pending = (async () => {
    try {
      const url = await dataUrl('pcgamingwiki.json');
      const res = await fetch(url);
      if (!res.ok) return {};
      const data = await res.json();
      return (data && typeof data === 'object') ? data : {};
    } catch {
      return {};
    }
  })().then((m) => { _cache = m; _pending = null; return m; });
  return _pending;
}

/**
 * Return the entry for one Steam appId or null if we do not have data for it.
 */
export async function getPCGamingWikiForApp(appId) {
  const map = await loadPCGamingWikiMap();
  return map[String(appId)] || null;
}

const _OS_LABEL = {
  'windows': 'Windows',
  'os x': 'macOS',
  'linux': 'Linux',
  'dos': 'DOS',
};

/**
 * Human copy for one OS string so the modal does not shove the raw lowercase
 * value into a chip. Falls back to the input capitalized so an unknown enum
 * value still renders.
 */
export function humanPCGamingWikiOs(os) {
  const key = String(os || '').toLowerCase();
  if (_OS_LABEL[key]) return _OS_LABEL[key];
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : '';
}

/**
 * Build the search URL back to pcgamingwiki.com for a game title. Used as
 * the attribution link since our published data intentionally does not
 * carry a page name (search-index cols stay tight).
 */
export function pcgamingwikiSearchUrl(title) {
  const q = encodeURIComponent(String(title || ''));
  return `https://www.pcgamingwiki.com/w/index.php?search=${q}`;
}
