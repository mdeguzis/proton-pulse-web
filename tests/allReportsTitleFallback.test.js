/**
 * Tests for #147: rows whose title was stored as a fallback ("App <id>",
 * empty, or equal to the app_id) get their title replaced from
 * search-index.json at fetch time.
 *
 * Behavioral tests load the api module into a vm context with a stub
 * fetch that hands back canned user_configs / report_approvals rows
 * plus a search-index payload.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripModuleSyntax } = require('./_esm-vm.js');

const ROOT = path.join(__dirname, '..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'allReports.js'), 'utf8');

function loadApi(rowsByUrl) {
  const ctx = {
    fetch: async (url) => {
      const hit = Object.entries(rowsByUrl).find(([prefix]) => url.startsWith(prefix));
      if (!hit) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => hit[1] };
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

const SEARCH_INDEX_URL = 'https://www.proton-pulse.com/search-index.json';

describe('fetchAllReports fallback-title repair (#147)', () => {
  test('rewrites "App <id>" title from search-index.json', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 23, app_id: '2881370', title: 'App 2881370', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      [SEARCH_INDEX_URL]: [['2881370', 'Thank You For Your Application', '', 0, 0, 'steam']],
    });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    expect(rows[0].title).toBe('Thank You For Your Application');
  });

  test('rewrites empty title', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '570', title: '', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      [SEARCH_INDEX_URL]: [['570', 'Dota 2', 'platinum', 100, 5, 'steam']],
    });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    expect(rows[0].title).toBe('Dota 2');
  });

  test('rewrites title that equals the app_id string', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '730', title: '730', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      [SEARCH_INDEX_URL]: [['730', 'Counter-Strike 2', 'platinum', 1000, 0, 'steam']],
    });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    expect(rows[0].title).toBe('Counter-Strike 2');
  });

  test('leaves a real title alone', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '570', title: 'Dota 2', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      [SEARCH_INDEX_URL]: [['570', 'Dota: Definitive', 'gold', 100, 0, 'steam']],
    });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    // Real title takes precedence -- the index is not authoritative when
    // the DB row already has a non-fallback value.
    expect(rows[0].title).toBe('Dota 2');
  });

  test('falls through gracefully when the app is not in the index', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '99999', title: 'App 99999', is_flagged: false, is_hidden: false, flagged_reason: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      [SEARCH_INDEX_URL]: [['570', 'Dota 2', 'platinum', 100, 0, 'steam']],
    });
    const rows = await ctx.fetchAllReports({}, { status: '' });
    expect(rows[0].title).toBe('App 99999'); // unchanged when no hit
  });

  test('skips the search-index fetch entirely when every row has a real title', async () => {
    let indexCalls = 0;
    const ctx = {
      fetch: async (url) => {
        if (url === SEARCH_INDEX_URL) indexCalls += 1;
        if (url.startsWith('https://test.supabase.co/rest/v1/user_configs')) {
          return { ok: true, json: async () => [
            { id: 1, app_id: '570', title: 'Dota 2', is_flagged: false, is_hidden: false, flagged_reason: null },
            { id: 2, app_id: '730', title: 'Counter-Strike 2', is_flagged: false, is_hidden: false, flagged_reason: null },
          ]};
        }
        return { ok: true, json: async () => [] };
      },
      SUPABASE_URL: 'https://test.supabase.co',
      supabaseHeaders: () => ({ apikey: 'x' }),
      location: { hostname: 'localhost' },
      console,
      Promise, JSON, Object, Array, Number, String, Date, Math, Map, Set, RegExp,
      setTimeout, clearTimeout,
      encodeURIComponent,
    };
    vm.createContext(ctx);
    vm.runInContext(stripModuleSyntax(API_SRC), ctx);
    await ctx.fetchAllReports({}, { status: '' });
    expect(indexCalls).toBe(0);
  });
});

describe('fetchReportById applies the same fallback repair (#147)', () => {
  test('detail fetch also pulls from search-index for fallback titles', async () => {
    const ctx = loadApi({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 23, app_id: '2881370', title: 'App 2881370', is_flagged: false, is_hidden: false, flagged_reason: null, flagged_at: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      [SEARCH_INDEX_URL]: [['2881370', 'Thank You For Your Application', '', 0, 0, 'steam']],
    });
    const r = await ctx.fetchReportById({}, 23);
    expect(r.title).toBe('Thank You For Your Application');
  });
});
