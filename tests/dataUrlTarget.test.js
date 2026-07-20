/**
 * dataUrl() deploy-target routing (#362). Per-game data/ buckets can live on a
 * separate host (R2) on Cloudflare deploys, driven by data-config.json's
 * dataBase. On GitHub Pages there is no dataBase and everything stays
 * same-origin. This pins that switch so the dual-target/rollback property holds.
 */

// The module memoizes the manifest + config fetches, so reset modules between
// cases to get a clean cache and a fresh fetch mock.
function loadWithFetch(responder) {
  jest.resetModules();
  global.fetch = jest.fn((url) => {
    const body = responder(String(url));
    return Promise.resolve({
      ok: body !== null,
      json: () => Promise.resolve(body || {}),
    });
  });
  return require('../js/lib/data-url.js');
}

afterEach(() => { delete global.fetch; });

describe('dataUrl deploy-target routing', () => {
  test('Cloudflare target: data/ paths reroute to the R2 dataBase', async () => {
    const { dataUrl } = loadWithFetch((url) => {
      if (url.includes('data-config.json')) return { dataBase: 'https://data.proton-pulse.com' };
      if (url.includes('data-versions.json')) return {};
      return null;
    });
    expect(await dataUrl('data/277430/latest.json')).toBe('https://data.proton-pulse.com/data/277430/latest.json');
  });

  test('Cloudflare target: small top-level files stay same-origin', async () => {
    const { dataUrl } = loadWithFetch((url) => {
      if (url.includes('data-config.json')) return { dataBase: 'https://data.proton-pulse.com' };
      if (url.includes('data-versions.json')) return { 'search-index.json': 'abc12345' };
      return null;
    });
    // Not a data/ path, so it stays relative (with its cache-bust hash).
    expect(await dataUrl('search-index.json')).toBe('search-index.json?v=abc12345');
  });

  test('GitHub Pages target: no dataBase, data/ stays same-origin', async () => {
    const { dataUrl } = loadWithFetch((url) => {
      if (url.includes('data-config.json')) return {}; // no dataBase
      if (url.includes('data-versions.json')) return {};
      return null;
    });
    expect(await dataUrl('data/277430/latest.json')).toBe('data/277430/latest.json');
  });

  test('trailing slash on dataBase is normalized', async () => {
    const { dataUrl } = loadWithFetch((url) => {
      if (url.includes('data-config.json')) return { dataBase: 'https://data.proton-pulse.com/' };
      if (url.includes('data-versions.json')) return {};
      return null;
    });
    expect(await dataUrl('data/1/latest.json')).toBe('https://data.proton-pulse.com/data/1/latest.json');
  });

  test('missing data-config.json (fetch fails) degrades to same-origin', async () => {
    jest.resetModules();
    global.fetch = jest.fn((url) => {
      if (String(url).includes('data-config.json')) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    const { dataUrl } = require('../js/lib/data-url.js');
    expect(await dataUrl('data/9/latest.json')).toBe('data/9/latest.json');
  });
});
