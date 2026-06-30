/**
 * Tests for the profile page helpers, now split into the js/profile/ layered
 * modules (config + utils + api/* + components/* + main).
 *
 * Jest here has no ESM transform, so we use the same trick as adminAuth.test.js:
 * read each module file in dependency order, strip the import/export syntax and
 * the `const X = window.X` config bridge lines, concatenate, then run the whole
 * bundle in a Node vm context with browser stubs. The helpers are plain
 * top-level declarations once stripped, so they land on the ctx; main.js (the
 * page-init IIFE) runs last, exactly like loading the real page.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const PROFILE_MODULE_FILES = [
  'js/profile/config.js',
  'js/profile/utils.js',
  'js/profile/api/supabase.js',
  'js/profile/api/systems.js',
  'js/profile/api/configs.js',
  'js/profile/api/plugin-links.js',
  'js/profile/components/edit-modals.js',
  'js/profile/components/my-hardware.js',
  'js/profile/components/systems.js',
  'js/profile/components/my-reports.js',
  'js/profile/main.js',
];

const PROFILE_SRC = PROFILE_MODULE_FILES
  .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))
  .map(src => src
    // Strip import statements, including multi-line `import { ... } from '...';`
    // blocks. Lazy match to the first semicolon that ends a line.
    .replace(/^import\b[\s\S]*?;[ \t]*$/gm, '')
    .replace(/^export\s+(async\s+)?(function|class|const|let|var)\s/gm, '$1$2 ')
    // Drop the config bridge lines (const X = window.X): the SHIM declares
    // SUPABASE_URL / SUPABASE_ANON_KEY / SupaAuth as globals already, so
    // re-declaring them in vm scope would throw "already declared".
    .replace(/^(?:const|let|var)\s+(\w+)\s*=\s*window\.\1\s*;?\s*$/gm, ''))
  .join('\n');

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
ctx.__clearDefaultSystem    = clearDefaultSystem;
ctx.__updateSystemLabel     = updateSystemLabel;
ctx.__deleteSystem          = deleteSystem;
ctx.__getSteamIdFromSession = getSteamIdFromSession;
ctx.__getProtonPulseUserIdFromSession = getProtonPulseUserIdFromSession;
ctx.__escapeHtml            = escapeHtml;
ctx.__formatSystemUpdated   = formatSystemUpdated;
ctx.__fetchMyUserConfigs    = fetchMyUserConfigs;
ctx.__fetchMyCloudConfigs   = fetchMyCloudConfigs;
ctx.__publishMyCloudConfig  = publishMyCloudConfig;
ctx.__deleteMyReportsEverywhere = deleteMyReportsEverywhere;
ctx.__getMyReportBadges     = getMyReportBadges;
ctx.__mergeMyReportRows     = mergeMyReportRows;
ctx.__listLinkedPlugins     = listLinkedPlugins;
ctx.__completePluginLink    = completePluginLink;
ctx.__removePluginLink      = removePluginLink;
ctx.__getPluginLinkCodeFromLocation = getPluginLinkCodeFromLocation;
ctx.__inferGpuVendor        = inferGpuVendor;
ctx.__inferSystemLabel      = inferSystemLabel;
ctx.__isGenericSystemLabel  = isGenericSystemLabel;
ctx.__cleanUnknown          = cleanUnknown;
ctx.__parseSteamSystemInfo  = parseSteamSystemInfo;
ctx.__getMyHwFieldOrigins   = getMyHwFieldOrigins;
ctx.__setMyHwFieldOrigin    = setMyHwFieldOrigin;
ctx.__setMyHwFieldOrigins   = setMyHwFieldOrigins;
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

const protonPulseUserId = 'pp-user-123';
const deviceId = 'dev-abc-123';

describe('listUserSystems', () => {
  test('GETs with proton_pulse_user_id eq filter and updated_at desc order', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'user_tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => [{ device_id: 'd1', label: 'desk' }],
    });

    const rows = await ctx.__listUserSystems(protonPulseUserId, { access_token: 'user_tok' });

    expect(rows).toEqual([{ device_id: 'd1', label: 'desk' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&order=updated_at.desc`,
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
      ctx.__listUserSystems(protonPulseUserId, { access_token: 'tok' })
    ).rejects.toThrow('Lookup failed: HTTP 500');
  });

  test('falls back to anon key as Bearer when session has no access_token', async () => {
    const { ctx, fetchMock } = makeCtx(null);
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await ctx.__listUserSystems(protonPulseUserId, null);

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

    await ctx.__setDefaultSystem(protonPulseUserId, deviceId, { access_token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: clear is_default across all rows for this Proton Pulse user
    const [clearUrl, clearInit] = fetchMock.mock.calls[0];
    expect(clearUrl).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`,
    );
    expect(clearInit.method).toBe('PATCH');
    expect(clearInit.headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(clearInit.body)).toEqual({ is_default: false });

    // Second call: flip the chosen one to default
    const [setUrl, setInit] = fetchMock.mock.calls[1];
    expect(setUrl).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}` +
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
      ctx.__setDefaultSystem(protonPulseUserId, deviceId, { access_token: 'tok' })
    ).rejects.toThrow('Clear default failed: HTTP 403');

    // second PATCH should never fire if the first one blew up
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('clearDefaultSystem', () => {
  // Used when the user flips the default toggle OFF on the only checked row -
  // the expected end state is "no default at all", not "a different default"
  test('PATCHes is_default=false across all of the users rows, no second call', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await ctx.__clearDefaultSystem(protonPulseUserId, { access_token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`,
    );
    expect(init.method).toBe('PATCH');
    expect(init.headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(init.body)).toEqual({ is_default: false });
  });

  test('throws on non-ok response', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(
      ctx.__clearDefaultSystem(protonPulseUserId, { access_token: 'tok' })
    ).rejects.toThrow('Clear default failed: HTTP 500');
  });
});

describe('updateSystemLabel', () => {
  test('PATCHes with label body and proton_pulse_user_id + device_id filter', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await ctx.__updateSystemLabel(protonPulseUserId, deviceId, 'Living Room Deck', { access_token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}` +
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
      ctx.__updateSystemLabel(protonPulseUserId, deviceId, 'nope', { access_token: 'tok' })
    ).rejects.toThrow('Update label failed: HTTP 400');
  });
});

describe('deleteSystem', () => {
  test('DELETEs the row matching proton_pulse_user_id + device_id', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await ctx.__deleteSystem(protonPulseUserId, deviceId, { access_token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}` +
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
      ctx.__deleteSystem(protonPulseUserId, deviceId, { access_token: 'tok' })
    ).rejects.toThrow('Delete failed: HTTP 404');
  });
});

describe('system label inference', () => {
  test('treats Unknown as a generic label', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__isGenericSystemLabel('Unknown')).toBe(true);
    expect(ctx.__isGenericSystemLabel('Living Room Deck')).toBe(false);
  });

  // Plugin-side sometimes writes "Unknown system" when it can't derive a
  // better label. Catch that in the self-heal path too.
  test('treats "Unknown system" and "uploaded system" as generic', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__isGenericSystemLabel('Unknown system')).toBe(true);
    expect(ctx.__isGenericSystemLabel('Uploaded system')).toBe(true);
    expect(ctx.__isGenericSystemLabel('UNKNOWN SYSTEM')).toBe(true);
    expect(ctx.__isGenericSystemLabel('')).toBe(true);
  });

  test('infers Steam Deck for VanGogh / SteamOS uploads', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__inferSystemLabel({
      sysinfo_text: `
CPU Brand: AMD Custom APU 0405
Operating System Version:
  SteamOS 3.6
Driver: AMD VanGogh [AMD Custom GPU 0405]
RAM: 14564 Mb
      `,
    })).toBe('Steam Deck');
  });

  // Board-model match wins over chipset so LCD vs OLED is preserved
  test('names a Steam Deck OLED from Valve Galileo board', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__inferSystemLabel({
      sysinfo_text: [
        'Computer Information:',
        '  Manufacturer: Valve',
        '  Model: Galileo',
      ].join('\n'),
    })).toBe('Steam Deck OLED');
  });

  test('names a Steam Deck LCD from Valve Jupiter board', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__inferSystemLabel({
      sysinfo_text: [
        'Computer Information:',
        '  Manufacturer: Valve',
        '  Model: Jupiter',
      ].join('\n'),
    })).toBe('Steam Deck LCD');
  });

  // When nothing matches the Deck heuristics, fall back to {OS}-{VENDOR}-{GPU}
  // so the row still reads as a piece of hardware and not "Unknown"
  test('builds OS-VENDOR-GPU from parsed fields when Deck match fails', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__inferSystemLabel({
      sysinfo_text: [
        'Operating System Version:',
        '  "Arch Linux" (64 bit)',
        'Driver: NVIDIA Corporation NVIDIA GeForce RTX 4070',
      ].join('\n'),
    })).toBe('Arch-NVIDIA-GeForce RTX 4070');
  });

  // Only OS parsed? Still better than a literal "Uploaded system"
  test('returns just the OS when that is all that parsed', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__inferSystemLabel({
      sysinfo_text: 'Operating System Version:\n    "SteamOS 3.6" (64 bit)',
    })).toBe('SteamOS');
  });

  // Nothing at all -> the guaranteed last resort
  test('falls back to "Uploaded system" for an empty blob', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__inferSystemLabel({ sysinfo_text: '' })).toBe('Uploaded system');
  });
});

describe('cleanUnknown + parseSteamSystemInfo', () => {
  test('cleanUnknown drops literal "Unknown" (any case, with whitespace)', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__cleanUnknown('Unknown')).toBe('');
    expect(ctx.__cleanUnknown('  unknown  ')).toBe('');
    expect(ctx.__cleanUnknown('UNKNOWN')).toBe('');
    expect(ctx.__cleanUnknown('Arch Linux')).toBe('Arch Linux');
    expect(ctx.__cleanUnknown('')).toBe('');
    expect(ctx.__cleanUnknown(null)).toBe('');
  });

  // Sysinfo blob from the Deck when glxinfo / os-release probes all failed.
  // "Unknown" should land as missing, not as the string value
  test('strips Unknown CPU/OS/kernel from parsed output', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    const blob = [
      'CPU Brand:  Unknown',
      'Operating System Version:',
      '    Unknown',
      'Kernel Version:  Unknown',
    ].join('\n');
    const out = ctx.__parseSteamSystemInfo(blob);
    expect(out.cpu).toBeUndefined();
    expect(out.os).toBeUndefined();
    expect(out.kernel).toBeUndefined();
  });

  // Manufacturer/Model land on the "Computer Information:" block and survive
  // when everything else probes blank — they're how Deck recognition works
  test('parses Manufacturer and Model into the output', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    const blob = [
      'Computer Information:',
      '  Manufacturer:  Valve',
      '  Model:  Galileo',
    ].join('\n');
    const out = ctx.__parseSteamSystemInfo(blob);
    expect(out.manufacturer).toBe('Valve');
    expect(out.model).toBe('Galileo');
  });
});

describe('my-hardware field origins', () => {
  test('getMyHwFieldOrigins returns {} when nothing is stored', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__getMyHwFieldOrigins()).toEqual({});
  });

  test('setMyHwFieldOrigin writes one field without clobbering the rest', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    ctx.__setMyHwFieldOrigin('cpu', 'default-system');
    ctx.__setMyHwFieldOrigin('gpu', 'steam-paste');
    const origins = ctx.__getMyHwFieldOrigins();
    expect(origins).toEqual({ cpu: 'default-system', gpu: 'steam-paste' });
  });

  // Passing a falsy origin is the documented way to clear a single field,
  // used when we wipe a value before re-tagging it
  test('setMyHwFieldOrigin with empty origin removes that key', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    ctx.__setMyHwFieldOrigin('cpu', 'manual');
    ctx.__setMyHwFieldOrigin('cpu', '');
    expect(ctx.__getMyHwFieldOrigins()).toEqual({});
  });

  // When the whole map is empty, the LS key should be gone — otherwise we
  // leave an empty "{}" kicking around forever
  test('setMyHwFieldOrigins({}) removes the localStorage key', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    ctx.__setMyHwFieldOrigin('os', 'default-system');
    ctx.__setMyHwFieldOrigins({});
    expect(ctx.localStorage.getItem('proton-pulse:myhw:field-origins')).toBeNull();
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

describe('inferGpuVendor', () => {
  test('detects nvidia-style names first', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__inferGpuVendor('NVIDIA GeForce RTX 4070')).toBe('nvidia');
    expect(ctx.__inferGpuVendor('Quadro RTX 4000')).toBe('nvidia');
  });

  test('detects amd-style names', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__inferGpuVendor('AMD Radeon RX 7800 XT')).toBe('amd');
    expect(ctx.__inferGpuVendor('RDNA 3 graphics')).toBe('amd');
  });

  test('detects intel-style names', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__inferGpuVendor('Intel Arc A770')).toBe('intel');
    expect(ctx.__inferGpuVendor('Intel Iris Xe Graphics')).toBe('intel');
  });

  test('returns empty string when no vendor matches', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__inferGpuVendor('Mystery GPU')).toBe('');
    expect(ctx.__inferGpuVendor('')).toBe('');
  });
});

// -- My uploaded reports helpers -------------------------------------------
// Powers the "My uploaded reports" section on the profile page. Prefer the
// signed-in Proton Pulse user id and keep client_id as a legacy fallback.

const clientId = '11111111-2222-3333-4444-555555555555';
const reportOwnerId = 'pp-user-123';

describe('fetchMyUserConfigs', () => {
  test('GETs user_configs filtered by proton_pulse_user_id with client_id fallback', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await ctx.__fetchMyUserConfigs(reportOwnerId, clientId, { access_token: 'tok' });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_configs`
      + `?or=(proton_pulse_user_id.eq.${encodeURIComponent(reportOwnerId)},client_id.eq.${encodeURIComponent(clientId)})`
      + `&select=id,app_id,title,proton_version,rating,created_at,updated_at,is_flagged,is_hidden,flagged_reason`
      + `&order=created_at.desc`,
    );
  });
});

describe('fetchMyCloudConfigs', () => {
  test('GETs user_proton_configs filtered by proton_pulse_user_id', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await ctx.__fetchMyCloudConfigs(reportOwnerId, { access_token: 'tok' });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_proton_configs`
      + `?proton_pulse_user_id=eq.${encodeURIComponent(reportOwnerId)}`
      + `&select=app_id,app_name,updated_at,config,is_published`
      + `&order=updated_at.desc`,
    );
  });
});

describe('publishMyCloudConfig', () => {
  test('PATCHes the cloud row to public for the signed-in Proton Pulse user', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => [] });

    await ctx.__publishMyCloudConfig(reportOwnerId, '730', { access_token: 'tok' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SUPABASE_URL}/rest/v1/user_proton_configs`
      + `?proton_pulse_user_id=eq.${encodeURIComponent(reportOwnerId)}`
      + `&app_id=eq.730`,
    );
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ is_published: true });
  });
});

describe('deleteMyReportsEverywhere', () => {
  test('deletes cloud and published report rows owned by the user', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => [] });

    await ctx.__deleteMyReportsEverywhere(reportOwnerId, clientId, '730', { access_token: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${SUPABASE_URL}/rest/v1/user_proton_configs`
      + `?proton_pulse_user_id=eq.${encodeURIComponent(reportOwnerId)}`
      + `&app_id=eq.730`,
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${SUPABASE_URL}/rest/v1/user_configs`
      + `?proton_pulse_user_id=eq.${encodeURIComponent(reportOwnerId)}`
      + `&app_id=eq.730`,
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      `${SUPABASE_URL}/rest/v1/user_configs`
      + `?client_id=eq.${encodeURIComponent(clientId)}`
      + `&app_id=eq.730`,
    );
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'DELETE')).toBe(true);
  });
});

describe('mergeMyReportRows', () => {
  test('marks published-only rows with just the published badge', async () => {
    const { ctx } = makeCtx(null);
    await flush();

    const rows = ctx.__mergeMyReportRows([
      { app_id: 570, title: 'Dota 2', rating: 'gold', created_at: '2026-04-20T10:00:00Z' },
    ], []);

    expect(rows).toEqual([
      expect.objectContaining({
        app_id: '570',
        published: true,
        cloud: false,
        unpublished: false,
        rating: 'gold',
      }),
    ]);
    expect(ctx.__getMyReportBadges(rows[0])).toEqual([
      { label: 'Published', tone: 'published' },
    ]);
  });

  test('marks cloud-only rows as cloud and unpublished', async () => {
    const { ctx } = makeCtx(null);
    await flush();

    const rows = ctx.__mergeMyReportRows([], [
      { app_id: 730, app_name: 'Counter-Strike 2', updated_at: '2026-04-20T11:00:00Z', config: { appName: 'Counter-Strike 2' } },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        app_id: '730',
        published: false,
        cloud: true,
        unpublished: true,
      }),
    ]);
    expect(ctx.__getMyReportBadges(rows[0])).toEqual([
      { label: 'Synced', tone: 'cloud', title: 'Plugin config saved to cloud sync. Reinstalling the plugin will restore it.' },
      { label: 'Unpublished', tone: 'unpublished' },
    ]);
  });

  test('marks cloud row as published (not unpublished) when a published report also exists', async () => {
    const { ctx } = makeCtx(null);
    await flush();

    const rows = ctx.__mergeMyReportRows([
      { app_id: 1091500, title: 'Cyberpunk 2077', rating: 'platinum', created_at: '2026-04-20T09:00:00Z' },
    ], [
      { app_id: 1091500, app_name: 'Cyberpunk 2077', updated_at: '2026-04-20T12:00:00Z', config: { appName: 'Cyberpunk 2077' } },
    ]);

    // A row that has both a published report AND a cloud config is treated as
    // published. unpublished=true only applies to cloud-only rows with no report.
    expect(rows).toEqual([
      expect.objectContaining({
        app_id: '1091500',
        published: true,
        cloud: true,
        unpublished: false,
        updated_at: '2026-04-20T12:00:00Z',
      }),
    ]);
    expect(ctx.__getMyReportBadges(rows[0])).toEqual([
      { label: 'Synced', tone: 'cloud', title: 'Plugin config saved to cloud sync. Reinstalling the plugin will restore it.' },
      { label: 'Published', tone: 'published' },
    ]);
  });

  test('marks published cloud rows as cloud and published, not unpublished', async () => {
    const { ctx } = makeCtx(null);
    await flush();

    const rows = ctx.__mergeMyReportRows([], [
      { app_id: 620, app_name: 'Portal 2', updated_at: '2026-04-20T12:00:00Z', is_published: true },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        app_id: '620',
        cloud: true,
        published: true,
        unpublished: false,
      }),
    ]);
    expect(ctx.__getMyReportBadges(rows[0])).toEqual([
      { label: 'Synced', tone: 'cloud', title: 'Plugin config saved to cloud sync. Reinstalling the plugin will restore it.' },
      { label: 'Published', tone: 'published' },
    ]);
  });

  test('collapses one game into a single row when published app_id is a string and cloud app_id is a number (issue #131)', async () => {
    const { ctx } = makeCtx(null);
    await flush();

    // user_configs.app_id is a text column (string from the API);
    // user_proton_configs.app_id is bigint (number). The merge must treat them
    // as the same game instead of emitting two rows.
    const rows = ctx.__mergeMyReportRows([
      { app_id: '2358720', title: 'Black Myth: Wukong', rating: 'platinum', id: 22, created_at: '2026-06-28T23:42:56Z' },
    ], [
      { app_id: 2358720, app_name: 'Black Myth: Wukong', updated_at: '2026-06-28T23:41:43Z', is_published: false },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      app_id: '2358720',
      cloud: true,
      published: true,
      unpublished: false,
      rating: 'platinum',
    }));
    expect(ctx.__getMyReportBadges(rows[0])).toEqual([
      { label: 'Synced', tone: 'cloud', title: 'Plugin config saved to cloud sync. Reinstalling the plugin will restore it.' },
      { label: 'Published', tone: 'published' },
    ]);
  });
});

describe('getProtonPulseUserIdFromSession', () => {
  test('returns the signed-in auth user id', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__getProtonPulseUserIdFromSession({ user: { id: 'pp-user-9' } })).toBe('pp-user-9');
  });

  test('returns null when no auth user is present', async () => {
    const { ctx } = makeCtx(null);
    await flush();
    expect(ctx.__getProtonPulseUserIdFromSession(null)).toBeNull();
  });
});

describe('plugin link helpers', () => {
  test('listLinkedPlugins posts to the list edge function with auth headers', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '[]' });

    await ctx.__listLinkedPlugins({ access_token: 'tok' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/plugin-links-list`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  test('completePluginLink sends the link code payload', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok' });
    await flush();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });

    await ctx.__completePluginLink('ABCD-1234', { access_token: 'tok' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ linkCode: 'ABCD-1234' });
  });

  test('reads the link code from the normal query string', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__getPluginLinkCodeFromLocation({
      search: '?pluginLinkCode=ABCD-1234',
      hash: '#linked-plugins-section',
    })).toBe('ABCD-1234');
  });

  test('falls back to the hash query when the browser drops the normal search string', async () => {
    const { ctx } = makeCtx({ access_token: 'tok' });
    await flush();
    expect(ctx.__getPluginLinkCodeFromLocation({
      search: '',
      hash: '#linked-plugins-section?pluginLinkCode=ABCD-1234',
    })).toBe('ABCD-1234');
  });
});
