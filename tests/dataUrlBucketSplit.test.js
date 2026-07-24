/**
 * #380 regression guard: staging and prod read from separate R2 buckets +
 * separate manifests. staging.proton-pulse.com MUST NEVER fetch from the prod
 * data host, or it will show whatever prod happens to have during a
 * cross-env deploy. Same rule the other way: www.proton-pulse.com MUST NEVER
 * accidentally fetch from staging.
 *
 * The routing decision is baked into `_manifestUrl` in js/lib/data-url.js.
 * The per-game `data/` bucket routing is driven by data-config.json which
 * the pipeline writes per-env, so those cases are covered by
 * dataUrlTarget.test.js. This file covers the staging vs prod split of the
 * manifest URL.
 */

function loadWithHostname(hostname, responder) {
  jest.resetModules();
  // Simulate window.location.hostname via a jsdom-compat stub. jest 30 runs
  // node env by default (see jest.config.js), so we synthesize just enough
  // of window for the module to read hostname.
  global.window = { location: { hostname } };
  global.fetch = jest.fn((url) => {
    const body = responder(String(url));
    return Promise.resolve({
      ok: body !== null,
      json: () => Promise.resolve(body || {}),
    });
  });
  return require('../js/lib/data-url.js');
}

afterEach(() => {
  delete global.fetch;
  delete global.window;
});

describe('data-url manifest routing (#380)', () => {
  test('staging.proton-pulse.com reads its OWN manifest same-origin', async () => {
    let manifestUrl = null;
    loadWithHostname('staging.proton-pulse.com', (url) => {
      if (url.includes('data-versions.json')) { manifestUrl = url; return {}; }
      if (url.includes('data-config.json')) return {};
      return null;
    });
    const { dataUrl } = require('../js/lib/data-url.js');
    await dataUrl('search-index.json');
    // Same-origin fetch, NOT prod. If this fails, staging is silently pulling
    // prod data and every "test against staging" workflow lies.
    expect(manifestUrl).toBe('data-versions.json');
    expect(manifestUrl).not.toContain('www.proton-pulse.com');
  });

  test('www.proton-pulse.com reads its OWN manifest same-origin', async () => {
    let manifestUrl = null;
    loadWithHostname('www.proton-pulse.com', (url) => {
      if (url.includes('data-versions.json')) { manifestUrl = url; return {}; }
      if (url.includes('data-config.json')) return {};
      return null;
    });
    const { dataUrl } = require('../js/lib/data-url.js');
    await dataUrl('search-index.json');
    expect(manifestUrl).toBe('data-versions.json');
  });

  test('local dev falls back to prod manifest (no local data-versions.json)', async () => {
    let manifestUrl = null;
    loadWithHostname('localhost', (url) => {
      if (url.includes('data-versions.json')) { manifestUrl = url; return {}; }
      if (url.includes('data-config.json')) return {};
      return null;
    });
    const { dataUrl } = require('../js/lib/data-url.js');
    await dataUrl('search-index.json');
    expect(manifestUrl).toBe('https://www.proton-pulse.com/data-versions.json');
  });

  test('gh.io rollback path falls back to prod manifest', async () => {
    let manifestUrl = null;
    loadWithHostname('mdeguzis.github.io', (url) => {
      if (url.includes('data-versions.json')) { manifestUrl = url; return {}; }
      if (url.includes('data-config.json')) return {};
      return null;
    });
    const { dataUrl } = require('../js/lib/data-url.js');
    await dataUrl('search-index.json');
    // GH-Pages fallback is a rollback path only. Reading prod is safer than
    // reading nothing when the rollback bucket may or may not exist.
    expect(manifestUrl).toBe('https://www.proton-pulse.com/data-versions.json');
  });
});
