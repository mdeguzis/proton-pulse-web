/**
 * Tests for js/app/api/deck-status.js -> fetchLinuxNativeSupport.
 *
 * The new fn shares an appdetails cache with fetchMinRequirements so we
 * verify both readers hit Steam only once for the same appId. Uses a fake
 * global.fetch since jsdom doesn't have network access.
 */

// Loading the module resets the module-level cache each require() thanks
// to jest's module registry, so import fresh in every test to keep them
// hermetic.
function loadModule() {
  jest.resetModules();
  // _fetchAppBasic now routes through the steam-appdetails Supabase edge
  // function proxy (Steam blocks CORS from static origins). Tests stub
  // SUPABASE_URL so the fetch URL is well-formed; the fake fetch below
  // doesn't care what the URL is.
  global.window = global.window || {};
  global.window.SUPABASE_URL = 'https://test.supabase.co';
  return require('../js/app/api/deck-status.js');
}

function stubFetch(payload, { ok = true, status = 200 } = {}) {
  return jest.fn(async () => ({
    ok,
    status,
    json: async () => payload,
  }));
}

describe('fetchLinuxNativeSupport', () => {
  afterEach(() => { delete global.fetch; });

  test('returns true when appdetails.data.platforms.linux === true', async () => {
    global.fetch = stubFetch({
      '367520': { success: true, data: { platforms: { windows: true, mac: true, linux: true } } },
    });
    const { fetchLinuxNativeSupport } = loadModule();
    await expect(fetchLinuxNativeSupport('367520')).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('returns false when platforms.linux is false', async () => {
    global.fetch = stubFetch({
      '999': { success: true, data: { platforms: { windows: true, mac: false, linux: false } } },
    });
    const { fetchLinuxNativeSupport } = loadModule();
    await expect(fetchLinuxNativeSupport('999')).resolves.toBe(false);
  });

  test('returns false when platforms is missing (Steam has no data)', async () => {
    global.fetch = stubFetch({ '999': { success: true, data: {} } });
    const { fetchLinuxNativeSupport } = loadModule();
    await expect(fetchLinuxNativeSupport('999')).resolves.toBe(false);
  });

  test('returns false when data is missing (delisted, region-locked, etc.)', async () => {
    global.fetch = stubFetch({ '999': { success: false } });
    const { fetchLinuxNativeSupport } = loadModule();
    await expect(fetchLinuxNativeSupport('999')).resolves.toBe(false);
  });

  test('returns false on network/parsing error rather than throwing', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network down'); });
    const { fetchLinuxNativeSupport } = loadModule();
    await expect(fetchLinuxNativeSupport('999')).resolves.toBe(false);
  });

  test('returns false when appId is falsy without hitting the network', async () => {
    global.fetch = jest.fn();
    const { fetchLinuxNativeSupport } = loadModule();
    await expect(fetchLinuxNativeSupport('')).resolves.toBe(false);
    await expect(fetchLinuxNativeSupport(0)).resolves.toBe(false);
    await expect(fetchLinuxNativeSupport(null)).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sharing the appdetails cache: fetchMinRequirements + fetchLinuxNativeSupport hit Steam once', async () => {
    global.fetch = stubFetch({
      '367520': {
        success: true,
        data: {
          platforms: { windows: true, mac: true, linux: true },
          pc_requirements: { minimum: '<strong>Minimum:</strong> Linux 4.15', recommended: null },
        },
      },
    });
    const { fetchMinRequirements, fetchLinuxNativeSupport } = loadModule();
    const [reqs, hasLinux] = await Promise.all([
      fetchMinRequirements('367520'),
      fetchLinuxNativeSupport('367520'),
    ]);
    expect(hasLinux).toBe(true);
    expect(reqs?.minimum).toMatch(/Linux 4\.15/);
    // Both readers share the same underlying _fetchAppBasic + cache, so
    // Steam is queried at most once even though we asked for two things.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
