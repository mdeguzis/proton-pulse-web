/**
 * Tests for #142: analytics tracking must attach proton_pulse_user_id when
 * a Supabase session exists, and the analytics.js script must load on every
 * public HTML page so window.ppTrack actually exists site-wide.
 *
 * The chart query in admin_analytics() counts distinct proton_pulse_user_id
 * from site_events. Without these two fixes, the chart undercounts because
 * (a) the script wasn't loaded on most pages, and (b) when it was loaded,
 * track() never sent the id.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ANALYTICS_SRC = fs.readFileSync(path.join(ROOT, 'js', 'lib', 'analytics.js'), 'utf8');

function loadAnalytics({ session, fetchImpl, userAgent } = {}) {
  const sessionStorageMap = {};
  const docListeners = [];
  const winListeners = [];
  const ctx = {
    fetch: fetchImpl || jest.fn().mockResolvedValue({ ok: true }),
    crypto: { randomUUID: () => 'test-sid-uuid' },
    sessionStorage: {
      getItem: (k) => Object.prototype.hasOwnProperty.call(sessionStorageMap, k) ? sessionStorageMap[k] : null,
      setItem: (k, v) => { sessionStorageMap[k] = String(v); },
    },
    navigator: { userAgent: userAgent || 'Mozilla/5.0 (X11; Linux x86_64)' },
    document: {
      addEventListener: (event, fn) => docListeners.push({ event, fn }),
      querySelectorAll: () => [],
    },
    location: { pathname: '/app.html' },
    console,
    Promise, JSON, Object, Math, Date,
    setTimeout, clearTimeout,
  };
  ctx.window = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    addEventListener: (event, fn) => winListeners.push({ event, fn }),
  };
  if (session !== undefined) {
    ctx.window.SupaAuth = {
      getSession: jest.fn().mockResolvedValue(session),
    };
  }
  // analytics.js reads SUPABASE_URL/SUPABASE_ANON_KEY off window at IIFE-init time.
  // Mirror those onto the vm context so the iife resolves them.
  ctx.SUPABASE_URL = ctx.window.SUPABASE_URL;
  ctx.SUPABASE_ANON_KEY = ctx.window.SUPABASE_ANON_KEY;
  ctx.addEventListener = ctx.window.addEventListener;
  vm.createContext(ctx);
  vm.runInContext(ANALYTICS_SRC, ctx);
  return { ctx, docListeners, winListeners };
}

async function flushAsync() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('analytics.js track()', () => {
  test('attaches proton_pulse_user_id from active session', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({
      session: { access_token: 'tok_abc', user: { id: 'pp-user-1' } },
      fetchImpl,
    });
    await ctx.window.ppTrack('game_view', { app_id: '730' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.proton_pulse_user_id).toBe('pp-user-1');
    expect(body.event_type).toBe('game_view');
    expect(body.session_id).toBe('test-sid-uuid');
  });

  test('uses access_token in Authorization when session exists', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({
      session: { access_token: 'tok_xyz', user: { id: 'pp-2' } },
      fetchImpl,
    });
    await ctx.window.ppTrack('page_view', {});
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok_xyz');
  });

  test('falls back to anon key Authorization for signed-out visitors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({ session: null, fetchImpl });
    await ctx.window.ppTrack('page_view', {});
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer anon-key');
    const body = JSON.parse(init.body);
    expect(body.proton_pulse_user_id).toBeNull();
  });

  test('survives missing SupaAuth (loaded before supabase-client.js)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({ fetchImpl });
    // No window.SupaAuth defined. Should still post, just as anonymous.
    await ctx.window.ppTrack('page_view', {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.proton_pulse_user_id).toBeNull();
  });

  test('survives SupaAuth.getSession throwing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({ fetchImpl });
    ctx.window.SupaAuth = {
      getSession: jest.fn().mockRejectedValue(new Error('not ready')),
    };
    await ctx.window.ppTrack('page_view', {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.proton_pulse_user_id).toBeNull();
  });

  test('always attaches device field even when caller passes empty metadata', async () => {
    // #143: track() folds the device tag into metadata for every event so
    // admin charts can break Deck vs phone vs desktop. Caller-supplied
    // metadata stays intact alongside it.
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({ session: null, fetchImpl });
    await ctx.window.ppTrack('page_view', {});
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ device: 'desktop' });
  });

  test('merges device with caller metadata', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({ session: null, fetchImpl });
    await ctx.window.ppTrack('report_submit', { app_id: '730', is_edit: true });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ device: 'desktop', app_id: '730', is_edit: true });
  });

  test('no-ops when SUPABASE_URL is missing', async () => {
    const fetchImpl = jest.fn();
    const ctx = {
      fetch: fetchImpl,
      crypto: { randomUUID: () => 'sid' },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      navigator: { userAgent: 'Mozilla/5.0' },
      document: { addEventListener: () => {}, querySelectorAll: () => [] },
      location: { pathname: '/' },
      console,
      Promise, JSON, Object, Math, Date,
      setTimeout, clearTimeout,
    };
    ctx.window = {
      SUPABASE_URL: undefined,
      SUPABASE_ANON_KEY: undefined,
      addEventListener: () => {},
    };
    ctx.SUPABASE_URL = undefined;
    ctx.SUPABASE_ANON_KEY = undefined;
    ctx.addEventListener = () => {};
    vm.createContext(ctx);
    vm.runInContext(ANALYTICS_SRC, ctx);
    await ctx.window.ppTrack('page_view', {});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('analytics.js device classification (#143)', () => {
  test('classifies Steam Deck UA as deck', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({
      session: null,
      fetchImpl,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; SteamDeck) AppleWebKit/...',
    });
    await ctx.window.ppTrack('page_view', {});
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata.device).toBe('deck');
  });

  test('classifies Android UA as mobile', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({
      session: null,
      fetchImpl,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/...',
    });
    await ctx.window.ppTrack('page_view', {});
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata.device).toBe('mobile');
  });

  test('classifies iPhone UA as mobile', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({
      session: null,
      fetchImpl,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/...',
    });
    await ctx.window.ppTrack('page_view', {});
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata.device).toBe('mobile');
  });

  test('classifies Windows UA as desktop', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({
      session: null,
      fetchImpl,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/...',
    });
    await ctx.window.ppTrack('page_view', {});
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata.device).toBe('desktop');
  });

  test('falls back to other for unfamiliar UAs', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({
      session: null,
      fetchImpl,
      userAgent: 'curl/8.5.0',
    });
    await ctx.window.ppTrack('page_view', {});
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata.device).toBe('other');
  });

  test('deck UA wins over the mobile/desktop substring checks', async () => {
    // Steam Deck UA contains both 'SteamDeck' and 'Linux'. Order in
    // classifyDevice() must keep deck the most specific check.
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({
      session: null,
      fetchImpl,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; SteamDeck)',
    });
    await ctx.window.ppTrack('page_view', {});
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata.device).toBe('deck');
  });
});

describe('analytics.js client-side error reporting (#143)', () => {
  test('registers window error + unhandledrejection listeners at boot', () => {
    const { winListeners } = loadAnalytics({ session: null });
    const events = winListeners.map((l) => l.event);
    expect(events).toContain('error');
    expect(events).toContain('unhandledrejection');
  });

  test("error listener fires ppTrack('error_event') with message + stack", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx, winListeners } = loadAnalytics({ session: null, fetchImpl });
    const onError = winListeners.find((l) => l.event === 'error').fn;
    fetchImpl.mockClear();
    onError({
      message: 'boom',
      filename: 'app.js',
      lineno: 42,
      colno: 7,
      error: { stack: 'Error: boom\n  at foo' },
    });
    await flushAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.event_type).toBe('error_event');
    expect(body.metadata.message).toBe('boom');
    expect(body.metadata.file).toBe('app.js');
    expect(body.metadata.line).toBe(42);
    expect(body.metadata.stack).toContain('Error: boom');
  });

  test('rate-limits identical errors within the cooldown window', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { winListeners } = loadAnalytics({ session: null, fetchImpl });
    const onError = winListeners.find((l) => l.event === 'error').fn;
    fetchImpl.mockClear();
    const payload = { message: 'tight loop', error: { stack: 'Error: tight loop\n  at hot' } };
    onError(payload);
    onError(payload);
    onError(payload);
    await flushAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('does not rate-limit distinct error signatures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { winListeners } = loadAnalytics({ session: null, fetchImpl });
    const onError = winListeners.find((l) => l.event === 'error').fn;
    fetchImpl.mockClear();
    onError({ message: 'a', error: { stack: 'Error: a\n  at one' } });
    onError({ message: 'b', error: { stack: 'Error: b\n  at two' } });
    await flushAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('unhandledrejection extracts message from reason.message', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { winListeners } = loadAnalytics({ session: null, fetchImpl });
    const onRej = winListeners.find((l) => l.event === 'unhandledrejection').fn;
    fetchImpl.mockClear();
    onRej({ reason: { message: 'rejected!', stack: 'Error: rejected!\n  at p' } });
    await flushAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.event_type).toBe('error_event');
    expect(body.metadata.message).toBe('rejected!');
    expect(body.metadata.source).toBe('unhandledrejection');
  });

  test('truncates stack trace to 2048 chars', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { winListeners } = loadAnalytics({ session: null, fetchImpl });
    const onError = winListeners.find((l) => l.event === 'error').fn;
    fetchImpl.mockClear();
    const longStack = 'Error: huge\n' + 'x'.repeat(5000);
    onError({ message: 'huge', error: { stack: longStack } });
    await flushAsync();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata.stack.length).toBeLessThanOrEqual(2048);
  });
});

describe('analytics.js loaded on every public HTML page (#142)', () => {
  const PUBLIC_PAGES = [
    'about.html','app.html','auth.html','confidence.html','game-stats.html',
    'index.html','options.html','plugin-link.html','privacy.html','profile.html',
    'scoring.html','stats.html','submit.html','system-edit.html','terms.html',
  ];

  test.each(PUBLIC_PAGES)('%s loads js/lib/analytics.js after supabase-client.js', (page) => {
    const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    expect(src).toMatch(/js\/lib\/analytics\.js/);
    const supabaseIdx = src.indexOf('js/lib/supabase-client.js');
    const analyticsIdx = src.indexOf('js/lib/analytics.js');
    expect(supabaseIdx).toBeGreaterThan(0);
    expect(analyticsIdx).toBeGreaterThan(supabaseIdx);
  });

  test('admin.html still loads analytics.js (regression guard)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
    expect(src).toMatch(/js\/lib\/analytics\.js/);
  });
});
