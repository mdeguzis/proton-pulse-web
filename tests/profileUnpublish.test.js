/**
 * Tests for unpublishReport (js/profile/api/configs.js), search-index title
 * resolution, and profile action button rendering logic.
 *
 * Regression for: unpublish handler was placed after the appId guard so it
 * never fired (the button has data-published-id, not data-app-id).
 *
 * Regression for: cloud-only Edit button was a link to submit.html (fromCloud=1)
 * which opened the full publish form with no visible Save button -- should
 * instead be a button with data-cloud-app-id that opens the lightweight modal.
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

// ---------------------------------------------------------------------------
// Action button rendering -- cloud-only Edit must NOT link to submit.html
// ---------------------------------------------------------------------------

describe('profile action button rendering', () => {
  // Mirror the action button logic from profile/main.js renderMyConfigs
  function makeActions(row, esc = s => String(s)) {
    const actions = [
      row.cloud && row.unpublished
        ? `<a class="profile-configs-action profile-configs-publish-btn" href="submit.html?app=${esc(String(row.app_id))}&fromCloud=1">Publish</a>`
        : '',
      row.published_id
        ? `<a class="profile-configs-action profile-configs-edit-btn" href="submit.html?app=${esc(String(row.app_id))}&edit=${esc(String(row.published_id))}">Edit</a>`
        : row.cloud
          ? `<button type="button" class="profile-configs-action profile-configs-edit-btn" data-cloud-app-id="${esc(String(row.app_id))}">Edit</button>`
          : '',
      row.published_id
        ? `<button type="button" class="profile-configs-action profile-configs-unpublish-btn" data-published-id="${esc(String(row.published_id))}">Unpublish</button>`
        : '',
      `<button type="button" class="profile-configs-action profile-configs-delete-btn" data-app-id="${esc(String(row.app_id))}">Delete</button>`,
    ].filter(Boolean).join('');
    return actions;
  }

  test('cloud-only edit is a button with data-cloud-app-id, not a link to submit.html', () => {
    const row = { app_id: 2358720, cloud: true, unpublished: true, published_id: null };
    const html = makeActions(row);
    expect(html).toContain('data-cloud-app-id="2358720"');
    // The Edit element specifically must be a button, not an anchor to submit.html
    expect(html).not.toMatch(/profile-configs-edit-btn[^>]*href=.*submit\.html/);
    expect(html).toContain('<button');
  });

  test('cloud-only edit button has profile-configs-edit-btn class', () => {
    const row = { app_id: 2358720, cloud: true, unpublished: true, published_id: null };
    const html = makeActions(row);
    expect(html).toMatch(/class="[^"]*profile-configs-edit-btn[^"]*"/);
  });

  test('published edit is an anchor to submit.html with edit param', () => {
    const row = { app_id: 730, cloud: false, unpublished: false, published_id: 99 };
    const html = makeActions(row);
    expect(html).toContain('submit.html?app=730&edit=99');
    expect(html).toContain('<a ');
  });

  test('published row shows Unpublish button with data-published-id', () => {
    const row = { app_id: 730, cloud: false, unpublished: false, published_id: 99 };
    const html = makeActions(row);
    expect(html).toContain('data-published-id="99"');
    expect(html).toContain('profile-configs-unpublish-btn');
  });

  test('cloud-only row shows Publish link to submit.html fromCloud', () => {
    const row = { app_id: 2358720, cloud: true, unpublished: true, published_id: null };
    const html = makeActions(row);
    expect(html).toContain('submit.html?app=2358720&fromCloud=1');
    expect(html).toContain('profile-configs-publish-btn');
  });

  test('cloud-only row does not show Unpublish button', () => {
    const row = { app_id: 2358720, cloud: true, unpublished: true, published_id: null };
    const html = makeActions(row);
    expect(html).not.toContain('profile-configs-unpublish-btn');
  });
});
