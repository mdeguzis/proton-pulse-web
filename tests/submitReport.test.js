/**
 * Tests for submitReport, form validation, and parseSteamSystemInfo.
 *
 * Loads app-scoring.js + app-submit.js in a VM context with mocked
 * browser globals. Does NOT load app.js (which binds to the DOM and
 * has side effects we dont want in tests).
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

// scoring/submit are now ES modules (js/shared/); strip import/export so they
// can be vm-evaluated as classic source in one shared scope.
const { stripModuleSyntax } = require('./_esm-vm.js');
const SCORING_SRC  = stripModuleSyntax(fs.readFileSync(path.join(__dirname, '..', 'js', 'shared', 'scoring.js'), 'utf8'));
const GPU_ARCH_SRC = stripModuleSyntax(fs.readFileSync(path.join(__dirname, '..', 'js', 'lib', 'gpu-arch-detector.js'), 'utf8'));
const SUBMIT_SRC   = stripModuleSyntax(fs.readFileSync(path.join(__dirname, '..', 'js', 'shared', 'submit.js'), 'utf8'));

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
    return {
      innerHTML: '', textContent: '', hidden: false, src: '', alt: '',
      classList: { add: noop, remove: noop, toggle: noop, contains: jest.fn(() => false) },
      style: {},
      dataset: {},
      value: '',
      addEventListener: noop,
      querySelector: jest.fn(() => null),
      querySelectorAll: jest.fn(() => []),
      appendChild: noop,
      dispatchEvent: noop,
    };
  }
  const ctx = {
    ctx: null,
    SupaAuth,
    // app-submit.js checks these for fallback definitions
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    // these would normally come from app.js, but submit.js sets window.X fallbacks
    window: null,
    fetch: fetchMock,
    localStorage: { getItem: jest.fn(() => 'test-client-id'), setItem: jest.fn() },
    crypto: { randomUUID: jest.fn(() => 'test-uuid') },
    navigator: { userAgent: '' },
    addEventListener: noop,
    removeEventListener: noop,
    document: {
      getElementById: jest.fn(() => stubEl()),
      querySelector: jest.fn(() => stubEl()),
      querySelectorAll: jest.fn(() => []),
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
    parseInt,
    isNaN,
    Math,
    Date,
    Map,
    Set,
  };
  ctx.ctx = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  // load scoring first (provides FAULT_KEYS_WEB, deriveRatingFromState, etc)
  vm.runInContext(SCORING_SRC, ctx);
  // load gpu arch detector (provides detectGpuArch, used by submit)
  vm.runInContext(GPU_ARCH_SRC, ctx);
  // then submit (provides submitReport, parseSteamSystemInfo, etc)
  vm.runInContext(SUBMIT_SRC, ctx);
  return { ctx, fetchMock, SupaAuth };
}

function makeForm(overrides = {}) {
  const defaults = {
    gameTitle: 'Test Game',
    cpu: 'AMD Ryzen 7', gpu: 'RX 6800 XT', gpuDriver: 'Mesa 23.1',
    gpuVendor: 'amd', ram: '16 GB', os: 'SteamOS', osVersion: '3.5',
    kernel: '6.1.0', protonVersion: 'Proton 9.0-4', duration: 'oneToFourHours',
    notes: 'runs great', launchOptions: '', vramMb: '8192',
    reportSource: 'web-linux',
  };
  const fields = { ...defaults, ...overrides };
  const form = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, { value: v }])
  );
  // form state with all questions answered for a valid platinum submit
  form._formState = {
    canInstall: 'yes', canStart: 'yes', canPlay: 'yes',
    verdict: 'yes', verdictOob: 'yes',
    requiresFramegen: null,
    faults: {
      performanceFaults: 'no', graphicalFaults: 'no', windowingFaults: 'no',
      audioFaults: 'no', inputFaults: 'no', stabilityFaults: 'no',
      saveGameFaults: 'no', significantBugs: 'no',
    },
    tinkeringMethods: new Set(),
  };
  return form;
}

async function flush() { await new Promise(r => setTimeout(r, 0)); }

// submitReport now fires an extra GET against user_steam_library first (to set
// owner_verified from the cached appids, #199), so the submit itself is no
// longer guaranteed to be calls[0]. Find the write call by method.
function findSubmitWriteCall(fetchMock) {
  const call = fetchMock.mock.calls.find(([, init]) => {
    const method = (init && init.method) || 'GET';
    return method === 'POST' || method === 'PATCH';
  });
  if (!call) throw new Error('no submit write call recorded');
  return call;
}

// ── submitReport auth gating ────────────────────────────────────────

describe('submitReport - auth gating', () => {
  test('returns error when no session', async () => {
    const { ctx, fetchMock } = makeCtx(null);
    fetchMock.mockClear();
    const result = await ctx.submitReport('730', 'Half-Life 2', makeForm());
    expect(result).toEqual({ ok: false, error: 'Sign in with Steam to submit a report.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('uses session access_token in Authorization header', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok_abc', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.submitReport('730', 'HL2', makeForm());
    const [, init] = findSubmitWriteCall(fetchMock);
    expect(init.headers.Authorization).toBe('Bearer tok_abc');
  });

  test('returns server error message on failed fetch', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ message: 'invalid rating' }),
    });
    const result = await ctx.submitReport('730', 'HL2', makeForm());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid rating/);
  });

  test('falls back to HTTP status on non-JSON error', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: false, status: 503,
      json: async () => { throw new Error('not json'); },
    });
    const result = await ctx.submitReport('730', 'HL2', makeForm());
    expect(result).toEqual({ ok: false, error: 'HTTP 503' });
  });

  test('sends proton_pulse_user_id from session', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-42' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.submitReport('730', 'HL2', makeForm());
    const body = JSON.parse(findSubmitWriteCall(fetchMock)[1].body);
    expect(body.proton_pulse_user_id).toBe('pp-42');
  });

  test('concatenates os and osVersion', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.submitReport('730', 'HL2', makeForm({ os: 'Arch Linux', osVersion: '6.8' }));
    const body = JSON.parse(findSubmitWriteCall(fetchMock)[1].body);
    expect(body.os).toBe('Arch Linux 6.8');
  });

  test('defaults duration to unreported when blank', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.submitReport('730', 'HL2', makeForm({ duration: '' }));
    const body = JSON.parse(findSubmitWriteCall(fetchMock)[1].body);
    expect(body.duration).toBe('unreported');
  });

  test('game_owned is always true for web submissions', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await ctx.submitReport('730', 'HL2', makeForm());
    const body = JSON.parse(findSubmitWriteCall(fetchMock)[1].body);
    expect(body.game_owned).toBe(true);
  });
});

// ── submitReport validation ─────────────────────────────────────────

describe('submitReport - form validation', () => {
  test('rejects when canInstall not answered', async () => {
    const { ctx } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    const form = makeForm();
    form._formState.canInstall = null;
    const result = await ctx.submitReport('730', 'HL2', form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Can you install/);
  });

  test('rejects when canStart not answered after canInstall=yes', async () => {
    const { ctx } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    const form = makeForm();
    form._formState.canStart = null;
    const result = await ctx.submitReport('730', 'HL2', form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Can you start/);
  });

  test('rejects when canPlay not answered after install+start=yes', async () => {
    const { ctx } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    const form = makeForm();
    form._formState.canPlay = null;
    const result = await ctx.submitReport('730', 'HL2', form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Can you play/);
  });

  test('rejects when verdict not answered after all install=yes', async () => {
    const { ctx } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    const form = makeForm();
    form._formState.verdict = null;
    const result = await ctx.submitReport('730', 'HL2', form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did the game work/);
  });

  test('rejects when fault questions unanswered', async () => {
    const { ctx } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    const form = makeForm();
    form._formState.faults.performanceFaults = null;
    form._formState.faults.audioFaults = null;
    const result = await ctx.submitReport('730', 'HL2', form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/2 fault question/);
  });

  test('accepts when canInstall=no (borked, no further questions needed)', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    const form = makeForm();
    form._formState.canInstall = 'no';
    form._formState.canStart = null;
    form._formState.canPlay = null;
    form._formState.verdict = null;
    const result = await ctx.submitReport('730', 'HL2', form);
    expect(result.ok).toBe(true);
  });
});

// ── submitReport rating derivation ──────────────────────────────────
// Regression coverage for "submitted all-yes answers but got rated Borked".
// The previous code had `rating: derivedRating || 'borked'` which silently
// shipped the worst possible rating if anything went sideways. We now
// refuse to submit when rating can't be derived.

describe('submitReport - rating derivation', () => {
  test('ships derived platinum when all yes + oob=yes + no faults', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    const result = await ctx.submitReport('730', 'HL2', makeForm());
    expect(result.ok).toBe(true);
    const body = JSON.parse(findSubmitWriteCall(fetchMock)[1].body);
    expect(body.rating).toBe('platinum');
  });

  test('ships derived borked when canInstall=no (legit borked)', async () => {
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    const form = makeForm();
    form._formState.canInstall = 'no';
    form._formState.canStart = null; form._formState.canPlay = null;
    form._formState.verdict = null;
    const result = await ctx.submitReport('730', 'HL2', form);
    expect(result.ok).toBe(true);
    const body = JSON.parse(findSubmitWriteCall(fetchMock)[1].body);
    expect(body.rating).toBe('borked');
  });

  test('never silently defaults to borked when derivation returns null', async () => {
    // Construct a state that bypasses validation (e.g. someone calls
    // submitReport directly with an inconsistent form) and confirm we
    // refuse instead of shipping 'borked' as a guess
    const { ctx, fetchMock } = makeCtx({ access_token: 'tok', user: { id: 'pp-1' } });
    fetchMock.mockClear();
    const form = makeForm();
    // Make state internally inconsistent: install=yes, all faults=null
    // (validation should normally catch this, but if state arrives this
    // way the derivation returns null and we MUST NOT default to borked)
    form._formState.canInstall = 'yes';
    form._formState.canStart = 'yes';
    form._formState.canPlay = 'yes';
    form._formState.verdict = null;
    // Pre-pass the can-* validation but force verdict empty by clearing
    // it after building the form. The validation will catch this first
    // and refuse with a "Overall, did the game work?" error -- which is
    // exactly the safe path we want
    const result = await ctx.submitReport('730', 'HL2', form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did the game work|Cannot derive/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── parseSteamSystemInfo ────────────────────────────────────────────

describe('parseSteamSystemInfo', () => {
  let parse;

  beforeAll(() => {
    const { ctx } = makeCtx(null);
    parse = ctx.parseSteamSystemInfo;
  });

  test('parses CPU Brand', () => {
    const r = parse('CPU Brand: AMD Ryzen 7 5800X3D 8-Core Processor');
    expect(r.cpu).toBe('AMD Ryzen 7 5800X3D 8-Core Processor');
  });

  test('parses RAM in MB and converts to GB', () => {
    const r = parse('RAM: 32768 Mb');
    expect(r.ram).toBe('32 GB');
  });

  test('parses VRAM', () => {
    const r = parse('VRAM: 8192 Mb');
    expect(r.vramMb).toBe(8192);
  });

  test('parses kernel version', () => {
    const r = parse('Kernel Version: 6.8.12-arch1-1');
    expect(r.kernel).toBe('6.8.12-arch1-1');
  });

  test('filters out Unknown driver version', () => {
    const r = parse('Driver Version: Unknown');
    expect(r.gpuDriver).toBeUndefined();
  });

  test('parses real driver version', () => {
    const r = parse('Driver Version: Mesa 25.2.8');
    expect(r.gpuDriver).toBe('Mesa 25.2.8');
  });

  test('parses Steam Deck two-line Video Card format', () => {
    const text = `Video Card:
    Driver:  Advanced Micro Devices, Inc. [AMD/ATI] VanGogh [AMD Custom GPU 0405]
    Driver Version:  Unknown`;
    const r = parse(text);
    expect(r.gpu).toMatch(/VanGogh/);
    expect(r.gpu).not.toMatch(/^Advanced Micro/);
    expect(r.gpuDriver).toBeUndefined();
  });

  test('infers AMD vendor from GPU name', () => {
    const r = parse('Video Card:\n    Driver: Radeon RX 6800 XT');
    expect(r.gpuVendor).toBe('amd');
  });

  test('infers nvidia vendor from GPU name', () => {
    const r = parse('Video Card:\n    Driver: NVIDIA GeForce RTX 4070');
    expect(r.gpuVendor).toBe('nvidia');
  });

  test('infers intel vendor from GPU name', () => {
    const r = parse('Video Card:\n    Driver: Intel Iris Xe');
    expect(r.gpuVendor).toBe('intel');
  });

  test('parses OS version line', () => {
    const r = parse('OS Version: SteamOS 3.5');
    expect(r.os).toBe('SteamOS 3.5');
  });

  test('returns empty object for null input', () => {
    expect(parse(null)).toEqual({});
    expect(parse('')).toEqual({});
  });
});
