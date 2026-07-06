/**
 * Tests for fetchMyLibraryRow and syncMyLibrary in
 * js/profile/api/steam-library.js. Covers the happy path, no-session guard,
 * and the non-OK HTTP path so REST wiring can't regress silently (#199).
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SUPABASE_URL = 'https://test.supabase.co';
const ANON_KEY     = 'test-anon-key';
const SESSION      = { access_token: 'tok-fake', user: { id: 'u1' } };

function loadSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^import\s.*$/gm, '')
    .replace(/^export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ')
    .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');
}

function makeCtx(fetchMock) {
  const ctx = vm.createContext({
    fetch: fetchMock,
    SUPABASE_URL,
    SUPABASE_ANON_KEY: ANON_KEY,
    console,
  });
  vm.runInContext(loadSrc('js/profile/api/supabase.js'), ctx);
  vm.runInContext(loadSrc('js/profile/api/steam-library.js'), ctx);
  return ctx;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('fetchMyLibraryRow', () => {
  test('returns null when there is no session', async () => {
    const fetchMock = jest.fn();
    const ctx = makeCtx(fetchMock);
    const row = await ctx.fetchMyLibraryRow(null);
    expect(row).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns the first row when the REST call succeeds', async () => {
    const row = { steam_id: '76561', game_count: 3, appids: [10, 20, 30], synced_at: 'x' };
    const fetchMock = jest.fn(async () => jsonResponse(200, [row]));
    const ctx = makeCtx(fetchMock);
    const got = await ctx.fetchMyLibraryRow(SESSION);
    expect(got).toEqual(row);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('/rest/v1/user_steam_library');
    expect(url).toContain('select=steam_id,game_count,appids,synced_at');
  });

  test('returns null when the user has never synced', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(200, []));
    const ctx = makeCtx(fetchMock);
    const got = await ctx.fetchMyLibraryRow(SESSION);
    expect(got).toBeNull();
  });

  test('throws on non-2xx so callers can surface an error', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(500, { error: 'boom' }));
    const ctx = makeCtx(fetchMock);
    await expect(ctx.fetchMyLibraryRow(SESSION)).rejects.toThrow(/HTTP 500/);
  });
});

describe('syncMyLibrary', () => {
  test('rejects when there is no session', async () => {
    const fetchMock = jest.fn();
    const ctx = makeCtx(fetchMock);
    await expect(ctx.syncMyLibrary(null)).rejects.toThrow(/Sign in required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('posts to the edge function and returns the payload', async () => {
    const payload = { ok: true, game_count: 42, appid_count: 42, synced_at: 'ts' };
    const fetchMock = jest.fn(async () => jsonResponse(200, payload));
    const ctx = makeCtx(fetchMock);
    const got = await ctx.syncMyLibrary(SESSION);
    expect(got).toEqual(payload);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/sync-steam-library`);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok-fake');
  });

  test('surfaces the server error message on non-2xx', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(400, { error: 'no steam id' }));
    const ctx = makeCtx(fetchMock);
    await expect(ctx.syncMyLibrary(SESSION)).rejects.toThrow(/no steam id/);
  });
});
