/**
 * Require-loaded behavioral tests for pure-ish lib modules so Istanbul
 * sees the lines hit. Existing vm-based suites (loadEsm in _esm-vm.js)
 * keep working as integration covers but do not contribute to the
 * coverage report.
 */

// ── js/lib/app-id.js ────────────────────────────────────────────────────────

describe('appIdToDir', () => {
  const { appIdToDir } = require('../js/lib/app-id.js');

  test('Steam numeric ids pass through unchanged', () => {
    expect(appIdToDir('730')).toBe('730');
    expect(appIdToDir(730)).toBe('730');
  });

  test('GOG canonical ids collapse the colon to underscore', () => {
    expect(appIdToDir('gog:123')).toBe('gog_123');
    expect(appIdToDir('gog:1971477531')).toBe('gog_1971477531');
  });

  test('Epic canonical ids collapse the colon too', () => {
    expect(appIdToDir('epic:fortnite')).toBe('epic_fortnite');
  });

  test('only the first colon is replaced (canonical ids only carry one)', () => {
    expect(appIdToDir('gog:abc:def')).toBe('gog_abc:def');
  });
});

// ── js/lib/gpu-arch-detector.js ─────────────────────────────────────────────

describe('detectGpuArch', () => {
  const { detectGpuArch } = require('../js/lib/gpu-arch-detector.js');

  test('empty / falsy input returns empty string', () => {
    expect(detectGpuArch('')).toBe('');
    expect(detectGpuArch(null)).toBe('');
    expect(detectGpuArch(undefined)).toBe('');
  });

  test('AMD RDNA generations classify correctly', () => {
    expect(detectGpuArch('AMD Radeon RX 9070')).toBe('RDNA4');
    expect(detectGpuArch('Radeon RX 7900 XTX')).toBe('RDNA3');
    expect(detectGpuArch('Radeon RX 6800')).toBe('RDNA2');
    expect(detectGpuArch('Steam Deck Van Gogh APU')).toBe('RDNA2');
    expect(detectGpuArch('Radeon RX 5700 XT')).toBe('RDNA');
  });

  test('older AMD architectures Vega / Polaris / GCN classify', () => {
    expect(detectGpuArch('Radeon RX Vega 64')).toBe('Vega');
    expect(detectGpuArch('Radeon VII')).toBe('Vega');
    expect(detectGpuArch('Radeon RX 580')).toBe('Polaris');
    expect(detectGpuArch('Radeon R9 Fury X')).toBe('GCN3');
    expect(detectGpuArch('Radeon R9 285')).toBe('GCN3');
    // #151: R9 280 is Tahiti -> GCN2, not GCN3.
    expect(detectGpuArch('Radeon R9 280X')).toBe('GCN2');
    expect(detectGpuArch('Radeon R9 270X')).toBe('GCN2');
    expect(detectGpuArch('Radeon HD 7970')).toBe('GCN1');
  });

  test('NVIDIA RTX generations classify correctly', () => {
    expect(detectGpuArch('NVIDIA GeForce RTX 5090')).toBe('Blackwell');
    expect(detectGpuArch('GeForce RTX 4060 Ti')).toBe('Ada');
    expect(detectGpuArch('GeForce RTX 3080')).toBe('Ampere');
    expect(detectGpuArch('NVIDIA A100')).toBe('Ampere');
    expect(detectGpuArch('GeForce RTX 2070')).toBe('Turing');
    expect(detectGpuArch('GeForce GTX 1660 Ti')).toBe('Turing');
  });

  test('NVIDIA GTX generations classify correctly', () => {
    expect(detectGpuArch('GeForce GTX 1080 Ti')).toBe('Pascal');
    expect(detectGpuArch('GeForce GTX 1070')).toBe('Pascal');
    expect(detectGpuArch('GeForce GTX 1060')).toBe('Pascal');
    expect(detectGpuArch('GeForce GTX 1050')).toBe('Pascal');
    expect(detectGpuArch('GeForce GTX 960')).toBe('Maxwell');
    expect(detectGpuArch('GeForce GTX 750')).toBe('Maxwell');
    expect(detectGpuArch('GeForce GTX 770')).toBe('Kepler');
    expect(detectGpuArch('GeForce GTX 660')).toBe('Kepler');
  });

  test('Intel Arc / Xe / Gen9 classify (#151: Intel block precedes NVIDIA)', () => {
    expect(detectGpuArch('Intel Arc B580')).toBe('Battlemage');
    // Intel Arc A-series no longer falls through to NVIDIA Ampere.
    expect(detectGpuArch('Intel Arc A770')).toBe('Alchemist');
    expect(detectGpuArch('Intel Arc A380')).toBe('Alchemist');
    expect(detectGpuArch('Intel Iris Xe Graphics')).toBe('Xe');
    // The optional "graphics" word now matches.
    expect(detectGpuArch('Intel UHD Graphics 770')).toBe('Xe');
    expect(detectGpuArch('Intel UHD 770')).toBe('Xe');
    expect(detectGpuArch('Intel HD Graphics 530')).toBe('Gen9');
    expect(detectGpuArch('Intel UHD Graphics 630')).toBe('Gen9');
  });

  test('NVIDIA Ampere workstation A-series still classifies after the Intel reorder', () => {
    // Regression guard: moving Intel above NVIDIA must not break the
    // `\ba\d{3,4}\b` Ampere fallback for actual NVIDIA cards.
    expect(detectGpuArch('NVIDIA A100')).toBe('Ampere');
    expect(detectGpuArch('NVIDIA A4000')).toBe('Ampere');
  });

  test('unrecognised GPU strings return empty', () => {
    expect(detectGpuArch('llvmpipe')).toBe('');
    expect(detectGpuArch('Microsoft Basic Render Driver')).toBe('');
  });

  test('mixed case + extra whitespace still match', () => {
    expect(detectGpuArch('RX 7900')).toBe('RDNA3');
    expect(detectGpuArch('rtx  4070')).toBe('Ada');
  });
});

// ── js/lib/analytics.js ─────────────────────────────────────────────────────
//
// analytics.js is an IIFE that wires window.ppTrack at load time. To get
// require-credit we set up the minimal browser-like globals it touches
// and then require the module so the IIFE runs once.

describe('analytics.js track() core behavior', () => {
  let origFetch;
  let origLocation;
  let fetchSpy;
  let track;

  beforeEach(() => {
    jest.resetModules();
    origFetch = global.fetch;
    origLocation = global.location;
    global.window = global;
    global.window.SUPABASE_URL = 'https://test.supabase.co';
    global.window.SUPABASE_ANON_KEY = 'anon-key';
    global.window.SupaAuth = { getSession: jest.fn().mockResolvedValue(null) };
    global.navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' };
    global.location = { pathname: '/app.html' };
    global.sessionStorage = {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = String(v); },
    };
    global.document = { addEventListener: jest.fn(), querySelectorAll: () => [] };
    // window.addEventListener is needed for the error/unhandledrejection hooks.
    global.window.addEventListener = jest.fn();
    fetchSpy = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchSpy;
    // Reload the module each test so the IIFE re-runs with fresh stubs.
    require('../js/lib/analytics.js');
    track = global.window.ppTrack;
  });

  afterEach(() => {
    global.fetch = origFetch;
    global.location = origLocation;
    delete global.window.ppTrack;
    delete global.window.SupaAuth;
  });

  test('exports ppTrack on window', () => {
    expect(typeof track).toBe('function');
  });

  test('anonymous track posts with proton_pulse_user_id=null and anon-key auth', async () => {
    await track('page_view', {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.event_type).toBe('page_view');
    expect(body.proton_pulse_user_id).toBeNull();
    expect(body.metadata.device).toBe('desktop');
    expect(init.headers.Authorization).toBe('Bearer anon-key');
  });

  test('signed-in track attaches user id + bearer access_token', async () => {
    global.window.SupaAuth.getSession.mockResolvedValue({
      access_token: 'tok_xyz',
      user: { id: 'pp-user-1' },
    });
    await track('game_view', { app_id: '730' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.proton_pulse_user_id).toBe('pp-user-1');
    expect(body.metadata).toEqual({ device: 'desktop', app_id: '730' });
    expect(init.headers.Authorization).toBe('Bearer tok_xyz');
  });

  test('Steam Deck UA classifies as deck', async () => {
    jest.resetModules();
    global.navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; SteamDeck)' };
    require('../js/lib/analytics.js');
    await global.window.ppTrack('page_view', {});
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body).metadata.device).toBe('deck');
  });

  test('Android UA classifies as mobile', async () => {
    jest.resetModules();
    global.navigator = { userAgent: 'Mozilla/5.0 (Linux; Android 14)' };
    require('../js/lib/analytics.js');
    await global.window.ppTrack('page_view', {});
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).metadata.device).toBe('mobile');
  });

  test('curl-like UA classifies as other', async () => {
    jest.resetModules();
    global.navigator = { userAgent: 'curl/8.5.0' };
    require('../js/lib/analytics.js');
    await global.window.ppTrack('page_view', {});
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).metadata.device).toBe('other');
  });

  test('window error listener fires error_event with rate-limit', async () => {
    // Re-init so we can capture the listener registration.
    jest.resetModules();
    const listeners = {};
    global.window.addEventListener = jest.fn((event, fn) => { listeners[event] = fn; });
    require('../js/lib/analytics.js');
    expect(listeners.error).toBeDefined();
    expect(listeners.unhandledrejection).toBeDefined();

    fetchSpy.mockClear();
    listeners.error({ message: 'boom', filename: 'a.js', lineno: 1, colno: 1, error: { stack: 'Error: boom\n  at x' } });
    listeners.error({ message: 'boom', filename: 'a.js', lineno: 1, colno: 1, error: { stack: 'Error: boom\n  at x' } });
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event_type).toBe('error_event');
    expect(body.metadata.message).toBe('boom');
  });

  test('unhandledrejection listener extracts reason.message', async () => {
    jest.resetModules();
    const listeners = {};
    global.window.addEventListener = jest.fn((event, fn) => { listeners[event] = fn; });
    require('../js/lib/analytics.js');
    fetchSpy.mockClear();
    listeners.unhandledrejection({ reason: { message: 'p-rej', stack: 'Error: p-rej\n  at p' } });
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.metadata.message).toBe('p-rej');
    expect(body.metadata.source).toBe('unhandledrejection');
  });
});
