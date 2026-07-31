/**
 * Tests for the extended Steam search index lazy-load (#134).
 *
 * Verifies:
 *  - loadExtendedSteamIndex fetches search-index-steam-extended.json once
 *    and caches in-memory across calls.
 *  - Concurrent loadExtendedSteamIndex callers share a single in-flight fetch.
 *  - searchExtendedSteamMatches filters the extended index the same way
 *    searchIndexMatches filters the primary index.
 *  - renderSearchPage actually invokes both loaders in parallel and merges
 *    results, deduping by appId (source-shape assertion -- catches future
 *    regressions where the extended branch is removed).
 */

const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const SEARCH_JS_PATH = path.join(__dirname, '..', 'js', 'app', 'components', 'search.js');

// Stubs for every import search.js pulls in. stripModuleSyntax drops the
// `import` lines, so the names just need to exist in the vm context.
function stubsForSearch(extraFetch) {
  return {
    console,
    fetch: extraFetch,
    dataUrl: async (name) => name,
    USES_PROD_DATA: false,
    SITE_ROOT: '',
    STEAM_IMG: () => '',
    // Config exports the fallback helper that search.js now uses to
    // fetch pipeline data (routes staging -> local first, prod on 404).
    // Stub returns whatever fetch is wired in the test.
    fetchDataWithProdFallback: (name) => extraFetch(name),
    storeLabelFromAppId: () => 'Steam',
    fetchMatchingPulseConfigs: async () => [],
    fetchMatchingPulseReportAppIds: async () => new Set(),
    renderGamePage: () => '',
    estimateScore: () => 0,
    daysAgo: () => '0d ago',
    esc: (s) => String(s),
    withTimeout: async (p) => p,
    renderGameCard: () => '',
    // adult-filter helpers: pass-through so the extended-search tests
    // exercise the raw match logic without needing localStorage.
    filterAdultEntries: (rows) => rows,
    isAdultEntry: () => false,
    // Same pass-through for the delisted-filter helpers (#434) -- these
    // tests exercise the raw match logic; pref-gated hiding has its own
    // dedicated suite in delistedFilter.test.js.
    filterDelistedEntries: (rows) => rows,
    countHiddenDelisted: () => 0,
    // Pure fuzzy-match helper factored out of search.js so it can be
    // unit-tested independently -- wire the real impl in so this suite
    // exercises the same logic search.js does at runtime.
    matchEntries: require('../js/app/lib/search-match.js').matchEntries,
    document: {
      getElementById: () => ({ innerHTML: '', set innerHTML(_v) {}, classList: { add() {}, remove() {}, contains() { return false; } }, getBoundingClientRect: () => ({ top:0, left:0, right:0, bottom:0, width:0 }), addEventListener() {}, querySelectorAll: () => [], contains: () => false }),
      addEventListener: () => {},
    },
    window: { addEventListener: () => {} },
  };
}

function loadSearchWithFetch(fetchImpl) {
  return loadEsm(['js/app/components/search.js'], stubsForSearch(fetchImpl));
}

describe('extended Steam search index lazy-load', () => {
  test('loadExtendedSteamIndex fetches search-index-steam-extended.json', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, json: async () => [['2881370', 'Thank You For Your Application', '', 0, 0, 'steam']] };
    };
    const ctx = loadSearchWithFetch(fetchImpl);
    await ctx.loadExtendedSteamIndex();
    expect(calls).toEqual(['search-index-steam-extended.json']);
    expect(ctx.extendedSteamIndex).toHaveLength(1);
    expect(ctx.extendedSteamIndex[0][0]).toBe('2881370');
  });

  test('loadExtendedSteamIndex caches and never refetches', async () => {
    let count = 0;
    const fetchImpl = async () => {
      count += 1;
      return { ok: true, json: async () => [['111', 'Game A', '', 0, 0, 'steam']] };
    };
    const ctx = loadSearchWithFetch(fetchImpl);
    await ctx.loadExtendedSteamIndex();
    await ctx.loadExtendedSteamIndex();
    await ctx.loadExtendedSteamIndex();
    expect(count).toBe(1);
  });

  test('concurrent loadExtendedSteamIndex callers share one in-flight fetch', async () => {
    let count = 0;
    let resolveFetch;
    const fetchImpl = () => {
      count += 1;
      return new Promise((resolve) => {
        resolveFetch = () => resolve({ ok: true, json: async () => [['111', 'Game A', '', 0, 0, 'steam']] });
      });
    };
    const ctx = loadSearchWithFetch(fetchImpl);
    const p1 = ctx.loadExtendedSteamIndex();
    const p2 = ctx.loadExtendedSteamIndex();
    const p3 = ctx.loadExtendedSteamIndex();
    // loadExtendedSteamIndex awaits dataUrl() before fetch() runs, so wait
    // until fetchImpl has actually been invoked before resolving it. Without
    // this microtask drain, resolveFetch is still undefined here.
    while (count === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
    resolveFetch();
    await Promise.all([p1, p2, p3]);
    expect(count).toBe(1);
  });

  test('loadExtendedSteamIndex degrades to empty on network failure', async () => {
    const fetchImpl = async () => { throw new Error('boom'); };
    const ctx = loadSearchWithFetch(fetchImpl);
    await ctx.loadExtendedSteamIndex();
    expect(ctx.extendedSteamIndex).toEqual([]);
  });

  test('loadExtendedSteamIndex degrades to empty on non-ok response', async () => {
    const fetchImpl = async () => ({ ok: false, json: async () => [] });
    const ctx = loadSearchWithFetch(fetchImpl);
    await ctx.loadExtendedSteamIndex();
    expect(ctx.extendedSteamIndex).toEqual([]);
  });

  test('searchExtendedSteamMatches filters by title substring (case-insensitive)', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => [
        ['2881370', 'Thank You For Your Application', '', 0, 0, 'steam'],
        ['111', 'Some Other Game', '', 0, 0, 'steam'],
      ],
    });
    const ctx = loadSearchWithFetch(fetchImpl);
    await ctx.loadExtendedSteamIndex();
    const hits = ctx.searchExtendedSteamMatches('thank you', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0][0]).toBe('2881370');
  });

  test('searchExtendedSteamMatches matches numeric query against appId prefix', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => [
        ['2881370', 'Thank You For Your Application', '', 0, 0, 'steam'],
        ['2881371', 'Another Game', '', 0, 0, 'steam'],
        ['999', 'Unrelated', '', 0, 0, 'steam'],
      ],
    });
    const ctx = loadSearchWithFetch(fetchImpl);
    await ctx.loadExtendedSteamIndex();
    const hits = ctx.searchExtendedSteamMatches('2881', 10);
    expect(hits.map(([id]) => id).sort()).toEqual(['2881370', '2881371']);
  });

  test('searchExtendedSteamMatches returns [] when index not yet loaded', () => {
    const fetchImpl = async () => ({ ok: true, json: async () => [] });
    const ctx = loadSearchWithFetch(fetchImpl);
    // Deliberately do NOT call loadExtendedSteamIndex
    expect(ctx.searchExtendedSteamMatches('anything', 10)).toEqual([]);
  });

  test('searchExtendedSteamMatches respects the limit argument', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => Array.from({ length: 50 }, (_, i) => [String(i), `Game ${i}`, '', 0, 0, 'steam']),
    });
    const ctx = loadSearchWithFetch(fetchImpl);
    await ctx.loadExtendedSteamIndex();
    expect(ctx.searchExtendedSteamMatches('game', 10)).toHaveLength(10);
    expect(ctx.searchExtendedSteamMatches('game', 3)).toHaveLength(3);
  });
});

describe('renderSearchPage source shape (#434 API-backed search)', () => {
  const src = fs.readFileSync(SEARCH_JS_PATH, 'utf8');

  test('search UX goes through the search-games API in parallel with Pulse configs', () => {
    // #434: the pre-#134 primary + extended blob-load pattern is gone.
    // Both the primary and long-tail catalog now live in the Postgres
    // search_index table hit via searchGamesAPI; fires in parallel with
    // the Pulse-config fetch so both round-trips overlap.
    expect(src).toMatch(/Promise\.all\(\s*\[[\s\S]*withTimeout\(fetchMatchingPulseConfigs\(q\)[\s\S]*searchGamesAPI\(q/);
  });

  test('searchGamesAPI is the single source of truth for grouped results', () => {
    // Removing the API call would regress to shipping the 12MB blob. Lock
    // the shape so any refactor either updates this assertion or breaks it.
    expect(src).toContain('searchGamesAPI(q');
    expect(src).toContain("import { searchGames } from '../api/search-games.js");
  });

  test('onSearchInput (dropdown) uses the API, not the blob', () => {
    // Cost discipline: dropdown must never trigger the multi-megabyte blob
    // fetch. Verify searchGames is called and loadSearchIndex is not.
    const onInputStart = src.indexOf('export async function onSearchInput');
    const onInputEnd = src.indexOf('// topbar.js injects', onInputStart);
    const onInputBody = src.slice(onInputStart, onInputEnd);
    expect(onInputBody).toContain('searchGames(');
    expect(onInputBody).not.toContain('loadExtendedSteamIndex');
    expect(onInputBody).not.toContain('await loadSearchIndex()');
  });
});
