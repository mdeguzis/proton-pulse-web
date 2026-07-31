// #434: client wrapper for the search-games edge function.
//
// Replaces the pre-#434 pattern where every page downloaded the full
// search-index.json (12MB) and did a client-side substring scan. The
// edge fn hits a Postgres FTS index and returns ~2KB per query.
//
// Response contract (matches supabase/functions/search-games/index.ts):
//   {
//     results: [{ appId, title, tier, source, protondbCount, pulseCount,
//                 releaseYear, delisted, adult, replacedBy, steamType }],
//     total, hiddenDelisted, hiddenAdult, query, took_ms
//   }
//
// Static search-index.json stays on the CDN as a fallback (browse pages
// still aggregate from it; local dev without Supabase creds can still
// render). Search UX is API-only -- no fallback to the blob for search
// itself, since the whole point is to stop shipping the blob.

const SEARCH_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co/functions/v1/search-games';

export async function searchGames(query, {
  store = 'all',
  limit = 24,
  includeDelisted = false,
  includeAdult = false,
  signal,
} = {}) {
  const q = String(query || '').trim();
  if (!q) return _empty(q);
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', q.slice(0, 120));
  url.searchParams.set('store', store);
  url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
  if (includeDelisted) url.searchParams.set('include_delisted', 'true');
  if (includeAdult) url.searchParams.set('include_adult', 'true');
  try {
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) {
      console.warn('[search-games] non-2xx', res.status);
      return _empty(q);
    }
    const body = await res.json();
    return {
      results: Array.isArray(body.results) ? body.results : [],
      total: body.total || 0,
      hiddenDelisted: body.hiddenDelisted || 0,
      hiddenAdult: body.hiddenAdult || 0,
      query: body.query || q,
      tookMs: body.took_ms || 0,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    console.warn('[search-games] fetch failed', err);
    return _empty(q);
  }
}

function _empty(q) {
  return { results: [], total: 0, hiddenDelisted: 0, hiddenAdult: 0, query: q, tookMs: 0 };
}
