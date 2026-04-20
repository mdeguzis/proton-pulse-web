/**
 * Tests for submitReport auth gating in app.js.
 *
 * app.js is a browser script. We extract submitReport + getWebClientId by
 * running just those functions in a Node vm context with mocked globals.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Shim that exposes submitReport and getWebClientId on the ctx object
const SHIM = `
var window = ctx;
var location = { pathname: '/', href: '', hash: '', search: '' };
var history = { replaceState: function(){} };
${APP_SRC}
ctx.__submitReport = submitReport;
ctx.__getWebClientId = getWebClientId;
ctx.__getProtonPulseUserIdFromSession = getProtonPulseUserIdFromSession;
`;

const SAFE_FETCH = { ok: false, status: 500, json: async () => [] };

function makeCtx(sessionOverride) {
  const fetchMock = jest.fn().mockResolvedValue(SAFE_FETCH);
  const SupaAuth = {
    getSession: jest.fn().mockResolvedValue(sessionOverride),
    buildLoginPageUrl: jest.fn(url => `/auth.html?returnTo=${url}`),
    onStateChange: jest.fn(),
    logout: jest.fn(),
  };
  const noop = jest.fn();
  function stubEl() {
    const el = {
      innerHTML: '', textContent: '', hidden: false, src: '', alt: '',
      classList: { add: noop, remove: noop, toggle: noop, contains: jest.fn(() => false) },
      style: {},
      dataset: {},
      addEventListener: noop,
      querySelector: jest.fn(() => null),
      querySelectorAll: jest.fn(() => ({ forEach: noop })),
    };
    return el;
  }
  const ctx = {
    ctx: null,
    SupaAuth,
    fetch: fetchMock,
    localStorage: { getItem: jest.fn(() => 'test-client-id'), setItem: jest.fn() },
    crypto: { randomUUID: jest.fn(() => 'test-uuid') },
    // empty UA so getWebSource() returns the default 'web' used by tests below
    navigator: { userAgent: '' },
    addEventListener: noop,
    removeEventListener: noop,
    document: {
      getElementById: jest.fn(() => stubEl()),
      addEventListener: noop,
      createElement: jest.fn(() => stubEl()),
    },
    console,
    Promise,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  ctx.ctx = ctx;
  vm.createContext(ctx);
  vm.runInContext(SHIM, ctx);
  return { ctx, fetchMock, SupaAuth };
}

function makeForm(overrides = {}) {
  const fields = {
    cpu: 'AMD Ryzen 7', gpu: 'RX 6800 XT', gpuDriver: 'Mesa 23.1',
    gpuVendor: 'AMD', ram: '16 GB', os: 'SteamOS', osVersion: '3.5',
    kernel: '6.1.0', protonVersion: 'Proton 9.0-4', duration: 'severalHours',
    rating: 'platinum', notes: '', launchOptions: '', vramMb: '8192',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
}

// Flush all pending microtasks so init fetches settle before we assert
async function flush() { await new Promise(r => setTimeout(r, 0)); }

describe('submitReport — auth gating', () => {
  test('returns error and skips fetch when no session', async () => {
    const { ctx, fetchMock } = makeCtx(null);
    await flush();
    fetchMock.mockClear();
    const result = await ctx.__submitReport('730', 'Half-Life 2', makeForm());
    expect(result).toEqual({ ok: false, error: 'Sign in with Steam to submit a report.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('uses session access_token in Authorization header when signed in', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok_abc123', user: { id: 'pp-user-1' } });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    const result = await ctx.__submitReport('730', 'Half-Life 2', makeForm());
    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok_abc123');
  });

  test('does not use anon SB_KEY as bearer when session present', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'user_token_xyz', user: { id: 'pp-user-1' } });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.__submitReport('730', 'Half-Life 2', makeForm());
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).not.toBe('Bearer sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V');
  });

  test('returns server error message on failed fetch', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-user-1' } });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ message: 'invalid rating' }),
    });
    const result = await ctx.__submitReport('730', 'Half-Life 2', makeForm());
    expect(result).toEqual({ ok: false, error: 'invalid rating' });
  });

  test('falls back to HTTP status on non-JSON error response', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-user-1' } });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: false, status: 503,
      json: async () => { throw new Error('not json'); },
    });
    const result = await ctx.__submitReport('730', 'Half-Life 2', makeForm());
    expect(result).toEqual({ ok: false, error: 'HTTP 503' });
  });

  test('sets source field to "web"', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-user-1' } });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.__submitReport('730', 'Half-Life 2', makeForm());
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).source).toBe('web');
  });

  test('concatenates os and osVersion in body', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-user-1' } });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.__submitReport('730', 'HL2', makeForm({ os: 'Arch Linux', osVersion: '6.8' }));
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).os).toBe('Arch Linux 6.8');
  });

  test('defaults duration to "unreported" when blank', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-user-1' } });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.__submitReport('730', 'HL2', makeForm({ duration: '' }));
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).duration).toBe('unreported');
  });

  test('sends proton_pulse_user_id from the signed-in session', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-user-42' } });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.__submitReport('730', 'HL2', makeForm());
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).proton_pulse_user_id).toBe('pp-user-42');
  });
});
