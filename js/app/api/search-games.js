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
// #437 adds two more modes on the same edge fn so the remaining consumers can
// stop downloading the 11.8MB search-index.json blob:
//   browseGames({ store, sort, limit, offset }) -> paginated list, no query.
//   getGamesByIds([appId, ...])                 -> shaped rows for known ids.
//
// Static search-index.json stays on the CDN as a fallback (local dev without
// Supabase creds can still render). Search UX is API-only -- no fallback to
// the blob for search itself, since the whole point is to stop shipping it.

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

// #437 browse mode: a paginated list with no query, for grids that used to
// slice the full search-index.json blob client-side. Returns the same row
// shape as searchGames plus a server-computed `total` for the pager.
export async function browseGames({
  store = 'all',
  sort = 'popular',
  limit = 48,
  offset = 0,
  includeDelisted = false,
  includeAdult = false,
  signal,
} = {}) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('browse', '1');
  url.searchParams.set('store', store);
  url.searchParams.set('sort', sort);
  url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
  url.searchParams.set('offset', String(Math.max(0, offset)));
  if (includeDelisted) url.searchParams.set('include_delisted', 'true');
  if (includeAdult) url.searchParams.set('include_adult', 'true');
  try {
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) {
      console.warn('[search-games] browse non-2xx', res.status);
      return { results: [], total: 0, offset, limit, tookMs: 0 };
    }
    const body = await res.json();
    return {
      results: Array.isArray(body.results) ? body.results : [],
      total: body.total || 0,
      offset: body.offset ?? offset,
      limit: body.limit ?? limit,
      tookMs: body.took_ms || 0,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    console.warn('[search-games] browse failed', err);
    return { results: [], total: 0, offset, limit, tookMs: 0 };
  }
}

// #437 batch mode: shaped rows for a known set of app ids, so features that
// only need tier/title/counts for specific games (library synth, card
// enrichment) stop downloading the whole index. Ids are coerced to strings
// and de-duped; the server caps the count. Returns a Map keyed by appId (as a
// string) so callers can look up rows without scanning an array.
export async function getGamesByIds(ids, { signal } = {}) {
  const clean = [...new Set((ids || []).map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v)))];
  if (clean.length === 0) return new Map();
  const url = new URL(SEARCH_URL);
  url.searchParams.set('ids', clean.join(','));
  try {
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) {
      console.warn('[search-games] batch non-2xx', res.status);
      return new Map();
    }
    const body = await res.json();
    const rows = Array.isArray(body.results) ? body.results : [];
    return new Map(rows.map((r) => [String(r.appId), r]));
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    console.warn('[search-games] batch failed', err);
    return new Map();
  }
}
