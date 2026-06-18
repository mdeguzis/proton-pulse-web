const { loadEsm } = require('./_esm-vm.js');

// Build a fresh protondb.js module context with a stubbed fetch + console.
function loadProtonDb(fetchImpl) {
  const calls = [];
  const ctx = {
    CDN: 'https://cdn.example/test',
    console: { log() {}, debug() {}, error() {} },
    fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
  };
  const mod = loadEsm(['js/app/api/protondb.js'], ctx);
  return { mod, calls };
}

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

describe('fetchProtonDbLive (proxy)', () => {
  test('calls the protondb-summary edge function with the appId', async () => {
    const { mod, calls } = loadProtonDb(() => jsonResponse({ found: true, tier: 'gold', total: 1945 }));
    await mod.fetchProtonDbLive(730);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/functions/v1/protondb-summary?appId=730');
  });

  test('returns a normalized result when the proxy reports found', async () => {
    const { mod } = loadProtonDb(() => jsonResponse({ found: true, tier: 'gold', total: 1945, trendingTier: 'gold', score: 0.71 }));
    const out = await mod.fetchProtonDbLive(730);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ appId: 730, tier: 'gold', total: 1945, source: 'protondb-live', _liveOnly: true });
  });

  test('returns empty array when ProtonDB has no summary (found:false)', async () => {
    const { mod } = loadProtonDb(() => jsonResponse({ appId: '1', found: false }));
    const out = await mod.fetchProtonDbLive(1);
    expect(out).toEqual([]);
  });

  test('returns empty array on a non-ok proxy response', async () => {
    const { mod } = loadProtonDb(() => jsonResponse({ error: 'bad' }, false, 502));
    const out = await mod.fetchProtonDbLive(999);
    expect(out).toEqual([]);
  });

  test('caches the result so a second call does not refetch', async () => {
    const { mod, calls } = loadProtonDb(() => jsonResponse({ found: true, tier: 'platinum', total: 10 }));
    await mod.fetchProtonDbLive(42);
    await mod.fetchProtonDbLive(42);
    expect(calls).toHaveLength(1);
  });
});
