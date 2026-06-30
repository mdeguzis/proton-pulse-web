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

function loadAnalytics({ session, fetchImpl } = {}) {
  const sessionStorageMap = {};
  const docListeners = [];
  const ctx = {
    fetch: fetchImpl || jest.fn().mockResolvedValue({ ok: true }),
    crypto: { randomUUID: () => 'test-sid-uuid' },
    sessionStorage: {
      getItem: (k) => Object.prototype.hasOwnProperty.call(sessionStorageMap, k) ? sessionStorageMap[k] : null,
      setItem: (k, v) => { sessionStorageMap[k] = String(v); },
    },
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
  vm.createContext(ctx);
  vm.runInContext(ANALYTICS_SRC, ctx);
  return { ctx, docListeners };
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

  test('omits metadata when empty object', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({ session: null, fetchImpl });
    await ctx.window.ppTrack('page_view', {});
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata).toBeNull();
  });

  test('keeps metadata when non-empty', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const { ctx } = loadAnalytics({ session: null, fetchImpl });
    await ctx.window.ppTrack('report_submit', { app_id: '730', is_edit: true });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ app_id: '730', is_edit: true });
  });

  test('no-ops when SUPABASE_URL is missing', async () => {
    const fetchImpl = jest.fn();
    const ctx = {
      fetch: fetchImpl,
      crypto: { randomUUID: () => 'sid' },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      document: { addEventListener: () => {}, querySelectorAll: () => [] },
      location: { pathname: '/' },
      console,
      Promise, JSON, Object, Math, Date,
      setTimeout, clearTimeout,
    };
    ctx.window = { SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined };
    ctx.SUPABASE_URL = undefined;
    ctx.SUPABASE_ANON_KEY = undefined;
    vm.createContext(ctx);
    vm.runInContext(ANALYTICS_SRC, ctx);
    await ctx.window.ppTrack('page_view', {});
    expect(fetchImpl).not.toHaveBeenCalled();
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
