// Compute a per-type breakdown ({game, dlc, mod, demo, software, unknown})
// for a Set of appids by intersecting them with the pipeline-published
// steam-type-cache.json map. Loaded once per page; reused by the Library
// and Wishlist cards on profile.html (#266 stats).
//
// The cache is a plain object: { "<appId>": "<type>" }. Missing appids
// bucket into "unknown" so a partial cache degrades gracefully -- the
// enricher is still filling in ~35k apps as of writing (#258 / #261).
// A missing or unreadable cache file is an error, not an empty cache.
import { dataUrl } from '../../lib/data-url.js?v=9ba434e3';

const KNOWN_TYPES = ['game', 'dlc', 'demo', 'mod', 'software', 'advertising', 'video'];

let _cache = null;
let _cachePromise = null;

async function _loadTypeCache() {
  if (_cache) return _cache;
  if (_cachePromise) return _cachePromise;
  // Reject instead of resolving {} (#569): an unpublished file comes back
  // from Pages as the SPA HTML with a 200, and treating that as "no types
  // cached" silently showed every app as unknown. Callers catch and hide
  // the type line; a failed load is retried on the next call.
  _cachePromise = dataUrl('steam-type-cache.json')
    .then((url) => fetch(url))
    .then(async (r) => {
      if (!r.ok) throw new Error(`steam-type-cache.json HTTP ${r.status}`);
      const type = (r.headers && typeof r.headers.get === 'function' && r.headers.get('content-type')) || '';
      if (type.includes('text/html')) throw new Error('steam-type-cache.json returned HTML (file not published)');
      const m = await r.json();
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('steam-type-cache.json is not an object map');
      return m;
    })
    .then(
      (m) => { _cache = m; return _cache; },
      (e) => { _cachePromise = null; throw e; },
    );
  return _cachePromise;
}

/**
 * Returns { total, cached, uncached, counts: {game, dlc, ...}, order }
 * given an iterable of appids. `counts` includes the seven known Steam
 * types plus an 'unknown' bucket (appids missing from the cache); `order`
 * is a stable, descending-by-count list of [type, count] pairs so the
 * caller can render "421 game . 47 dlc . ..." consistently.
 */
export async function computeTypeBreakdown(appIds) {
  const cache = await _loadTypeCache();
  const counts = { unknown: 0 };
  for (const t of KNOWN_TYPES) counts[t] = 0;
  let total = 0;
  let cached = 0;
  for (const id of appIds || []) {
    total += 1;
    const t = cache[String(id)];
    if (t && KNOWN_TYPES.includes(t)) {
      counts[t] += 1;
      cached += 1;
    } else if (t) {
      // Enricher emits a type we don't have a bucket for -- park it under
      // 'unknown' so the total still reconciles.
      counts.unknown += 1;
    } else {
      counts.unknown += 1;
    }
  }
  const order = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return { total, cached, uncached: total - cached, counts, order };
}

/**
 * Per-app Steam type for a list of appids (#251), from the same cached
 * steam-type-cache.json the breakdown uses. Returns { "<appId>": type } with
 * only the appids the cache knows; callers show nothing for the rest rather
 * than guessing. Note "mod" is the raw Steam type: total conversions such as
 * Black Mesa are games in practice, so show it as a label, not a verdict.
 */
export async function steamTypesFor(appIds) {
  const cache = await _loadTypeCache();
  const out = {};
  for (const id of appIds || []) {
    const t = cache[String(id)];
    if (t) out[String(id)] = t;
  }
  return out;
}

// Escape hatch for tests / debug tools that want to inspect the raw map.
export function _peekCache() { return _cache; }
