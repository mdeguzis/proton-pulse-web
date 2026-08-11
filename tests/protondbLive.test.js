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

  test('non-Steam ids skip the proxy entirely (#404: it 400s on them)', async () => {
    const { mod, calls } = loadProtonDb(() => jsonResponse({ found: true, tier: 'gold' }));
    await expect(mod.fetchProtonDbLive('gog:1514133152')).resolves.toEqual([]);
    await expect(mod.fetchProtonDbLive('pgwiki:The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay')).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
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

// Decoupled from ProtonDB (#474): fetchCdn must return only pulse-sourced
// rows even when the CDN JSON still contains archive rows.
function loadProtonDbForCdn(fetchImpl) {
  const calls = [];
  const ctx = {
    console: { log() {}, debug() {}, error() {} },
    fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
    // Stub the two imports fetchCdn depends on; the ESM loader strips imports.
    dataUrl: async (p) => `https://cdn.example/${p}`,
    appIdToDir: (id) => String(id),
  };
  const mod = loadEsm(['js/app/api/protondb.js'], ctx);
  return { mod, calls };
}

describe('fetchCdn (#474 decouple)', () => {
  test('drops rows with source=protondb', async () => {
    const rows = [
      { rating: 'gold',     source: 'protondb', timestamp: 1 },
      { rating: 'platinum', source: 'pulse',    timestamp: 2 },
      { rating: 'silver',   source: 'pulse',    timestamp: 3 },
    ];
    const { mod } = loadProtonDbForCdn(() => jsonResponse(rows));
    const out = await mod.fetchCdn(730);
    expect(out).toHaveLength(2);
    expect(out.every(r => r.source === 'pulse')).toBe(true);
  });

  test('rows with missing/unknown source are dropped (legacy default is protondb)', async () => {
    const rows = [
      { rating: 'gold' },                          // no source -> archive default
      { rating: 'gold', source: '' },              // empty -> archive default
      { rating: 'gold', source: 'other-import' },  // unknown -> not pulse
      { rating: 'platinum', source: 'pulse' },
    ];
    const { mod } = loadProtonDbForCdn(() => jsonResponse(rows));
    const out = await mod.fetchCdn(730);
    expect(out).toHaveLength(1);
    expect(out[0].rating).toBe('platinum');
  });

  test('returns [] when CDN payload is not an array', async () => {
    const { mod } = loadProtonDbForCdn(() => jsonResponse({ oops: true }));
    const out = await mod.fetchCdn(730);
    expect(out).toEqual([]);
  });

  test('returns [] on non-ok CDN response', async () => {
    const { mod } = loadProtonDbForCdn(() => jsonResponse({}, false, 404));
    const out = await mod.fetchCdn(730);
    expect(out).toEqual([]);
  });
});

// Decoupled from ProtonDB (#474): readProtonDbLiveCache is a cache-only read
// used by the game page + confidence page so a cold render does not auto-fetch
// ProtonDB. Only warm cache (populated by a previous button click that ran
// fetchProtonDbLive) returns data.
describe('readProtonDbLiveCache (#474 decouple)', () => {
  test('returns [] on cold cache', () => {
    const { mod } = loadProtonDb(() => jsonResponse({}));
    expect(mod.readProtonDbLiveCache(730)).toEqual([]);
  });

  test('returns cached array after a fetchProtonDbLive call warms it', async () => {
    const { mod } = loadProtonDb(() => jsonResponse({ found: true, tier: 'gold', total: 42 }));
    await mod.fetchProtonDbLive(730);
    const out = mod.readProtonDbLiveCache(730);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'gold', total: 42, _liveOnly: true });
  });

  test('does not hit the network on read', () => {
    const { mod, calls } = loadProtonDb(() => jsonResponse({}));
    mod.readProtonDbLiveCache(999);
    mod.readProtonDbLiveCache(999);
    expect(calls).toHaveLength(0);
  });
});
