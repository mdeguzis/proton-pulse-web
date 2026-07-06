/**
 * Tests for js/shared/analytics-history.js (#208, umbrella #204).
 *
 * The reshape function is pure and drives the assertions. fetchStatsHistory
 * is exercised through a fake fetchImpl so we do not need a live Supabase.
 */

const {
  fetchStatsHistory, historyToTimeSeries,
} = require('../js/shared/analytics-history.js');

describe('historyToTimeSeries', () => {
  test('empty / non-array input returns empty shape', () => {
    expect(historyToTimeSeries(null)).toEqual({ labels: [], series: [] });
    expect(historyToTimeSeries([])).toEqual({ labels: [], series: [] });
  });

  test('groupBy=total sums all buckets per day into one series', () => {
    const rows = [
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'platinum', hardware_bucket: 'rdna2', report_count: 5 },
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'gold',     hardware_bucket: 'rdna2', report_count: 3 },
      { snapshot_date: '2026-07-02', store: 'gog',   tier: 'silver',   hardware_bucket: 'ampere', report_count: 2 },
    ];
    const out = historyToTimeSeries(rows, { groupBy: 'total', metric: 'report_count' });
    expect(out.labels).toEqual(['2026-07-01', '2026-07-02']);
    expect(out.series).toEqual([{ key: 'total', values: [8, 2] }]);
  });

  test('groupBy=tier makes one series per rating, zero-fills gaps', () => {
    const rows = [
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'platinum', hardware_bucket: 'rdna2', report_count: 4 },
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'borked',   hardware_bucket: 'rdna2', report_count: 1 },
      { snapshot_date: '2026-07-02', store: 'steam', tier: 'platinum', hardware_bucket: 'ampere', report_count: 6 },
      // no 'borked' on 2026-07-02 -> zero fill
    ];
    const out = historyToTimeSeries(rows, { groupBy: 'tier' });
    expect(out.labels).toEqual(['2026-07-01', '2026-07-02']);
    const bySeries = Object.fromEntries(out.series.map(s => [s.key, s.values]));
    expect(bySeries.platinum).toEqual([4, 6]);
    expect(bySeries.borked).toEqual([1, 0]);
  });

  test('groupBy=store keys by platform', () => {
    const rows = [
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'gold', hardware_bucket: 'rdna2', report_count: 10 },
      { snapshot_date: '2026-07-01', store: 'gog',   tier: 'gold', hardware_bucket: 'rdna2', report_count: 3 },
      { snapshot_date: '2026-07-02', store: 'steam', tier: 'gold', hardware_bucket: 'rdna2', report_count: 7 },
    ];
    const out = historyToTimeSeries(rows, { groupBy: 'store' });
    const bySeries = Object.fromEntries(out.series.map(s => [s.key, s.values]));
    expect(bySeries.steam).toEqual([10, 7]);
    expect(bySeries.gog).toEqual([3, 0]);
  });

  test('metric=verified_owner_count uses the correct column', () => {
    const rows = [
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'gold', hardware_bucket: 'rdna2', report_count: 10, verified_owner_count: 4 },
      { snapshot_date: '2026-07-02', store: 'steam', tier: 'gold', hardware_bucket: 'rdna2', report_count: 5,  verified_owner_count: 2 },
    ];
    const out = historyToTimeSeries(rows, { groupBy: 'total', metric: 'verified_owner_count' });
    expect(out.series[0].values).toEqual([4, 2]);
  });

  test('metric=avg_playtime_minutes is a report-count-weighted mean per day', () => {
    // Two buckets on the same day: 100 reports at avg 60, 10 reports at avg 600.
    // Weighted mean = (100*60 + 10*600) / 110 = 12000 / 110 ~ 109.09
    const rows = [
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'gold',   hardware_bucket: 'rdna2',  report_count: 100, avg_playtime_minutes: 60 },
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'silver', hardware_bucket: 'ampere', report_count: 10,  avg_playtime_minutes: 600 },
    ];
    const out = historyToTimeSeries(rows, { groupBy: 'total', metric: 'avg_playtime_minutes' });
    expect(out.series[0].values[0]).toBeCloseTo(109.09, 1);
  });

  test('unknown groupBy value falls back to "unknown" bucket instead of crashing', () => {
    const rows = [
      { snapshot_date: '2026-07-01', store: 'steam', tier: 'gold', hardware_bucket: null, report_count: 2 },
    ];
    const out = historyToTimeSeries(rows, { groupBy: 'hardware_bucket' });
    expect(out.series[0].key).toBe('unknown');
    expect(out.series[0].values).toEqual([2]);
  });
});

describe('fetchStatsHistory', () => {
  function fakeFetch(rows, { status = 200 } = {}) {
    return jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(rows),
    });
  }

  test('constructs the correct REST URL with date-range params + filters', async () => {
    const fetchImpl = fakeFetch([]);
    await fetchStatsHistory({
      windowDays: 7,
      filters: { store: 'steam', tier: 'gold' },
      fetchImpl,
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon123',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/rest\/v1\/site_stats_daily\?/);
    expect(url).toMatch(/snapshot_date=gte\./);
    expect(url).toMatch(/snapshot_date=lte\./);
    expect(url).toMatch(/store=eq\.steam/);
    expect(url).toMatch(/tier=eq\.gold/);
    expect(url).toMatch(/order=snapshot_date\.asc/);
    expect(opts.headers.apikey).toBe('anon123');
  });

  test('returns rows on success', async () => {
    const rows = [{ snapshot_date: '2026-07-01', store: 'steam', tier: 'gold', hardware_bucket: 'rdna2', report_count: 5 }];
    const fetchImpl = fakeFetch(rows);
    const out = await fetchStatsHistory({
      windowDays: 30, fetchImpl,
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon',
    });
    expect(out).toEqual(rows);
  });

  test('returns [] and warns on non-2xx', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = fakeFetch({}, { status: 500 });
    const out = await fetchStatsHistory({
      windowDays: 30, fetchImpl,
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon',
    });
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('accepts explicit from/to Date objects', async () => {
    const fetchImpl = fakeFetch([]);
    await fetchStatsHistory({
      from: new Date(Date.UTC(2026, 5, 1)),
      to:   new Date(Date.UTC(2026, 5, 10)),
      fetchImpl,
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon',
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/snapshot_date=gte\.2026-06-01/);
    expect(url).toMatch(/snapshot_date=lte\.2026-06-10/);
  });

  test('returns [] and warns when Supabase URL is missing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fetchStatsHistory({ windowDays: 30, fetchImpl: () => {}, supabaseAnonKey: 'k' });
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
    warn.mockRestore();
  });
});
