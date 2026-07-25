/**
 * Behavioral tests for js/app/api/deck-status.js -- the fetch/caching paths
 * that the source-shape tests in deckStatus.test.js cannot exercise.
 * Same fake-fetch pattern as linuxNativeSupport.test.js.
 */

function loadModule() {
  jest.resetModules();
  global.window = global.window || {};
  global.window.SUPABASE_URL = 'https://test.supabase.co';
  return require('../js/app/api/deck-status.js');
}

function stubFetch(payload, { ok = true, status = 200 } = {}) {
  return jest.fn(async () => ({ ok, status, json: async () => payload }));
}

afterEach(() => { delete global.fetch; });

describe('fetchDeckStatusForApp / loadDeckStatusMap', () => {
  test('resolves a status entry from deck-status.json and caches per app', async () => {
    global.fetch = stubFetch({
      '730': { status: 'verified', criteria: [true, true, true, true], machine: 'verified', steamos: 'verified' },
    });
    const mod = loadModule();
    const first = await mod.fetchDeckStatusForApp('730');
    expect(first.status).toBe('verified');
    expect(first.criteria).toEqual([true, true, true, true]);
    const again = await mod.fetchDeckStatusForApp('730');
    expect(again).toBe(first);            // _deckCache hit
    // Map fetch happens once; dataUrl() may fetch data-config/versions
    // manifests too, so pin the deck-status fetch count, not the total.
    const deckFetches = global.fetch.mock.calls.filter(c => String(c[0]).includes('deck-status.json'));
    expect(deckFetches.length).toBe(1);
  });

  test('unknown app resolves to unknown status with null criteria', async () => {
    global.fetch = stubFetch({});
    const mod = loadModule();
    await expect(mod.fetchDeckStatusForApp('999999')).resolves.toMatchObject({ status: 'unknown', criteria: null });
  });

  test('missing appId short-circuits without network', async () => {
    global.fetch = stubFetch({});
    const mod = loadModule();
    await expect(mod.fetchDeckStatusForApp('')).resolves.toMatchObject({ status: 'unknown' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('map fetch failure degrades to empty map, not a throw', async () => {
    global.fetch = jest.fn(async () => { throw new Error('offline'); });
    const mod = loadModule();
    await expect(mod.fetchDeckStatusForApp('730')).resolves.toMatchObject({ status: 'unknown' });
    const map = await mod.loadDeckStatusMap();
    expect(map).toEqual({});
  });

  test('non-ok response degrades to empty map', async () => {
    global.fetch = stubFetch(null, { ok: false, status: 500 });
    const mod = loadModule();
    const map = await mod.loadDeckStatusMap();
    expect(map).toEqual({});
  });

  test('getDeckStatusForApp is the sync cache reader with an unknown default', async () => {
    global.fetch = stubFetch({ '730': { status: 'playable' } });
    const mod = loadModule();
    expect(mod.getDeckStatusForApp('730')).toMatchObject({ status: 'unknown' }); // not fetched yet
    await mod.fetchDeckStatusForApp('730');
    expect(mod.getDeckStatusForApp('730')).toMatchObject({ status: 'playable' });
  });
});

describe('fetchMinRequirements', () => {
  test('parses pc_requirements minimum HTML into text', async () => {
    global.fetch = stubFetch({
      '730': { success: true, data: { pc_requirements: { minimum: '<strong>Minimum:</strong><ul><li>OS: Windows 10</li></ul>' } } },
    });
    const mod = loadModule();
    const r = await mod.fetchMinRequirements('730');
    expect(r).toBeTruthy();
    expect(JSON.stringify(r)).toContain('Windows 10');
  });

  test('appdetails success=false yields null', async () => {
    global.fetch = stubFetch({ '730': { success: false } });
    const mod = loadModule();
    await expect(mod.fetchMinRequirements('730')).resolves.toBeNull();
  });
});

describe('fetchAppMetadata', () => {
  const FULL = {
    '440': {
      success: true,
      data: {
        name: 'Team Fortress 2', type: 'game', required_age: 0, is_free: true,
        dlc: [1, 2, 3], developers: ['Valve'], publishers: ['Valve'],
        platforms: { windows: true, mac: true, linux: true },
        release_date: { date: '10 Oct, 2007', coming_soon: false },
        genres: [{ description: 'Action' }], categories: [{ description: 'Multi-player' }],
        metacritic: { score: 92, url: 'https://mc.example/tf2' },
        reviews: '<b>Overwhelmingly Positive</b> on   Steam',
        controller_support: 'full',
        supported_languages: 'English<strong>*</strong>, French',
        achievements: { total: 520 },
        packages: [123], package_groups: [{ name: 'default', title: 'Buy TF2', subs: [{}] }],
      },
    },
  };

  test('maps the appdetails payload into the dossier shape', async () => {
    global.fetch = stubFetch(FULL);
    const mod = loadModule();
    const m = await mod.fetchAppMetadata('440');
    expect(m).toMatchObject({
      appId: '440', name: 'Team Fortress 2', isFree: true, dlcCount: 3,
      developers: ['Valve'], metacriticScore: 92, controllerSupport: 'full',
      hasAchievements: true, achievementCount: 520,
      genres: ['Action'], categories: ['Multi-player'],
    });
    // HTML stripped + whitespace collapsed
    expect(m.reviewsSummary).toBe('Overwhelmingly Positive on Steam');
    expect(m.supportedLanguages).toBe('English*, French');
    expect(m.packageGroups[0]).toMatchObject({ name: 'default', subCount: 1 });
  });

  test('null for a failed appdetails lookup', async () => {
    global.fetch = stubFetch({ '440': { success: false } });
    const mod = loadModule();
    await expect(mod.fetchAppMetadata('440')).resolves.toBeNull();
  });

  test('degrades field-by-field on a sparse payload', async () => {
    global.fetch = stubFetch({ '440': { success: true, data: { name: 'Sparse' } } });
    const mod = loadModule();
    const m = await mod.fetchAppMetadata('440');
    expect(m).toMatchObject({
      name: 'Sparse', type: null, dlcCount: 0, developers: [],
      metacriticScore: null, reviewsSummary: null, hasAchievements: false,
    });
  });
});
