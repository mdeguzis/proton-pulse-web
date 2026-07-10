/**
 * Tests for js/admin/api/depotTracking.js.
 *
 * The reads and the pure summarizeApps aggregation are the interesting
 * bits; the render fn is a source-shape smoke test (kept minimal).
 */

// depotTracking imports SUPABASE_URL from js/admin/config.js. Stub that
// out before requiring the module.
jest.mock('../js/admin/config.js', () => ({
  SUPABASE_URL:      'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon',
}), { virtual: true });

const {
  fetchDepotFetchStatus,
  fetchDepotUpdatesForApps,
  fetchManifestHistoryForApps,
  fetchDepotTrackingDossier,
  summarizeApps,
} = require('../js/admin/api/depotTracking.js');

function stubFetchByUrl(routes) {
  return jest.fn(async (url) => {
    for (const [prefix, payload] of Object.entries(routes)) {
      if (url.includes(prefix)) {
        return {
          ok: true, status: 200,
          json: async () => (typeof payload === 'function' ? payload(url) : payload),
        };
      }
    }
    // Unknown URL -> HTTP 500 so it's obviously a test miss
    return { ok: false, status: 500, json: async () => ({}) };
  });
}

afterEach(() => { delete global.fetch; });

describe('summarizeApps (pure)', () => {
  const now = 1_700_000_000_000; // fixed reference so 24h/7d/30d math is deterministic
  const iso = (offsetDays) => new Date(now - offsetDays * 86400_000).toISOString();

  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(now); });
  afterEach(()  => Date.now.mockRestore?.());

  test('empty input yields all zeros', () => {
    expect(summarizeApps([])).toEqual({
      total: 0, ok: 0, noManifest: 0, error: 0,
      newest: null, updatedIn24h: 0, updatedIn7d: 0, updatedIn30d: 0,
    });
  });

  test('counts status buckets independently', () => {
    const s = summarizeApps([
      { app_status: 'ok', fetched_at: iso(1), history: null },
      { app_status: 'ok', fetched_at: iso(2), history: null },
      { app_status: 'no_public_manifest', fetched_at: iso(3), history: null },
      { app_status: 'error', fetched_at: iso(4), history: null },
    ]);
    expect(s.total).toBe(4);
    expect(s.ok).toBe(2);
    expect(s.noManifest).toBe(1);
    expect(s.error).toBe(1);
  });

  test('newest fetch is the max of fetched_at across the batch', () => {
    const s = summarizeApps([
      { app_status: 'ok', fetched_at: iso(3), history: null },
      { app_status: 'ok', fetched_at: iso(1), history: null },
      { app_status: 'ok', fetched_at: iso(5), history: null },
    ]);
    expect(s.newest).toBe(iso(1));
  });

  test('manifest-change windows count history observations by age', () => {
    const s = summarizeApps([
      { app_status: 'ok', fetched_at: iso(0), history: { newestFirstObserved: iso(0.5) } },  // in all three windows
      { app_status: 'ok', fetched_at: iso(0), history: { newestFirstObserved: iso(2)  } },   // 7d + 30d only
      { app_status: 'ok', fetched_at: iso(0), history: { newestFirstObserved: iso(10) } },   // 30d only
      { app_status: 'ok', fetched_at: iso(0), history: { newestFirstObserved: iso(45) } },   // none
      { app_status: 'ok', fetched_at: iso(0), history: null },                                // none (no history)
    ]);
    expect(s.updatedIn24h).toBe(1);
    expect(s.updatedIn7d).toBe(2);
    expect(s.updatedIn30d).toBe(3);
  });
});

describe('fetchDepotFetchStatus', () => {
  test('hits the correct REST URL and returns rows', async () => {
    global.fetch = stubFetchByUrl({
      '/rest/v1/steam_depot_fetch_status': [{ app_id: 1, app_status: 'ok', depot_count: 3, fetched_at: '2026-07-08', error: null }],
    });
    const rows = await fetchDepotFetchStatus();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0].app_id).toBe(1);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('steam_depot_fetch_status');
    expect(url).toContain('order=fetched_at.desc');
    expect(url).toContain('select=app_id,app_status,depot_count,fetched_at,error');
  });
});

describe('fetchDepotUpdatesForApps', () => {
  test('empty input short-circuits to {}', async () => {
    global.fetch = jest.fn();
    const out = await fetchDepotUpdatesForApps([]);
    expect(out).toEqual({});
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('groups rows by app_id', async () => {
    global.fetch = stubFetchByUrl({
      '/rest/v1/steam_depot_updates': [
        { app_id: 1, os: 'windows', depot_id: 11, manifest_id: 'a', last_updated_at: '2026-07-07T00:00:00Z', name: null },
        { app_id: 1, os: 'linux',   depot_id: 12, manifest_id: 'b', last_updated_at: '2026-07-07T00:00:00Z', name: null },
        { app_id: 2, os: 'windows', depot_id: 21, manifest_id: 'c', last_updated_at: '2026-07-07T00:00:00Z', name: null },
      ],
    });
    const out = await fetchDepotUpdatesForApps([1, 2]);
    expect(Object.keys(out).sort()).toEqual(['1', '2']);
    expect(out['1']).toHaveLength(2);
    expect(out['2']).toHaveLength(1);
  });

  test('chunks large lists into 100-app requests', async () => {
    global.fetch = stubFetchByUrl({ '/rest/v1/steam_depot_updates': [] });
    const ids = Array.from({ length: 205 }, (_, i) => i + 1);
    await fetchDepotUpdatesForApps(ids);
    // 205 ids / 100 per chunk = ceil(2.05) = 3 requests
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('fetchManifestHistoryForApps', () => {
  test('aggregates per-OS min / max first_observed_at + count', async () => {
    global.fetch = stubFetchByUrl({
      '/rest/v1/steam_depot_manifest_history': [
        { app_id: 1, os: 'linux',   first_observed_at: '2026-07-01T00:00:00Z', latest_observed_at: '2026-07-08T00:00:00Z' },
        { app_id: 1, os: 'linux',   first_observed_at: '2026-07-05T00:00:00Z', latest_observed_at: '2026-07-08T00:00:00Z' },
        { app_id: 1, os: 'windows', first_observed_at: '2026-07-03T00:00:00Z', latest_observed_at: '2026-07-08T00:00:00Z' },
      ],
    });
    const out = await fetchManifestHistoryForApps([1]);
    const one = out['1'];
    expect(one.manifestCount).toBe(3);
    expect(one.oldestFirstObserved).toBe('2026-07-01T00:00:00Z');
    expect(one.newestFirstObserved).toBe('2026-07-05T00:00:00Z');
    expect(one.perOs.linux.count).toBe(2);
    expect(one.perOs.linux.oldestFirstObserved).toBe('2026-07-01T00:00:00Z');
    expect(one.perOs.linux.newestFirstObserved).toBe('2026-07-05T00:00:00Z');
    expect(one.perOs.windows.count).toBe(1);
  });
});

describe('fetchDepotTrackingDossier', () => {
  test('joins the three reads into a per-app dossier + summary', async () => {
    global.fetch = stubFetchByUrl({
      '/rest/v1/steam_depot_fetch_status': [
        { app_id: 1, app_status: 'ok', depot_count: 2, fetched_at: '2026-07-08T00:00:00Z', error: null },
        { app_id: 2, app_status: 'error', depot_count: 0, fetched_at: '2026-07-07T00:00:00Z', error: 'boom' },
      ],
      '/rest/v1/steam_depot_updates': [
        { app_id: 1, os: 'linux', depot_id: 11, manifest_id: 'a', last_updated_at: '2026-07-07T00:00:00Z', name: null },
      ],
      '/rest/v1/steam_depot_manifest_history': [
        { app_id: 1, os: 'linux', first_observed_at: '2026-07-06T00:00:00Z', latest_observed_at: '2026-07-08T00:00:00Z' },
      ],
    });
    const dossier = await fetchDepotTrackingDossier();
    expect(dossier.apps).toHaveLength(2);
    // Order preserved from status query
    expect(dossier.apps[0].app_id).toBe(1);
    expect(dossier.apps[0].depots).toHaveLength(1);
    expect(dossier.apps[0].history.manifestCount).toBe(1);
    // App 2 has no depot / history rows but still appears
    expect(dossier.apps[1].app_id).toBe(2);
    expect(dossier.apps[1].depots).toEqual([]);
    expect(dossier.apps[1].history).toBeNull();
    // Aggregate reflects the two rows
    expect(dossier.aggregate.total).toBe(2);
    expect(dossier.aggregate.ok).toBe(1);
    expect(dossier.aggregate.error).toBe(1);
  });
});
