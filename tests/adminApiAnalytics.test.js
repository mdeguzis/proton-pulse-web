/**
 * Behavioral tests for js/admin/api/analytics.js loaded via require()
 * so the coverage report sees the lines hit.
 */

global.window = global;
global.window.SUPABASE_URL = 'https://test.supabase.co';
global.window.SUPABASE_ANON_KEY = 'test-anon-key';
const { fetchAnalytics } = require('../js/admin/api/analytics.js');

const makeSession = () => ({ access_token: 'tok_a' });

function routedFetch(routes) {
  return jest.fn(async (url) => {
    const entry = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!entry) return { ok: true, json: async () => [] };
    const payload = entry[1];
    if (payload && typeof payload === 'object' && payload.__http) {
      // sentinel for non-ok response: { __http: { ok, status, text } }
      return payload.__http;
    }
    return { ok: true, json: async () => payload };
  });
}

// Small helpers so fixture dates track today rather than being frozen in
// time. fetchReportsByDay pads a window from (today - daysBack) to today
// inclusive, so any fixture row outside that window silently drops out of
// the padded output and the test starts failing as the wall clock advances
// (issue #212).
function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

describe('fetchAnalytics top-level RPC + side fetches', () => {
  test('POSTs to admin_analytics with days_back and merges side fetches', async () => {
    const rpcPayload = {
      totals: { authed_users: 7 },
      daily: [],
      top_pages: [],
      top_games: [],
      event_types: [],
    };
    // Pick two days inside the daysBack=7 window so both survive padding
    // regardless of the current wall-clock date.
    const dayA = isoDaysAgo(3);
    const dayB = isoDaysAgo(1);
    const fetchSpy = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': rpcPayload,
      'https://test.supabase.co/rest/v1/user_configs': [
        { created_at: `${dayA}T10:00:00Z`, source: 'web-linux' },
        { created_at: `${dayB}T09:00:00Z`, source: 'plugin-linux' },
      ],
      'https://test.supabase.co/rest/v1/site_events': [
        { metadata: { hits: 5, misses: 1 }, created_at: `${dayB}T01:00:00Z` },
      ],
    });
    global.fetch = fetchSpy;
    const result = await fetchAnalytics(makeSession(), { daysBack: 7 });

    const rpcCall = fetchSpy.mock.calls.find(([url]) =>
      url === 'https://test.supabase.co/rest/v1/rpc/admin_analytics'
    );
    expect(rpcCall).toBeTruthy();
    expect(rpcCall[1].method).toBe('POST');
    expect(JSON.parse(rpcCall[1].body)).toEqual({ days_back: 7 });

    expect(result.totals.authed_users).toBe(7);
    // reports_by_day pads every day in the range with zero rows; assert on
    // the non-zero entries so the test stays stable regardless of the
    // padding window size or wall-clock "today".
    expect(result.reports_by_day.filter(r => r.count > 0)).toEqual([
      { day: dayA, count: 1, web: 1, plugin: 0, other: 0 },
      { day: dayB, count: 1, web: 0, plugin: 1, other: 0 },
    ]);
    expect(result.sw_cache.hits).toBe(5);
    expect(result.sw_cache.misses).toBe(1);
    expect(result.sw_cache.hit_rate).toBe(83);
  });

  test('throws when the RPC returns non-ok', async () => {
    global.fetch = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': {
        __http: { ok: false, status: 500, text: async () => 'boom' },
      },
    });
    await expect(fetchAnalytics(makeSession())).rejects.toThrow(/fetchAnalytics failed \(500\)/);
  });

  test('side fetches that throw or 4xx degrade to safe defaults', async () => {
    // RPC ok, user_configs throws, site_events 4xx -> reports_by_day=[]
    // and sw_cache=null instead of bubbling the failure.
    const fetchSpy = jest.fn(async (url) => {
      if (url.startsWith('https://test.supabase.co/rest/v1/rpc/admin_analytics')) {
        return { ok: true, json: async () => ({ totals: {} }) };
      }
      if (url.startsWith('https://test.supabase.co/rest/v1/user_configs')) {
        throw new Error('network');
      }
      if (url.startsWith('https://test.supabase.co/rest/v1/site_events')) {
        return { ok: false, status: 401, text: async () => '' };
      }
      return { ok: true, json: async () => [] };
    });
    global.fetch = fetchSpy;
    const result = await fetchAnalytics(makeSession());
    expect(result.reports_by_day).toEqual([]);
    expect(result.sw_cache).toBeNull();
  });
});

describe('fetchReportsByDay source bucketing (via fetchAnalytics)', () => {
  test('rows with unknown source bucket into "other"', async () => {
    global.fetch = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': { totals: {} },
      'https://test.supabase.co/rest/v1/user_configs': [
        { created_at: '2026-06-30T01:00:00Z', source: 'protondb' },
        { created_at: '2026-06-30T02:00:00Z', source: '' },
        { created_at: '2026-06-30T03:00:00Z', source: null },
      ],
    });
    const result = await fetchAnalytics(makeSession());
    expect(result.reports_by_day.filter(r => r.count > 0)).toEqual([
      { day: '2026-06-30', count: 3, web: 0, plugin: 0, other: 3 },
    ]);
  });

  test('source classification is case-insensitive on the prefix', async () => {
    global.fetch = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': { totals: {} },
      'https://test.supabase.co/rest/v1/user_configs': [
        { created_at: '2026-06-30T01:00:00Z', source: 'WEB-LINUX' },
        { created_at: '2026-06-30T02:00:00Z', source: 'Plugin-Steamdeck' },
      ],
    });
    const result = await fetchAnalytics(makeSession());
    const nonZero = result.reports_by_day.filter(r => r.count > 0);
    expect(nonZero[0]).toEqual({ day: '2026-06-30', count: 2, web: 1, plugin: 1, other: 0 });
  });

  test('days are returned in ascending order', async () => {
    global.fetch = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': { totals: {} },
      'https://test.supabase.co/rest/v1/user_configs': [
        { created_at: '2026-07-01T01:00:00Z', source: 'web' },
        { created_at: '2026-06-28T01:00:00Z', source: 'web' },
        { created_at: '2026-06-30T01:00:00Z', source: 'web' },
      ],
    });
    const result = await fetchAnalytics(makeSession());
    // The zero-padded window also emits 2026-06-29; assert only that the
    // days with data appear in ascending order.
    expect(result.reports_by_day.filter(r => r.count > 0).map((r) => r.day))
      .toEqual(['2026-06-28', '2026-06-30', '2026-07-01']);
  });

  test('rows missing created_at are skipped silently', async () => {
    global.fetch = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': { totals: {} },
      'https://test.supabase.co/rest/v1/user_configs': [
        { source: 'web' },
        { created_at: '2026-06-30T01:00:00Z', source: 'web' },
      ],
    });
    const result = await fetchAnalytics(makeSession());
    expect(result.reports_by_day.filter(r => r.count > 0)).toEqual([
      { day: '2026-06-30', count: 1, web: 1, plugin: 0, other: 0 },
    ]);
  });

  test('every day in the range is emitted as at least a zero row (padding)', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-30T18:00:00Z') });
    try {
      global.fetch = routedFetch({
        'https://test.supabase.co/rest/v1/rpc/admin_analytics': { totals: {} },
        'https://test.supabase.co/rest/v1/user_configs': [
          { created_at: '2026-06-30T01:00:00Z', source: 'web' },
        ],
      });
      const result = await fetchAnalytics(makeSession(), { daysBack: 3 });
      // 3-day window ending 2026-06-30 covers 06-27, 06-28, 06-29, 06-30.
      // Every day must be present so the chart line reaches zero on empty
      // days instead of skipping them.
      expect(result.reports_by_day.map(r => r.day)).toEqual([
        '2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30',
      ]);
      expect(result.reports_by_day.slice(0, 3).every(r => r.count === 0)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('sw_cache aggregation', () => {
  test('rows without metadata default hits/misses to 0', async () => {
    global.fetch = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': { totals: {} },
      'https://test.supabase.co/rest/v1/site_events': [
        { metadata: null, created_at: '2026-06-30T01:00:00Z' },
        { metadata: { hits: 4, misses: 0 }, created_at: '2026-06-30T02:00:00Z' },
      ],
    });
    const result = await fetchAnalytics(makeSession());
    expect(result.sw_cache.hits).toBe(4);
    expect(result.sw_cache.misses).toBe(0);
    expect(result.sw_cache.hit_rate).toBe(100);
  });

  test('zero traffic returns hit_rate 0 without dividing by zero', async () => {
    global.fetch = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': { totals: {} },
      'https://test.supabase.co/rest/v1/site_events': [],
    });
    const result = await fetchAnalytics(makeSession());
    expect(result.sw_cache).toEqual({
      sessions: 0, hits: 0, misses: 0, served: 0, hit_rate: 0, by_day: [],
    });
  });

  test('per-day hit_rate rounds correctly', async () => {
    global.fetch = routedFetch({
      'https://test.supabase.co/rest/v1/rpc/admin_analytics': { totals: {} },
      'https://test.supabase.co/rest/v1/site_events': [
        { metadata: { hits: 3, misses: 1 }, created_at: '2026-06-29T01:00:00Z' },
        { metadata: { hits: 2, misses: 8 }, created_at: '2026-06-30T01:00:00Z' },
      ],
    });
    const result = await fetchAnalytics(makeSession());
    const byDay = Object.fromEntries(result.sw_cache.by_day.map((d) => [d.day, d.hit_rate]));
    expect(byDay['2026-06-29']).toBe(75);
    expect(byDay['2026-06-30']).toBe(20);
  });
});
