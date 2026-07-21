/**
 * Unit + source-scan tests for the PCGamingWiki tab in the Admin API Explorer (#377).
 *
 * Runtime tests exercise the client-side Cargo fetcher (query shape, error
 * envelope). Source-scan tests guard the tab wiring in api-explorer.js, the
 * CSP + manifest additions, and the field-docs coverage for every endpoint.
 */
const fs = require('fs');
const path = require('path');

const LIB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/admin/api/pcgamingwiki-explore.js'),
  'utf8',
);
const EXPLORER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/admin/components/api-explorer.js'),
  'utf8',
);
const MANIFEST = fs.readFileSync(
  path.join(__dirname, '..', 'gh-pages-manifest.txt'),
  'utf8',
);
const ADMIN_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'admin.html'),
  'utf8',
);

// --- Runtime: load the fetcher via babel-jest (same path jest already uses
// for every other JS import) and stub globalThis.fetch. Direct require works
// because babel-jest transforms the `export` at load time.

const { exploreCargoPCGamingWiki } = require('../js/admin/api/pcgamingwiki-explore.js');

function loadFetcher() { return exploreCargoPCGamingWiki; }

const _origFetch = globalThis.fetch;
function stubFetch(impl) {
  const spy = jest.fn(impl);
  globalThis.fetch = spy;
  return spy;
}
function restoreFetch() { globalThis.fetch = _origFetch; }

// --- Fetcher: query shape ---

describe('exploreCargoPCGamingWiki: query shape', () => {
  let fn;
  let spy;
  beforeEach(() => { fn = loadFetcher(); });
  afterEach(() => { restoreFetch(); spy = null; });

  test('pcgw_by_appid builds a Steam_AppID HOLDS query on Infobox_game', async () => {
    spy = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ cargoquery: [] }) }));
    const r = await fn('pcgw_by_appid', { id: '220' });
    expect(r.ok).toBe(true);
    expect(r.method).toBe('GET');
    const url = spy.mock.calls[0][0];
    expect(url).toContain('action=cargoquery');
    expect(url).toContain('tables=Infobox_game');
    // URLSearchParams URI-encodes the HOLDS clause.
    // URLSearchParams encodes spaces as `+`; decode both sequences before assertion.
    const decodedUrl = decodeURIComponent(url).replace(/\+/g, ' ');
    expect(decodedUrl).toContain('Steam_AppID HOLDS "220"');
    // Every projected field must be aliased (Cargo rejects underscore-leading names).
    expect(decodedUrl).toContain('_pageName=page');
    expect(decodedUrl).toContain('Engines=engines');
    expect(decodedUrl).toContain('Available_on=available');
  });

  test('pcgw_by_appid rejects non-numeric input without hitting the network', async () => {
    spy = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const r = await fn('pcgw_by_appid', { id: 'garbage' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/numeric/);
    expect(spy).not.toHaveBeenCalled();
  });

  test('pcgw_by_title builds a LIKE query and escapes wildcards', async () => {
    spy = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ cargoquery: [] }) }));
    const r = await fn('pcgw_by_title', { term: 'half_life%"' });
    expect(r.ok).toBe(true);
    const decoded = decodeURIComponent(spy.mock.calls[0][0]).replace(/\+/g, ' ');
    // Escaped tokens must land in the WHERE clause verbatim so a stray %/_/"
    // cannot alter the query semantics.
    expect(decoded).toContain('_pageName LIKE "%half\\_life\\%\\"%"');
    // Deterministic order.
    expect(decoded).toContain('order_by=_pageName');
  });

  test('pcgw_by_title requires a non-empty term', async () => {
    spy = stubFetch(async () => { throw new Error('should not fetch'); });
    const r = await fn('pcgw_by_title', { term: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/title fragment/);
    expect(spy).not.toHaveBeenCalled();
  });

  test('pcgw_table_fields defaults to Infobox_game and validates the identifier', async () => {
    spy = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ cargofields: {} }) }));
    const rDefault = await fn('pcgw_table_fields', { term: '' });
    expect(rDefault.ok).toBe(true);
    const url = spy.mock.calls[0][0];
    expect(url).toContain('action=cargofields');
    expect(url).toContain('table=Infobox_game');
    const rBad = await fn('pcgw_table_fields', { term: 'nope; drop table' });
    expect(rBad.ok).toBe(false);
    expect(rBad.error).toMatch(/\[A-Za-z0-9_\]/);
  });

  test('unknown endpoint returns an envelope with error, no fetch', async () => {
    spy = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const r = await fn('pcgw_mystery', { id: '220' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown/);
    expect(spy).not.toHaveBeenCalled();
  });
});

// --- Fetcher: response envelope ---

describe('exploreCargoPCGamingWiki: response envelope', () => {
  let fn;
  let spy;
  beforeEach(() => { fn = loadFetcher(); });
  afterEach(() => { restoreFetch(); spy = null; });

  test('MWException on a 200 body still surfaces as ok:false', async () => {
    spy = stubFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ error: { code: 'internal_api_error_MWException', info: 'Bad field' } }),
    }));
    const r = await fn('pcgw_by_appid', { id: '1' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(200);
    expect(r.error).toBe('Bad field');
    // Full body is still surfaced so admins can inspect it.
    expect(r.data.error.code).toBe('internal_api_error_MWException');
  });

  test('HTTP 4xx surfaces status + error string', async () => {
    spy = stubFetch(async () => ({
      ok: false, status: 429,
      json: async () => ({ retry_after: 60 }),
    }));
    const r = await fn('pcgw_by_appid', { id: '1' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.error).toBe('HTTP 429');
    expect(r.data.retry_after).toBe(60);
  });

  test('network throw returns ok:false envelope', async () => {
    spy = stubFetch(async () => { throw new Error('offline'); });
    const r = await fn('pcgw_by_appid', { id: '1' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBe('offline');
  });
});

// --- Source-scan: tab wiring in api-explorer.js ---

describe('Explorer tab wiring', () => {
  test('imports the client-side fetcher', () => {
    expect(EXPLORER_SRC).toMatch(/from ['"]\.\.\/api\/pcgamingwiki-explore\.js/);
    expect(EXPLORER_SRC).toContain('exploreCargoPCGamingWiki');
  });

  test('STORES has a pcgamingwiki tab with the three endpoints', () => {
    expect(EXPLORER_SRC).toMatch(/pcgamingwiki:\s*{[\s\S]{0,800}label:\s*'PCGamingWiki'/);
    for (const key of ['pcgw_by_appid', 'pcgw_by_title', 'pcgw_table_fields']) {
      expect(EXPLORER_SRC).toContain(key);
    }
  });

  test('doFetch routes the pcgamingwiki store to the client-side fetcher', () => {
    // Regression guard for the exploreStore-only path (#221) that would send
    // PCGW queries to the steam-explore edge fn.
    expect(EXPLORER_SRC).toMatch(/store === 'pcgamingwiki'[\s\S]{0,300}exploreCargoPCGamingWiki/);
  });

  test('FIELD_DOCS covers every pcgamingwiki endpoint', () => {
    for (const key of ['pcgw_by_appid', 'pcgw_by_title', 'pcgw_table_fields']) {
      expect(EXPLORER_SRC).toMatch(new RegExp(`${key}:\\s*{`));
    }
  });

  test('_storeUrl surfaces a jump-to-page link for pcgamingwiki endpoints', () => {
    expect(EXPLORER_SRC).toContain('pcgamingwiki.com/api/appid.php');
    expect(EXPLORER_SRC).toContain('pcgamingwiki.com/w/index.php?search=');
  });

  test('search-index resolve accepts pcgamingwiki store for name-to-appid lookup', () => {
    // Otherwise typing "Half-Life 2" on the PCGamingWiki tab fails to find an id.
    expect(EXPLORER_SRC).toContain("store === 'pcgamingwiki'");
  });
});

// --- Source-scan: CSP + manifest ---

describe('CSP + manifest', () => {
  test('admin.html connect-src allows pcgamingwiki.com', () => {
    expect(ADMIN_HTML).toContain('https://www.pcgamingwiki.com');
  });

  test('pcgamingwiki-explore.js is listed for gh-pages deploy', () => {
    expect(MANIFEST).toContain('js/admin/api/pcgamingwiki-explore.js');
  });
});
