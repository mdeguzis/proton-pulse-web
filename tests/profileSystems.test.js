/**
 * Tests for the user_systems REST helpers in profile.js.
 *
 * profile.js is a browser script — no module exports. Same trick as
 * submitReport.test.js: read the source, stub the browser globals it touches,
 * and run it in a Node vm context. The helpers we care about sit at the top
 * (lines ~23-105) as plain `function` declarations so they end up on the ctx.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const PROFILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'profile.js'), 'utf8');

const SUPABASE_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_testkey';

// Shim that injects the supabase-client.js constants (profile.js expects them
// as globals) and hangs the four helpers back on ctx after the script runs
const SHIM = `
var window = ctx;
var location = { pathname: '/', href: '', hash: '', search: '' };
var history = { replaceState: function(){} };
var navigator = { clipboard: { writeText: function(){ return Promise.resolve(); } } };
var SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};
var SUPABASE_ANON_KEY = ${JSON.stringify(SUPABASE_ANON_KEY)};
${PROFILE_SRC}
ctx.__listUserSystems       = listUserSystems;
ctx.__setDefaultSystem      = setDefaultSystem;
ctx.__updateSystemLabel     = updateSystemLabel;
ctx.__deleteSystem          = deleteSystem;
ctx.__getSteamIdFromSession = getSteamIdFromSession;
ctx.__escapeHtml            = escapeHtml;
ctx.__formatSystemUpdated   = formatSystemUpdated;
ctx.__fetchMyUserConfigs    = fetchMyUserConfigs;
`;

// Baseline fetch result so the init IIFE inside profile.js doesn't blow up
// while it calls listUserSystems via refreshSystems/autoFillFromDefaultIfEmpty
const SAFE_FETCH = { ok: true, status: 200, json: async () => [] };

function makeCtx(sessionOverride) {
  const fetchMock = jest.fn().mockResolvedValue(SAFE_FETCH);
  const noop = jest.fn();
  const SupaAuth = {
    getSession: jest.fn().mockResolvedValue(sessionOverride),
    buildLoginPageUrl: jest.fn(url => `/auth.html?returnTo=${url}`),
    onStateChange: jest.fn(),
    logout: jest.fn(),
  };
  function stubEl() {
    const el = {
      innerHTML: '', textContent: '', hidden: false, src: '', alt: '',
      value: '', checked: false,
      classList: { add: noop, remove: noop, toggle: noop, contains: jest.fn(() => false) },
      style: {},
      dataset: {},
      addEventListener: noop,
      removeEventListener: noop,
      querySelector: jest.fn(() => null),
      querySelectorAll: jest.fn(() => ({ forEach: noop })),
      closest: jest.fn(() => null),
      contains: jest.fn(() => false),
      focus: noop,
      blur: noop,
    };
    return el;
  }
  const ctx = {
    ctx: null,
    SupaAuth,
    fetch: fetchMock,
    localStorage: {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = String(v); },
      removeItem(k) { delete this._store[k]; },
    },
    crypto: { randomUUID: jest.fn(() => 'test-uuid') },
    addEventListener: noop,
    removeEventListener: noop,
    document: {
      getElementById: jest.fn(() => stubEl()),
      addEventListener: noop,
      createElement: jest.fn(() => stubEl()),
      querySelector: jest.fn(() => null),
      querySelectorAll: jest.fn(() => ({ forEach: noop })),
    },
    console: {
      log: noop, warn: noop, error: noop, info: noop, debug: noop,
    },
    Promise,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    Date,
    Math,
    URL,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  ctx.ctx = ctx;
  vm.createContext(ctx);
  vm.runInContext(SHIM, ctx);
  return { ctx, fetchMock, SupaAuth };
}

// Let the init IIFE finish its two kicked-off async calls before we assert
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

const steamId = '76561198000000000';
const deviceId = 'dev-abc-123';

describe('listUserSystems', () => {
  test('GETs with steam_id eq filter and updated_at desc order', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'user_tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => [{ device_id: 'd1', label: 'desk' }],
    });

    const rows = await ctx.__listUserSystems(steamId, { access_token: 'user_tok' });

    expect(rows).toEqual([{ device_id: 'd1', label: 'desk' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?steam_id=eq.${encodeURIComponent(steamId)}&order=updated_at.desc`,
    );
    // No method means GET by default
    expect(init.method).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer user_tok');
    expect(init.headers.apikey).toBe(SUPABASE_ANON_KEY);
  });

  test('throws "Lookup failed: HTTP 500" on non-ok response', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(
      ctx.__listUserSystems(steamId, { access_token: 'tok' })
    ).rejects.toThrow('Lookup failed: HTTP 500');
  });

  test('falls back to anon key as Bearer when session has no access_token', async () => {
    const { ctx, fetchMock } = makeCtx(null);
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await ctx.__listUserSystems(steamId, null);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${SUPABASE_ANON_KEY}`);
  });
});

describe('setDefaultSystem', () => {
  test('PATCHes clear-all then set-one, both with Prefer return=minimal', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    // both PATCHes succeed
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await ctx.__setDefaultSystem(steamId, deviceId, { access_token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: clear is_default across all rows for this steam_id
    const [clearUrl, clearInit] = fetchMock.mock.calls[0];
    expect(clearUrl).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?steam_id=eq.${encodeURIComponent(steamId)}`,
    );
    expect(clearInit.method).toBe('PATCH');
    expect(clearInit.headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(clearInit.body)).toEqual({ is_default: false });

    // Second call: flip the chosen one to default
    const [setUrl, setInit] = fetchMock.mock.calls[1];
    expect(setUrl).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?steam_id=eq.${encodeURIComponent(steamId)}` +
      `&device_id=eq.${encodeURIComponent(deviceId)}`,
    );
    expect(setInit.method).toBe('PATCH');
    expect(setInit.headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(setInit.body)).toEqual({ is_default: true });
  });

  test('throws "Clear default failed" when the first PATCH fails', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });

    await expect(
      ctx.__setDefaultSystem(steamId, deviceId, { access_token: 'tok' })
    ).rejects.toThrow('Clear default failed: HTTP 403');

    // second PATCH should never fire if the first one blew up
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('updateSystemLabel', () => {
  test('PATCHes with label body and steam_id + device_id filter', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await ctx.__updateSystemLabel(steamId, deviceId, 'Living Room Deck', { access_token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?steam_id=eq.${encodeURIComponent(steamId)}` +
      `&device_id=eq.${encodeURIComponent(deviceId)}`,
    );
    expect(init.method).toBe('PATCH');
    expect(init.headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(init.body)).toEqual({ label: 'Living Room Deck' });
  });

  test('throws "Update label failed" on non-ok', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    await expect(
      ctx.__updateSystemLabel(steamId, deviceId, 'nope', { access_token: 'tok' })
    ).rejects.toThrow('Update label failed: HTTP 400');
  });
});

describe('deleteSystem', () => {
  test('DELETEs the row matching steam_id + device_id', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await ctx.__deleteSystem(steamId, deviceId, { access_token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?steam_id=eq.${encodeURIComponent(steamId)}` +
      `&device_id=eq.${encodeURIComponent(deviceId)}`,
    );
    expect(init.method).toBe('DELETE');
    expect(init.headers.Prefer).toBe('return=minimal');
    // DELETE shouldn't send a body
    expect(init.body).toBeUndefined();
  });

  test('throws "Delete failed" on non-ok', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    await expect(
      ctx.__deleteSystem(steamId, deviceId, { access_token: 'tok' })
    ).rejects.toThrow('Delete failed: HTTP 404');
  });
});

describe('getSteamIdFromSession', () => {
  test('returns user_metadata.steam_id when present', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    const id = ctx.__getSteamIdFromSession({
      user: { user_metadata: { steam_id: '76561198000000001' } },
    });
    expect(id).toBe('76561198000000001');
  });

  test('falls back to provider_id, then sub', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__getSteamIdFromSession({
      user: { user_metadata: { provider_id: 'prov-123' } },
    })).toBe('prov-123');
    expect(ctx.__getSteamIdFromSession({
      user: { user_metadata: { sub: 'sub-456' } },
    })).toBe('sub-456');
  });

  test('returns null when session is nullish or has no steam id fields', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__getSteamIdFromSession(null)).toBeNull();
    expect(ctx.__getSteamIdFromSession(undefined)).toBeNull();
    expect(ctx.__getSteamIdFromSession({})).toBeNull();
    expect(ctx.__getSteamIdFromSession({ user: { user_metadata: {} } })).toBeNull();
  });

  test('prefers steam_id over provider_id when both are set', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    const id = ctx.__getSteamIdFromSession({
      user: { user_metadata: { steam_id: 'preferred', provider_id: 'fallback' } },
    });
    expect(id).toBe('preferred');
  });
});

describe('escapeHtml', () => {
  test('escapes all five HTML-unsafe characters', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(ctx.__escapeHtml("it's & stuff"))
      .toBe('it&#39;s &amp; stuff');
  });

  test('handles null, undefined, and empty string as empty output', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__escapeHtml(null)).toBe('');
    expect(ctx.__escapeHtml(undefined)).toBe('');
    expect(ctx.__escapeHtml('')).toBe('');
  });

  test('coerces non-string values via toString', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__escapeHtml(42)).toBe('42');
    // Object with a custom toString — goes through .toString() on the coerce path
    const obj = { toString: () => 'hello <b>world</b>' };
    expect(ctx.__escapeHtml(obj)).toBe('hello &lt;b&gt;world&lt;/b&gt;');
  });

  test('passes through safe ASCII text unchanged', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__escapeHtml('plain label 123')).toBe('plain label 123');
  });
});

describe('formatSystemUpdated', () => {
  test('formats a valid ISO timestamp as a locale string', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    const out = ctx.__formatSystemUpdated('2026-04-18T12:34:56Z');
    // Don't pin the exact format (locale-dependent), just verify it parsed
    // and rendered something that contains "2026"
    expect(out).toMatch(/2026/);
    expect(out).not.toBe('Invalid Date');
  });

  test('falls back to dash when input is null/undefined', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__formatSystemUpdated(null)).toBe('-');
    expect(ctx.__formatSystemUpdated(undefined)).toBe('-');
  });

  test('falls back to dash for empty string', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__formatSystemUpdated('')).toBe('-');
  });

  test('returns the raw string for unparseable truthy input', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    // Date('not-a-date') -> Invalid Date; helper should return the raw value
    // so the user sees what came back from the DB, not "Invalid Date"
    expect(ctx.__formatSystemUpdated('not-a-date')).toBe('not-a-date');
  });
});

// -- My uploaded reports helpers -------------------------------------------
// Powers the "My uploaded reports" section on the profile page. Each row on
// user_configs is a public compatibility report, keyed by client_id

const clientId = '11111111-2222-3333-4444-555555555555';

describe('fetchMyUserConfigs', () => {
  test('GETs user_configs filtered by client_id and ordered by created_at desc', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await ctx.__fetchMyUserConfigs(clientId, { access_token: 'tok' });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_configs`
      + `?client_id=eq.${encodeURIComponent(clientId)}`
      + `&select=id,app_id,title,proton_version,rating,created_at`
      + `&order=created_at.desc`,
    );
  });
});
