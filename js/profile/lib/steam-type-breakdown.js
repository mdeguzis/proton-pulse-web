// Compute a per-type breakdown ({game, dlc, mod, demo, software, unknown})
// for a Set of appids by intersecting them with the pipeline-published
// steam-type-cache.json map. Loaded once per page; reused by the Library
// and Wishlist cards on profile.html (#266 stats).
//
// The cache is a plain object: { "<appId>": "<type>" }. Missing appids
// bucket into "unknown" so a partial cache degrades gracefully -- the
// enricher is still filling in ~35k apps as of writing (#258 / #261).
import { dataUrl } from '../../lib/data-url.js?v=97f09986';

const KNOWN_TYPES = ['game', 'dlc', 'demo', 'mod', 'software', 'advertising', 'video'];

let _cache = null;
let _cachePromise = null;

async function _loadTypeCache() {
  if (_cache) return _cache;
  if (_cachePromise) return _cachePromise;
  _cachePromise = dataUrl('steam-type-cache.json')
    .then((url) => fetch(url))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((m) => { _cache = (m && typeof m === 'object') ? m : {}; return _cache; });
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

// Escape hatch for tests / debug tools that want to inspect the raw map.
export function _peekCache() { return _cache; }
