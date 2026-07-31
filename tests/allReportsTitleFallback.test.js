/**
 * Tests for #147: rows whose title was stored as a fallback ("App <id>",
 * empty, or equal to the app_id) get their title replaced at fetch time.
 *
 * #437: the source is the search-games batch API (getGamesByIds) instead of
 * the full search-index.json blob. Behavioral tests load the api module into a
 * vm context with a stub fetch for the Supabase rows plus a stub getGamesByIds
 * that resolves the canned title map for the ids it is asked about.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripModuleSyntax } = require('./_esm-vm.js');

const ROOT = path.join(__dirname, '..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'allReports.js'), 'utf8');

// gamesById: { '<appId>': { appId, title } }. getGamesByIds returns a Map of
// only the requested ids that exist, mirroring the real batch wrapper.
function makeCtx(rowsByUrl, gamesById, counters = {}) {
  const ctx = {
    fetch: async (url) => {
      const hit = Object.entries(rowsByUrl).find(([prefix]) => url.startsWith(prefix));
      if (!hit) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => hit[1] };
    },
    getGamesByIds: async (ids) => {
      counters.batchCalls = (counters.batchCalls || 0) + 1;
      const map = new Map();
      for (const id of (ids || [])) {
        const g = gamesById[String(id)];
        if (g) map.set(String(id), g);
      }
      return map;
    },
    SUPABASE_URL: 'https://test.supabase.co',
    supabaseHeaders: () => ({ apikey: 'x', Authorization: 'Bearer x' }),
    location: { hostname: 'localhost' },
    console,
    Promise, JSON, Object, Array, Number, String, Date, Math, Map, Set, RegExp,
    setTimeout, clearTimeout,
    encodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(stripModuleSyntax(API_SRC), ctx);
  return ctx;
}

function loadApi(rowsByUrl, gamesById = {}) {
  return makeCtx(rowsByUrl, gamesById);
}

describe('fetchAllReports fallback-title repair (#147, via batch API #437)', () => {
  test('rewrites "App <id>" title from the batch API', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 23, app_id: '2881370', title: 'App 2881370', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    }, { '2881370': { appId: '2881370', title: 'Thank You For Your Application' } });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    expect(rows[0].title).toBe('Thank You For Your Application');
  });

  test('rewrites empty title', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '570', title: '', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    }, { '570': { appId: '570', title: 'Dota 2' } });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    expect(rows[0].title).toBe('Dota 2');
  });

  test('rewrites title that equals the app_id string', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '730', title: '730', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    }, { '730': { appId: '730', title: 'Counter-Strike 2' } });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    expect(rows[0].title).toBe('Counter-Strike 2');
  });

  test('leaves a real title alone', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '570', title: 'Dota 2', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    }, { '570': { appId: '570', title: 'Dota: Definitive' } });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    // Real title takes precedence -- the index is not authoritative when the
    // DB row already has a non-fallback value.
    expect(rows[0].title).toBe('Dota 2');
  });

  test('falls through gracefully when the app is not returned by the batch API', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '99999', title: 'App 99999', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    }, { '570': { appId: '570', title: 'Dota 2' } });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    expect(rows[0].title).toBe('App 99999'); // unchanged when no hit
  });

  test('skips the batch API entirely when every row has a real title', async () => {
    const counters = {};
    const ctx = makeCtx({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '570', title: 'Dota 2', is_flagged: false, is_hidden: false, flagged_reason: null },
        { id: 2, app_id: '730', title: 'Counter-Strike 2', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    }, {}, counters);
    await ctx.fetchAllReports({}, { status: '' });
    expect(counters.batchCalls || 0).toBe(0);
  });
});

describe('fetchReportById applies the same fallback repair (#147)', () => {
  test('detail fetch also uses the batch API for fallback titles', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 23, app_id: '2881370', title: 'App 2881370', is_flagged: false, is_hidden: false, flagged_reason: null, flagged_at: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    }, { '2881370': { appId: '2881370', title: 'Thank You For Your Application' } });
    const r = await ctx.fetchReportById({}, 23);
    expect(r.title).toBe('Thank You For Your Application');
  });
});
