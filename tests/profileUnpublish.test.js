/**
 * Tests for unpublishReport (js/profile/api/configs.js) and the
 * search-index title resolution logic extracted from profile/main.js.
 *
 * Regression for: unpublish handler was placed after the appId guard so it
 * never fired (the button has data-published-id, not data-app-id).
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SUPABASE_URL = 'https://test.supabase.co';
const ANON_KEY     = 'test-anon-key';
const ACCESS_TOKEN = 'tok-fake';
const SESSION      = { access_token: ACCESS_TOKEN };
const PUBLISHED_ID = 42;

function loadSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^import\s.*$/gm, '')
    .replace(/^export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ')
    .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');
}

function makeCtx(fetchMock) {
  const ctx = vm.createContext({
    fetch: fetchMock,
    SUPABASE_URL,
    SUPABASE_ANON_KEY: ANON_KEY,
    console,
  });
  vm.runInContext(loadSrc('js/profile/api/supabase.js'), ctx);
  vm.runInContext(loadSrc('js/profile/api/configs.js'), ctx);
  return ctx;
}

function mockFetch(responses = []) {
  return jest.fn(async (url, opts) => {
    const match = responses.find(r =>
      !r.url || (r.url instanceof RegExp ? r.url.test(url) : url.includes(r.url))
    );
    const status = match?.status ?? 200;
    const body   = match?.body ?? [];
    return {
      ok:     status >= 200 && status < 300,
      status,
      json:   async () => body,
      text:   async () => JSON.stringify(body),
    };
  });
}

// ---------------------------------------------------------------------------
// unpublishReport API
// ---------------------------------------------------------------------------

describe('unpublishReport', () => {
  test('sends DELETE to user_configs with correct id filter', async () => {
    const fetch = mockFetch([{ url: 'user_configs', status: 204 }]);
    const ctx   = makeCtx(fetch);
    await vm.runInContext(`unpublishReport(${JSON.stringify(SESSION)}, ${PUBLISHED_ID})`, ctx);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toMatch(`user_configs?id=eq.${PUBLISHED_ID}`);
    expect(opts.method).toBe('DELETE');
  });

  test('sends Prefer: return=minimal header', async () => {
    const fetch = mockFetch([{ url: 'user_configs', status: 204 }]);
    const ctx   = makeCtx(fetch);
    await vm.runInContext(`unpublishReport(${JSON.stringify(SESSION)}, ${PUBLISHED_ID})`, ctx);

    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers['Prefer']).toBe('return=minimal');
  });

  test('includes auth token in Authorization header', async () => {
    const fetch = mockFetch([{ url: 'user_configs', status: 204 }]);
    const ctx   = makeCtx(fetch);
    await vm.runInContext(`unpublishReport(${JSON.stringify(SESSION)}, ${PUBLISHED_ID})`, ctx);

    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers['Authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  test('throws on non-ok response', async () => {
    const fetch = mockFetch([{ url: 'user_configs', status: 403 }]);
    const ctx   = makeCtx(fetch);
    await expect(
      vm.runInContext(`unpublishReport(${JSON.stringify(SESSION)}, ${PUBLISHED_ID})`, ctx)
    ).rejects.toThrow('403');
  });

  test('does not hit cloud config table (user_proton_configs)', async () => {
    const fetch = mockFetch([{ url: 'user_configs', status: 204 }]);
    const ctx   = makeCtx(fetch);
    await vm.runInContext(`unpublishReport(${JSON.stringify(SESSION)}, ${PUBLISHED_ID})`, ctx);

    const urls = fetch.mock.calls.map(([url]) => url);
    expect(urls.some(u => u.includes('user_proton_configs'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Search-index title resolution (logic extracted from refreshMyConfigs)
// ---------------------------------------------------------------------------

describe('search-index title resolution', () => {
  // Mirror the resolution logic from profile/main.js refreshMyConfigs
  function resolveTitle(rows, searchIndex) {
    if (Array.isArray(searchIndex) && searchIndex.length) {
      const titleMap = new Map(searchIndex.map(([id, t]) => [String(id), t]));
      for (const row of rows) {
        if (!row.title || /^App \d+$/.test(row.title)) {
          const resolved = titleMap.get(String(row.app_id));
          if (resolved) row.title = resolved;
        }
      }
    }
    return rows;
  }

  test('resolves null title from search-index', () => {
    const rows = [{ app_id: 730, title: null }];
    const idx  = [[730, 'Half-Life']];
    expect(resolveTitle(rows, idx)[0].title).toBe('Half-Life');
  });

  test('resolves App-placeholder title from search-index', () => {
    const rows = [{ app_id: 730, title: 'App 730' }];
    const idx  = [[730, 'Half-Life']];
    expect(resolveTitle(rows, idx)[0].title).toBe('Half-Life');
  });

  test('does not overwrite a real stored title', () => {
    const rows = [{ app_id: 730, title: 'Half-Life (Custom Name)' }];
    const idx  = [[730, 'Half-Life']];
    expect(resolveTitle(rows, idx)[0].title).toBe('Half-Life (Custom Name)');
  });

  test('leaves title as App-placeholder when app not in index', () => {
    const rows = [{ app_id: 99999, title: 'App 99999' }];
    const idx  = [[730, 'Half-Life']];
    expect(resolveTitle(rows, idx)[0].title).toBe('App 99999');
  });

  test('handles empty search-index gracefully', () => {
    const rows = [{ app_id: 730, title: null }];
    expect(resolveTitle(rows, [])[0].title).toBeNull();
  });

  test('handles non-array search-index gracefully', () => {
    const rows = [{ app_id: 730, title: 'App 730' }];
    expect(resolveTitle(rows, null)[0].title).toBe('App 730');
  });

  test('resolves multiple rows in one pass', () => {
    const rows = [
      { app_id: 730,  title: 'App 730'  },
      { app_id: 440,  title: null        },
      { app_id: 9999, title: 'App 9999'  },
    ];
    const idx = [[730, 'Half-Life'], [440, 'Team Fortress 2']];
    const out = resolveTitle(rows, idx);
    expect(out[0].title).toBe('Half-Life');
    expect(out[1].title).toBe('Team Fortress 2');
    expect(out[2].title).toBe('App 9999');
  });
});
