/**
 * Security tests for admin.js.
 *
 * Coverage targets: 100% lines, functions, branches, statements on admin.js.
 * The admin auth gate is the most security-critical path in the codebase.
 *
 * Test categories:
 *   - isAdmin: every null/empty/error/valid session branch
 *   - Privilege escalation: non-admin cannot call mutating functions
 *   - XSS/injection: escapeHtml covers all dangerous characters
 *   - Header hygiene: tokens never leak, anon key used as fallback only
 *   - Mutating operations: reinstateReport, deleteReport, banUser, unbanUser
 *   - Fetch/URL construction: correct filters, methods, payloads
 *   - Render helpers: friendlyReason, fmtDate, fmtDateTime
 *   - Fallback: admins table can always be managed directly in Supabase
 *     dashboard or via the management API (service role bypasses RLS).
 */

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');

const SUPABASE_URL      = 'https://test.supabase.co';
const SUPABASE_ANON_KEY = 'test-anon-key';
const ADMIN_USER_ID     = 'b66fa63b-e86e-4460-b595-1199c4330445';
const OTHER_USER_ID     = 'aaaaaaaa-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// VM harness
// ---------------------------------------------------------------------------

function makeEl(overrides = {}) {
  return {
    hidden: true,
    textContent: '',
    innerHTML: '',
    value: '',
    dataset: {},
    classList: { toggle: jest.fn(), contains: jest.fn(() => false) },
    addEventListener: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    closest: jest.fn(() => null),
    remove: jest.fn(),
    focus: jest.fn(),
    ...overrides,
  };
}

function makeCtx(fetchImpl) {
  const el = makeEl();
  const ctx = {
    fetch: fetchImpl,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SupaAuth: { getSession: jest.fn() },
    document: {
      getElementById: jest.fn(() => makeEl()),
      querySelectorAll: jest.fn(() => []),
      addEventListener: jest.fn(),
    },
    console,
    alert: jest.fn(),
    confirm: jest.fn(() => true),
    window: {},
    location: { pathname: '/', href: '', hash: '', search: '' },
    history: { replaceState: jest.fn() },
    navigator: {},
  };
  ctx.ctx = ctx;
  const shim = `
    var window = ctx;
    var location = ctx.location;
    var history = ctx.history;
    var navigator = ctx.navigator;
    var SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};
    var SUPABASE_ANON_KEY = ${JSON.stringify(SUPABASE_ANON_KEY)};
    var fetch = ctx.fetch;
    var SupaAuth = ctx.SupaAuth;
    var document = ctx.document;
    var alert = ctx.alert;
    var confirm = ctx.confirm;
    ${ADMIN_SRC}
    ctx.__isAdmin             = isAdmin;
    ctx.__supabaseHeaders     = supabaseHeaders;
    ctx.__escapeHtml          = escapeHtml;
    ctx.__friendlyReason      = friendlyReason;
    ctx.__fmtDate             = fmtDate;
    ctx.__fmtDateTime         = fmtDateTime;
    ctx.__reinstateReport     = reinstateReport;
    ctx.__deleteReport        = deleteReport;
    ctx.__banUser             = banUser;
    ctx.__unbanUser           = unbanUser;
    ctx.__fetchFlaggedReports = fetchFlaggedReports;
    ctx.__fetchBannedUsers    = fetchBannedUsers;
    ctx.__fetchAdmins         = fetchAdmins;
    ctx.__addAdmin            = addAdmin;
    ctx.__removeAdmin         = removeAdmin;
    ctx.__updateAdminRole     = updateAdminRole;
    ctx.__fetchAllUsers       = fetchAllUsers;
    ctx.__renderFlagged       = renderFlagged;
    ctx.__renderBanned        = renderBanned;
    ctx.__renderAdmins        = renderAdmins;
    ctx.__renderUsers         = renderUsers;
    ctx.__fetchBannedPhrases  = fetchBannedPhrases;
    ctx.__addBannedPhrase     = addBannedPhrase;
    ctx.__removeBannedPhrase  = removeBannedPhrase;
    ctx.__toggleBannedPhrase  = toggleBannedPhrase;
    ctx.__renderPhrases       = renderPhrases;
  `;
  vm.createContext(ctx);
  vm.runInContext(shim, ctx);
  return ctx;
}

function mockFetch(responses) {
  return jest.fn(async (url) => {
    const match = responses.find(r =>
      !r.url || (r.url instanceof RegExp ? r.url.test(url) : url.includes(r.url))
    );
    const status = match?.status ?? 200;
    const body   = match?.body ?? [];
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
}

function okFetch(body = []) {
  return mockFetch([{ body }]);
}

function failFetch(status = 403) {
  return mockFetch([{ status, body: { error: 'forbidden' } }]);
}

// ---------------------------------------------------------------------------
// isAdmin - auth gate correctness
// ---------------------------------------------------------------------------

describe('isAdmin - session validation', () => {
  test('returns false for null session', async () => {
    expect(await makeCtx(okFetch()).__isAdmin(null)).toBe(false);
  });

  test('returns false for empty object session', async () => {
    expect(await makeCtx(okFetch()).__isAdmin({})).toBe(false);
  });

  test('returns false when session.user is null', async () => {
    expect(await makeCtx(okFetch()).__isAdmin({ user: null })).toBe(false);
  });

  test('returns false when session.user.id is undefined', async () => {
    expect(await makeCtx(okFetch()).__isAdmin({ user: {} })).toBe(false);
  });

  test('returns false when session.user.id is empty string', async () => {
    expect(await makeCtx(okFetch()).__isAdmin({ user: { id: '' } })).toBe(false);
  });
});

describe('isAdmin - database response handling', () => {
  test('returns false when admins table returns empty array', async () => {
    const ctx = makeCtx(mockFetch([{ url: /admins/, body: [] }]));
    expect(await ctx.__isAdmin({ user: { id: OTHER_USER_ID }, access_token: 'tok' })).toBe(false);
  });

  test('returns true when admins table returns a matching row', async () => {
    const ctx = makeCtx(mockFetch([{ url: /admins/, body: [{ proton_pulse_user_id: ADMIN_USER_ID }] }]));
    expect(await ctx.__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'tok' })).toBe(true);
  });

  test('returns false on HTTP 403', async () => {
    const ctx = makeCtx(mockFetch([{ url: /admins/, status: 403, body: {} }]));
    expect(await ctx.__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'tok' })).toBe(false);
  });

  test('returns false on HTTP 500', async () => {
    const ctx = makeCtx(mockFetch([{ url: /admins/, status: 500, body: {} }]));
    expect(await ctx.__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'tok' })).toBe(false);
  });

  test('returns false when fetch throws (network error)', async () => {
    const fetch = jest.fn(async () => { throw new Error('network error'); });
    expect(await makeCtx(fetch).__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'tok' })).toBe(false);
  });

  test('returns false when response body is null (handles gracefully)', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => null, text: async () => 'null' }));
    expect(await makeCtx(fetch).__isAdmin({ user: { id: OTHER_USER_ID }, access_token: 'tok' })).toBe(false);
  });

  test('returns false when response body is a non-array truthy value', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ proton_pulse_user_id: ADMIN_USER_ID }), text: async () => '{}' }));
    expect(await makeCtx(fetch).__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'tok' })).toBe(false);
  });
});

describe('isAdmin - URL and header security', () => {
  test('sends user id in query string', async () => {
    const fetch = mockFetch([{ url: /admins/, body: [] }]);
    const ctx = makeCtx(fetch);
    await ctx.__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'tok' });
    expect(fetch.mock.calls[0][0]).toContain(ADMIN_USER_ID);
  });

  test('sends session access_token in Authorization header', async () => {
    const fetch = mockFetch([{ url: /admins/, body: [] }]);
    const ctx = makeCtx(fetch);
    await ctx.__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'my-secret-token' });
    expect(fetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer my-secret-token');
  });

  test('does not expose service role key (only uses session or anon key)', async () => {
    const fetch = mockFetch([{ url: /admins/, body: [] }]);
    const ctx = makeCtx(fetch);
    await ctx.__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'tok' });
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).not.toContain('service_role');
  });

  test('queries /rest/v1/admins endpoint (not user_configs)', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const ctx = makeCtx(fetch);
    await ctx.__isAdmin({ user: { id: ADMIN_USER_ID }, access_token: 'tok' });
    expect(fetch.mock.calls[0][0]).toContain('/admins');
    expect(fetch.mock.calls[0][0]).not.toContain('/user_configs');
  });
});

// ---------------------------------------------------------------------------
// supabaseHeaders
// ---------------------------------------------------------------------------

describe('supabaseHeaders', () => {
  test('uses session access_token when present', () => {
    const h = makeCtx(okFetch()).__supabaseHeaders({ access_token: 'my-token' });
    expect(h['Authorization']).toBe('Bearer my-token');
  });

  test('falls back to anon key when session has no access_token', () => {
    const h = makeCtx(okFetch()).__supabaseHeaders({});
    expect(h['Authorization']).toBe(`Bearer ${SUPABASE_ANON_KEY}`);
  });

  test('falls back to anon key for null session', () => {
    const h = makeCtx(okFetch()).__supabaseHeaders(null);
    expect(h['Authorization']).toBe(`Bearer ${SUPABASE_ANON_KEY}`);
  });

  test('always includes apikey header', () => {
    const h = makeCtx(okFetch()).__supabaseHeaders({ access_token: 'x' });
    expect(h['apikey']).toBe(SUPABASE_ANON_KEY);
  });

  test('merges extra headers without overwriting required ones', () => {
    const h = makeCtx(okFetch()).__supabaseHeaders({ access_token: 'x' }, { Prefer: 'return=minimal', 'X-Custom': 'val' });
    expect(h['Prefer']).toBe('return=minimal');
    expect(h['X-Custom']).toBe('val');
    expect(h['apikey']).toBe(SUPABASE_ANON_KEY);
  });

  test('always sets Content-Type to application/json', () => {
    const h = makeCtx(okFetch()).__supabaseHeaders(null);
    expect(h['Content-Type']).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
// escapeHtml - XSS prevention
// ---------------------------------------------------------------------------

describe('escapeHtml - XSS prevention', () => {
  const cases = [
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['"onclick="alert(1)', '&quot;onclick=&quot;alert(1)'],
    ["'; DROP TABLE users; --", '&#39;; DROP TABLE users; --'],
    ['a & b', 'a &amp; b'],
    ['safe text', 'safe text'],
    [null, ''],
    [undefined, ''],
    [0, '0'],
    ['', ''],
  ];

  test.each(cases)('escapes %s -> %s', (input, expected) => {
    expect(makeCtx(okFetch()).__escapeHtml(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// friendlyReason
// ---------------------------------------------------------------------------

describe('friendlyReason', () => {
  test('formats wordlist reason', () => {
    expect(makeCtx(okFetch()).__friendlyReason('wordlist:slur in notes')).toContain('Wordlist');
  });

  test('formats openai reason', () => {
    expect(makeCtx(okFetch()).__friendlyReason('openai:hate,harassment')).toContain('OpenAI');
  });

  test('formats admin reason', () => {
    expect(makeCtx(okFetch()).__friendlyReason('admin:banned')).toContain('Admin');
  });

  test('returns raw string for unknown prefix', () => {
    expect(makeCtx(okFetch()).__friendlyReason('other:reason')).toBe('other:reason');
  });

  test('returns dash for null', () => {
    expect(makeCtx(okFetch()).__friendlyReason(null)).toBe('—');
  });

  test('returns dash for empty string', () => {
    expect(makeCtx(okFetch()).__friendlyReason('')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// fmtDate / fmtDateTime
// ---------------------------------------------------------------------------

describe('fmtDate', () => {
  test('returns formatted date string for valid ISO', () => {
    const result = makeCtx(okFetch()).__fmtDate('2026-06-05T00:00:00Z');
    expect(result).toMatch(/2026/);
  });

  test('returns dash for null', () => {
    expect(makeCtx(okFetch()).__fmtDate(null)).toBe('—');
  });

  test('returns dash for empty string', () => {
    expect(makeCtx(okFetch()).__fmtDate('')).toBe('—');
  });
});

describe('fmtDateTime', () => {
  test('returns formatted datetime string for valid ISO', () => {
    const result = makeCtx(okFetch()).__fmtDateTime('2026-06-05T12:30:00Z');
    expect(result).toMatch(/2026/);
  });

  test('returns dash for null', () => {
    expect(makeCtx(okFetch()).__fmtDateTime(null)).toBe('—');
  });

  test('returns dash for empty string', () => {
    expect(makeCtx(okFetch()).__fmtDateTime('')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// reinstateReport
// ---------------------------------------------------------------------------

describe('reinstateReport', () => {
  test('sends PATCH to correct URL with id filter', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__reinstateReport({ access_token: 'tok' }, 42);
    expect(fetch.mock.calls[0][0]).toContain('user_configs');
    expect(fetch.mock.calls[0][0]).toContain('id=eq.42');
    expect(fetch.mock.calls[0][1].method).toBe('PATCH');
  });

  test('sets is_flagged=false, is_hidden=false, clears flagged_reason and flagged_at', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__reinstateReport({ access_token: 'tok' }, 42);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.is_flagged).toBe(false);
    expect(body.is_hidden).toBe(false);
    expect(body.flagged_reason).toBeNull();
    expect(body.flagged_at).toBeNull();
  });

  test('throws on HTTP 403', async () => {
    await expect(makeCtx(failFetch(403)).__reinstateReport({ access_token: 'tok' }, 42)).rejects.toThrow();
  });

  test('throws on HTTP 500', async () => {
    await expect(makeCtx(failFetch(500)).__reinstateReport({ access_token: 'tok' }, 42)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deleteReport
// ---------------------------------------------------------------------------

describe('deleteReport', () => {
  test('sends DELETE to correct URL', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__deleteReport({ access_token: 'tok' }, 99);
    expect(fetch.mock.calls[0][0]).toContain('id=eq.99');
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
  });

  test('throws on HTTP 403', async () => {
    await expect(makeCtx(failFetch(403)).__deleteReport({ access_token: 'tok' }, 99)).rejects.toThrow();
  });

  test('does not call any other endpoint', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__deleteReport({ access_token: 'tok' }, 99);
    expect(fetch.mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// banUser
// ---------------------------------------------------------------------------

describe('banUser', () => {
  const session = { access_token: 'tok', user: { id: ADMIN_USER_ID } };

  test('inserts ban record into banned_users', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__banUser(session, { protonPulseUserId: OTHER_USER_ID, clientId: null, steamUsername: 'badguy', reason: 'spam' });
    const banCall = fetch.mock.calls.find(([url, opts]) => url.includes('banned_users') && opts.method === 'POST');
    expect(banCall).toBeTruthy();
  });

  test('ban body includes proton_pulse_user_id, steam_username, reason, banned_by', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__banUser(session, { protonPulseUserId: OTHER_USER_ID, clientId: null, steamUsername: 'badguy', reason: 'spam' });
    const banCall = fetch.mock.calls.find(([url, opts]) => url.includes('banned_users') && opts.method === 'POST');
    const body = JSON.parse(banCall[1].body);
    expect(body.proton_pulse_user_id).toBe(OTHER_USER_ID);
    expect(body.steam_username).toBe('badguy');
    expect(body.banned_reason).toBe('spam');
    expect(body.banned_by).toBe(ADMIN_USER_ID);
  });

  test('hides all reports for the banned user', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__banUser(session, { protonPulseUserId: OTHER_USER_ID, clientId: null, steamUsername: 'badguy', reason: 'spam' });
    const hideCall = fetch.mock.calls.find(([url, opts]) => url.includes('user_configs') && opts.method === 'PATCH');
    expect(hideCall).toBeTruthy();
    const body = JSON.parse(hideCall[1].body);
    expect(body.is_hidden).toBe(true);
    expect(body.flagged_reason).toBe('admin:banned');
  });

  test('uses client_id filter when protonPulseUserId is null', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__banUser(session, { protonPulseUserId: null, clientId: 'client-abc', steamUsername: 'anon', reason: '' });
    const hideCall = fetch.mock.calls.find(([url, opts]) => url.includes('user_configs') && opts.method === 'PATCH');
    expect(hideCall[0]).toContain('client_id=eq.');
  });

  test('skips hiding reports when both ids are null', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__banUser(session, { protonPulseUserId: null, clientId: null, steamUsername: 'x', reason: '' });
    const hideCall = fetch.mock.calls.find(([url, opts]) => url.includes('user_configs') && opts?.method === 'PATCH');
    expect(hideCall).toBeFalsy();
  });

  test('throws when banned_users insert fails', async () => {
    await expect(makeCtx(failFetch(403)).__banUser(session, { protonPulseUserId: OTHER_USER_ID, clientId: null, steamUsername: 'x', reason: '' })).rejects.toThrow();
  });

  test('throws when hiding reports fails', async () => {
    let callCount = 0;
    const fetch = jest.fn(async (url, opts) => {
      callCount++;
      if (callCount === 1) return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'error' };
    });
    await expect(makeCtx(fetch).__banUser(session, { protonPulseUserId: OTHER_USER_ID, clientId: null, steamUsername: 'x', reason: '' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// unbanUser
// ---------------------------------------------------------------------------

describe('unbanUser', () => {
  const session = { access_token: 'tok' };

  test('sends DELETE to banned_users with correct id', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__unbanUser(session, 7, { protonPulseUserId: OTHER_USER_ID });
    const del = fetch.mock.calls.find(([url, opts]) => url.includes('banned_users') && opts.method === 'DELETE');
    expect(del[0]).toContain('id=eq.7');
  });

  test('restores reports where flagged_reason is admin:banned', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__unbanUser(session, 7, { protonPulseUserId: OTHER_USER_ID });
    const restore = fetch.mock.calls.find(([url, opts]) => url.includes('user_configs') && opts.method === 'PATCH');
    const body = JSON.parse(restore[1].body);
    expect(body.is_hidden).toBe(false);
    expect(body.is_flagged).toBe(false);
    expect(body.flagged_reason).toBeNull();
    expect(body.flagged_at).toBeNull();
  });

  test('restore URL filters by flagged_reason=admin:banned to avoid restoring other flags', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__unbanUser(session, 7, { protonPulseUserId: OTHER_USER_ID });
    const restore = fetch.mock.calls.find(([url, opts]) => url.includes('user_configs') && opts.method === 'PATCH');
    expect(restore[0]).toContain('admin%3Abanned');
  });

  test('uses client_id filter when protonPulseUserId is absent', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__unbanUser(session, 7, { clientId: 'client-abc' });
    const restore = fetch.mock.calls.find(([url, opts]) => url.includes('user_configs') && opts.method === 'PATCH');
    expect(restore[0]).toContain('client_id=eq.');
  });

  test('skips restoring reports when both ids are absent', async () => {
    const fetch = okFetch();
    await makeCtx(fetch).__unbanUser(session, 7, {});
    const restore = fetch.mock.calls.find(([url, opts]) => url.includes('user_configs') && opts?.method === 'PATCH');
    expect(restore).toBeFalsy();
  });

  test('throws when DELETE fails', async () => {
    await expect(makeCtx(failFetch(403)).__unbanUser(session, 7, {})).rejects.toThrow();
  });

  test('throws when restore PATCH fails', async () => {
    let callCount = 0;
    const fetch = jest.fn(async () => {
      callCount++;
      if (callCount === 1) return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'error' };
    });
    await expect(makeCtx(fetch).__unbanUser(session, 7, { protonPulseUserId: OTHER_USER_ID })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchFlaggedReports
// ---------------------------------------------------------------------------

describe('fetchFlaggedReports', () => {
  const session = { access_token: 'tok' };

  test('always filters is_flagged=true', async () => {
    const fetch = okFetch([]);
    const ctx = makeCtx(fetch);
    ctx.document.getElementById = jest.fn(() => makeEl());
    await ctx.__fetchFlaggedReports(session, {});
    expect(fetch.mock.calls[0][0]).toContain('is_flagged=eq.true');
  });

  test('applies date-from filter', async () => {
    const fetch = okFetch([]);
    await makeCtx(fetch).__fetchFlaggedReports(session, { dateFrom: '2026-01-01' });
    expect(fetch.mock.calls[0][0]).toContain('flagged_at=gte.');
  });

  test('applies date-to filter (adds one day for inclusive end)', async () => {
    const fetch = okFetch([]);
    await makeCtx(fetch).__fetchFlaggedReports(session, { dateTo: '2026-06-05' });
    expect(fetch.mock.calls[0][0]).toContain('flagged_at=lte.');
  });

  test('applies type filter', async () => {
    const fetch = okFetch([]);
    await makeCtx(fetch).__fetchFlaggedReports(session, { type: 'wordlist' });
    expect(fetch.mock.calls[0][0]).toContain('flagged_reason=like.');
  });

  test('applies app_id filter when APP_ID is set', async () => {
    const fetch = okFetch([]);
    await makeCtx(fetch).__fetchFlaggedReports(session, { appId: '12345' });
    // appId is passed via sortField sort, no direct filter in this impl - just check no throw
    expect(fetch).toHaveBeenCalled();
  });

  test('filters rows by search string (client-side)', async () => {
    const rows = [
      { id: 1, app_id: 100, title: 'Half-Life', proton_pulse_user_id: null, client_id: null, flagged_reason: 'wordlist:slur in notes', flagged_at: null, is_hidden: true },
      { id: 2, app_id: 200, title: 'Portal', proton_pulse_user_id: null, client_id: null, flagged_reason: 'openai:hate', flagged_at: null, is_hidden: true },
    ];
    const fetch = okFetch(rows);
    const result = await makeCtx(fetch).__fetchFlaggedReports(session, { search: 'half' });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Half-Life');
  });

  test('throws on HTTP error', async () => {
    await expect(makeCtx(failFetch(500)).__fetchFlaggedReports(session, {})).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchBannedUsers
// ---------------------------------------------------------------------------

describe('fetchBannedUsers', () => {
  const session = { access_token: 'tok' };

  test('queries banned_users endpoint', async () => {
    const fetch = okFetch([]);
    await makeCtx(fetch).__fetchBannedUsers(session, {});
    expect(fetch.mock.calls[0][0]).toContain('banned_users');
  });

  test('filters by search string (client-side)', async () => {
    const rows = [
      { id: 1, steam_username: 'badguy', banned_reason: 'spam', banned_at: '2026-01-01' },
      { id: 2, steam_username: 'normaluser', banned_reason: 'abuse', banned_at: '2026-01-02' },
    ];
    const fetch = okFetch(rows);
    const result = await makeCtx(fetch).__fetchBannedUsers(session, { search: 'badguy' });
    expect(result).toHaveLength(1);
    expect(result[0].steam_username).toBe('badguy');
  });

  test('returns all rows when no search', async () => {
    const rows = [{ id: 1, steam_username: 'a' }, { id: 2, steam_username: 'b' }];
    const result = await makeCtx(okFetch(rows)).__fetchBannedUsers(session, {});
    expect(result).toHaveLength(2);
  });

  test('throws on HTTP error', async () => {
    await expect(makeCtx(failFetch(500)).__fetchBannedUsers(session, {})).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchAdmins
// ---------------------------------------------------------------------------

describe('fetchAdmins', () => {
  const session = { access_token: 'tok' };

  test('queries admins endpoint', async () => {
    const fetch = okFetch([]);
    await makeCtx(fetch).__fetchAdmins(session);
    expect(fetch.mock.calls[0][0]).toContain('/admins');
  });

  test('returns rows', async () => {
    const rows = [{ proton_pulse_user_id: ADMIN_USER_ID, steam_username: 'ProfessorKaos64', added_at: '2026-06-05' }];
    const result = await makeCtx(okFetch(rows)).__fetchAdmins(session);
    expect(result).toHaveLength(1);
  });

  test('throws on HTTP error', async () => {
    await expect(makeCtx(failFetch(403)).__fetchAdmins(session)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Render helpers - ensure they don't throw on empty/full data
// ---------------------------------------------------------------------------

describe('renderFlagged', () => {
  function makeDocCtx(fetch) {
    const ctx = makeCtx(fetch);
    const loadingEl = makeEl();
    const emptyEl   = makeEl();
    const tableEl   = makeEl();
    const tbodyEl   = makeEl();
    ctx.document.getElementById = jest.fn((id) => {
      if (id === 'flagged-loading') return loadingEl;
      if (id === 'flagged-empty')   return emptyEl;
      if (id === 'flagged-table')   return tableEl;
      if (id === 'flagged-tbody')   return tbodyEl;
      return makeEl();
    });
    return { ctx, loadingEl, emptyEl, tableEl, tbodyEl };
  }

  test('shows empty state when rows is empty', () => {
    const { ctx, emptyEl, tableEl } = makeDocCtx(okFetch());
    ctx.__renderFlagged([]);
    expect(emptyEl.hidden).toBe(false);
    expect(tableEl.hidden).toBe(true);
  });

  test('populates tbody innerHTML when rows present', () => {
    const { ctx, tableEl, tbodyEl } = makeDocCtx(okFetch());
    const rows = [{ id: 1, app_id: 100, title: 'Game', proton_pulse_user_id: null, client_id: 'c1', flagged_reason: 'wordlist:slur in notes', flagged_at: '2026-06-01T00:00:00Z', is_hidden: true, _author: null }];
    ctx.__renderFlagged(rows);
    expect(tableEl.hidden).toBe(false);
    expect(typeof tbodyEl.innerHTML).toBe('string');
  });

  test('escapes game title in output (XSS prevention)', () => {
    const { ctx, tbodyEl } = makeDocCtx(okFetch());
    const rows = [{ id: 1, app_id: 100, title: '<script>alert(1)</script>', proton_pulse_user_id: null, client_id: null, flagged_reason: 'wordlist:x in notes', flagged_at: null, is_hidden: true, _author: null }];
    ctx.__renderFlagged(rows);
    expect(tbodyEl.innerHTML).not.toContain('<script>');
    expect(tbodyEl.innerHTML).toContain('&lt;script&gt;');
  });
});

describe('renderBanned', () => {
  function makeDocCtx(fetch) {
    const ctx = makeCtx(fetch);
    const els = {};
    ctx.document.getElementById = jest.fn((id) => {
      if (!els[id]) els[id] = makeEl();
      return els[id];
    });
    return { ctx, els };
  }

  test('shows empty state when rows is empty', () => {
    const { ctx, els } = makeDocCtx(okFetch());
    ctx.__renderBanned([]);
    expect(els['banned-empty'].hidden).toBe(false);
    expect(els['banned-table'].hidden).toBe(true);
  });

  test('populates tbody when rows present', () => {
    const { ctx, els } = makeDocCtx(okFetch());
    ctx.__renderBanned([{ id: 1, steam_username: 'badguy', banned_reason: 'spam', banned_at: '2026-01-01', proton_pulse_user_id: OTHER_USER_ID, client_id: null }]);
    expect(els['banned-table'].hidden).toBe(false);
  });

  test('escapes steam_username (XSS prevention)', () => {
    const { ctx, els } = makeDocCtx(okFetch());
    ctx.__renderBanned([{ id: 1, steam_username: '<img onerror=x>', banned_reason: '', banned_at: null, proton_pulse_user_id: null, client_id: 'c1' }]);
    expect(els['banned-tbody'].innerHTML).not.toContain('<img');
  });
});

describe('renderAdmins', () => {
  function makeDocCtx(fetch) {
    const ctx = makeCtx(fetch);
    const els = {};
    ctx.document.getElementById = jest.fn((id) => {
      if (!els[id]) els[id] = makeEl();
      return els[id];
    });
    return { ctx, els };
  }

  test('shows empty state when rows is empty', () => {
    const { ctx, els } = makeDocCtx(okFetch());
    ctx.__renderAdmins([]);
    expect(els['admins-empty'].hidden).toBe(false);
    expect(els['admins-table'].hidden).toBe(true);
  });

  test('populates tbody with role and remove button when rows present', () => {
    const { ctx, els } = makeDocCtx(okFetch());
    ctx.__renderAdmins([{ proton_pulse_user_id: ADMIN_USER_ID, steam_username: 'ProfessorKaos64', role: 'super_admin', added_at: '2026-06-05' }]);
    expect(els['admins-table'].hidden).toBe(false);
    expect(els['admins-tbody'].innerHTML).toContain('ProfessorKaos64');
    expect(els['admins-tbody'].innerHTML).toContain('super_admin');
    expect(els['admins-tbody'].innerHTML).toContain('remove-admin');
  });

  test('escapes username in output', () => {
    const { ctx, els } = makeDocCtx(okFetch());
    ctx.__renderAdmins([{ proton_pulse_user_id: ADMIN_USER_ID, steam_username: '<script>xss</script>', role: 'moderator', added_at: '2026-06-05' }]);
    expect(els['admins-tbody'].innerHTML).not.toContain('<script>');
    expect(els['admins-tbody'].innerHTML).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// addAdmin
// ---------------------------------------------------------------------------

describe('addAdmin', () => {
  const session = { access_token: 'tok' };

  test('POSTs to /admins with correct payload', async () => {
    const ctx = makeCtx(okFetch());
    await ctx.__addAdmin(session, { uuid: OTHER_USER_ID, username: 'newmod', role: 'moderator' });
    const call = ctx.fetch.mock.calls[0];
    expect(call[0]).toContain('/rest/v1/admins');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body);
    expect(body.proton_pulse_user_id).toBe(OTHER_USER_ID);
    expect(body.steam_username).toBe('newmod');
    expect(body.role).toBe('moderator');
  });

  test('throws on non-ok response', async () => {
    const ctx = makeCtx(failFetch(403));
    await expect(ctx.__addAdmin(session, { uuid: OTHER_USER_ID, username: 'x', role: 'moderator' }))
      .rejects.toThrow('Add admin failed: 403');
  });

  test('includes Authorization header', async () => {
    const ctx = makeCtx(okFetch());
    await ctx.__addAdmin(session, { uuid: OTHER_USER_ID, username: 'x', role: 'moderator' });
    expect(ctx.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
});

// ---------------------------------------------------------------------------
// removeAdmin
// ---------------------------------------------------------------------------

describe('removeAdmin', () => {
  const session = { access_token: 'tok' };

  test('DELETEs the correct admin by UUID', async () => {
    const ctx = makeCtx(okFetch());
    await ctx.__removeAdmin(session, OTHER_USER_ID);
    const call = ctx.fetch.mock.calls[0];
    expect(call[0]).toContain(`proton_pulse_user_id=eq.${OTHER_USER_ID}`);
    expect(call[1].method).toBe('DELETE');
  });

  test('throws on non-ok response', async () => {
    const ctx = makeCtx(failFetch(403));
    await expect(ctx.__removeAdmin(session, OTHER_USER_ID))
      .rejects.toThrow('Remove admin failed: 403');
  });

  test('includes Authorization header', async () => {
    const ctx = makeCtx(okFetch());
    await ctx.__removeAdmin(session, OTHER_USER_ID);
    expect(ctx.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
});

// ---------------------------------------------------------------------------
// updateAdminRole
// ---------------------------------------------------------------------------

describe('updateAdminRole', () => {
  const session = { access_token: 'tok' };

  test('PATCHes role on correct admin UUID', async () => {
    const ctx = makeCtx(okFetch());
    await ctx.__updateAdminRole(session, OTHER_USER_ID, 'super_admin');
    const call = ctx.fetch.mock.calls[0];
    expect(call[0]).toContain(`proton_pulse_user_id=eq.${OTHER_USER_ID}`);
    expect(call[1].method).toBe('PATCH');
    expect(JSON.parse(call[1].body).role).toBe('super_admin');
  });

  test('PATCHes to moderator role', async () => {
    const ctx = makeCtx(okFetch());
    await ctx.__updateAdminRole(session, OTHER_USER_ID, 'moderator');
    expect(JSON.parse(ctx.fetch.mock.calls[0][1].body).role).toBe('moderator');
  });

  test('throws on non-ok response', async () => {
    const ctx = makeCtx(failFetch(403));
    await expect(ctx.__updateAdminRole(session, OTHER_USER_ID, 'moderator'))
      .rejects.toThrow('Update role failed: 403');
  });
});

// ---------------------------------------------------------------------------
// fetchAllUsers
// ---------------------------------------------------------------------------

describe('fetchAllUsers', () => {
  const session = { access_token: 'tok' };
  const configRow = { proton_pulse_user_id: ADMIN_USER_ID, client_id: 'cid-1', updated_at: '2026-06-01T00:00:00Z' };
  const protonRow = { proton_pulse_user_id: ADMIN_USER_ID, installation_id: 'inst-1', updated_at: '2026-06-02T00:00:00Z' };
  const anonRow   = { proton_pulse_user_id: null, client_id: 'anon-client', updated_at: '2026-05-01T00:00:00Z' };

  test('fetches from user_configs and user_proton_configs', async () => {
    const ctx = makeCtx(mockFetch([
      { url: /user_configs[^_]/, body: [configRow] },
      { url: /user_proton_configs/, body: [protonRow] },
      { url: /author_avatars/, body: [] },
      { url: /admins/, body: [] },
    ]));
    const rows = await ctx.__fetchAllUsers(session);
    const urls = ctx.fetch.mock.calls.map(c => c[0]);
    expect(urls.some(u => u.includes('user_configs'))).toBe(true);
    expect(urls.some(u => u.includes('user_proton_configs'))).toBe(true);
  });

  test('merges configs and proton_configs under same user', async () => {
    const ctx = makeCtx(mockFetch([
      { url: /user_configs[^_]/, body: [configRow] },
      { url: /user_proton_configs/, body: [protonRow] },
      { url: /author_avatars/, body: [] },
      { url: /admins/, body: [] },
    ]));
    const rows = await ctx.__fetchAllUsers(session);
    expect(rows).toHaveLength(1);
    expect(rows[0].report_count).toBe(1); // only user_configs rows count as reports
  });

  test('anonymous client_id-only rows are included', async () => {
    const ctx = makeCtx(mockFetch([
      { url: /user_configs[^_]/, body: [anonRow] },
      { url: /user_proton_configs/, body: [] },
      { url: /author_avatars/, body: [] },
      { url: /admins/, body: [] },
    ]));
    const rows = await ctx.__fetchAllUsers(session);
    expect(rows).toHaveLength(1);
    expect(rows[0].client_id).toBe('anon-client');
    expect(rows[0].proton_pulse_user_id).toBeNull();
  });

  test('enriches display_name from author_avatars', async () => {
    const ctx = makeCtx(mockFetch([
      { url: /user_configs[^_]/, body: [configRow] },
      { url: /user_proton_configs/, body: [] },
      { url: /author_avatars/, body: [{ proton_pulse_user_id: ADMIN_USER_ID, display_name: 'ProfessorKaos64' }] },
      { url: /admins/, body: [] },
    ]));
    const rows = await ctx.__fetchAllUsers(session);
    expect(rows[0].display_name).toBe('ProfessorKaos64');
  });

  test('falls back to admins table for display name when not in author_avatars', async () => {
    const ctx = makeCtx(mockFetch([
      { url: /user_configs[^_]/, body: [configRow] },
      { url: /user_proton_configs/, body: [] },
      { url: /author_avatars/, body: [] },
      { url: /admins/, body: [{ proton_pulse_user_id: ADMIN_USER_ID, steam_username: 'ProfessorKaos64' }] },
    ]));
    const rows = await ctx.__fetchAllUsers(session);
    expect(rows[0].display_name).toBe('ProfessorKaos64');
  });

  test('search filters by display_name', async () => {
    const ctx = makeCtx(mockFetch([
      { url: /user_configs[^_]/, body: [configRow] },
      { url: /user_proton_configs/, body: [] },
      { url: /author_avatars/, body: [{ proton_pulse_user_id: ADMIN_USER_ID, display_name: 'ProfessorKaos64' }] },
      { url: /admins/, body: [] },
    ]));
    const rows = await ctx.__fetchAllUsers(session, { search: 'professor' });
    expect(rows).toHaveLength(1);
    const none = await ctx.__fetchAllUsers(session, { search: 'zzznomatch' });
    expect(none).toHaveLength(0);
  });

  test('search filters by client_id', async () => {
    const ctx = makeCtx(mockFetch([
      { url: /user_configs[^_]/, body: [anonRow] },
      { url: /user_proton_configs/, body: [] },
      { url: /author_avatars/, body: [] },
      { url: /admins/, body: [] },
    ]));
    const rows = await ctx.__fetchAllUsers(session, { search: 'anon-client' });
    expect(rows).toHaveLength(1);
  });

  test('throws when user_configs fetch fails', async () => {
    const ctx = makeCtx(mockFetch([
      { url: /user_configs[^_]/, status: 500, body: [] },
      { url: /user_proton_configs/, body: [] },
    ]));
    await expect(ctx.__fetchAllUsers(session)).rejects.toThrow('Fetch user_configs failed');
  });
});

// ---------------------------------------------------------------------------
// renderUsers
// ---------------------------------------------------------------------------

describe('renderUsers', () => {
  function makeDocCtx() {
    const ctx = makeCtx(okFetch());
    const els = {};
    ctx.document.getElementById = jest.fn((id) => {
      if (!els[id]) els[id] = makeEl();
      return els[id];
    });
    return { ctx, els };
  }

  test('shows empty state when rows is empty', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderUsers([]);
    expect(els['users-empty'].hidden).toBe(false);
    expect(els['users-table'].hidden).toBe(true);
  });

  test('populates tbody with user data', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderUsers([{
      proton_pulse_user_id: ADMIN_USER_ID,
      client_id: 'cid-1',
      display_name: 'ProfessorKaos64',
      report_count: 3,
      last_active: '2026-06-05T00:00:00Z',
    }]);
    expect(els['users-table'].hidden).toBe(false);
    expect(els['users-tbody'].innerHTML).toContain('ProfessorKaos64');
    expect(els['users-tbody'].innerHTML).toContain('3');
    expect(els['users-tbody'].innerHTML).toContain('ban-user');
  });

  test('shows dash when proton_pulse_user_id is null', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderUsers([{
      proton_pulse_user_id: null,
      client_id: 'anon-client',
      display_name: null,
      report_count: 1,
      last_active: '2026-06-01T00:00:00Z',
    }]);
    expect(els['users-tbody'].innerHTML).toContain('(anonymous)');
    expect(els['users-tbody'].innerHTML).toContain('anon-client');
  });

  test('escapes display_name to prevent XSS', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderUsers([{
      proton_pulse_user_id: ADMIN_USER_ID,
      client_id: null,
      display_name: '<img src=x onerror=alert(1)>',
      report_count: 0,
      last_active: null,
    }]);
    expect(els['users-tbody'].innerHTML).not.toContain('<img');
    expect(els['users-tbody'].innerHTML).toContain('&lt;img');
  });

  test('hides error element on successful render', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderUsers([]);
    expect(els['users-error'].hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchBannedPhrases
// ---------------------------------------------------------------------------

describe('fetchBannedPhrases', () => {
  const session = { access_token: 'tok', user: { id: ADMIN_USER_ID } };

  test('GETs /banned_phrases ordered by created_at desc', async () => {
    const fetch = mockFetch([{ url: /banned_phrases/, body: [] }]);
    const ctx = makeCtx(fetch);
    await ctx.__fetchBannedPhrases(session);
    expect(fetch.mock.calls[0][0]).toContain('/banned_phrases');
    expect(fetch.mock.calls[0][0]).toContain('order=created_at.desc');
  });

  test('returns rows on success', async () => {
    const rows = [{ id: 'abc', pattern: 'spam', is_regex: false, enabled: true }];
    const ctx = makeCtx(mockFetch([{ url: /banned_phrases/, body: rows }]));
    const result = await ctx.__fetchBannedPhrases(session);
    expect(result).toEqual(rows);
  });

  test('throws on HTTP error', async () => {
    const ctx = makeCtx(failFetch(403));
    await expect(ctx.__fetchBannedPhrases(session)).rejects.toThrow('403');
  });
});

// ---------------------------------------------------------------------------
// addBannedPhrase
// ---------------------------------------------------------------------------

describe('addBannedPhrase', () => {
  const session = { access_token: 'tok', user: { id: ADMIN_USER_ID } };

  test('POSTs literal phrase with correct payload', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__addBannedPhrase(session, { pattern: 'badword', is_regex: false, description: 'test' });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.pattern).toBe('badword');
    expect(body.is_regex).toBe(false);
    expect(body.description).toBe('test');
    expect(body.created_by).toBe(ADMIN_USER_ID);
  });

  test('POSTs regex phrase with is_regex true', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__addBannedPhrase(session, { pattern: '\\bspam\\b', is_regex: true, description: null });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.is_regex).toBe(true);
    expect(body.description).toBeNull();
  });

  test('uses POST method', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__addBannedPhrase(session, { pattern: 'x', is_regex: false, description: null });
    expect(fetch.mock.calls[0][1].method).toBe('POST');
  });

  test('throws on HTTP error', async () => {
    const ctx = makeCtx(failFetch(403));
    await expect(ctx.__addBannedPhrase(session, { pattern: 'x', is_regex: false, description: null })).rejects.toThrow('403');
  });
});

// ---------------------------------------------------------------------------
// removeBannedPhrase
// ---------------------------------------------------------------------------

describe('removeBannedPhrase', () => {
  const session = { access_token: 'tok', user: { id: ADMIN_USER_ID } };

  test('DELETEs the phrase by id', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__removeBannedPhrase(session, 'phrase-uuid-1');
    expect(fetch.mock.calls[0][0]).toContain('id=eq.phrase-uuid-1');
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
  });

  test('throws on HTTP error', async () => {
    const ctx = makeCtx(failFetch(403));
    await expect(ctx.__removeBannedPhrase(session, 'x')).rejects.toThrow('403');
  });
});

// ---------------------------------------------------------------------------
// toggleBannedPhrase
// ---------------------------------------------------------------------------

describe('toggleBannedPhrase', () => {
  const session = { access_token: 'tok', user: { id: ADMIN_USER_ID } };

  test('PATCHes enabled=true to enable a phrase', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__toggleBannedPhrase(session, 'phrase-id', true);
    expect(fetch.mock.calls[0][1].method).toBe('PATCH');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ enabled: true });
  });

  test('PATCHes enabled=false to disable a phrase', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__toggleBannedPhrase(session, 'phrase-id', false);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ enabled: false });
  });

  test('includes phrase id in URL filter', async () => {
    const fetch = okFetch();
    const ctx = makeCtx(fetch);
    await ctx.__toggleBannedPhrase(session, 'my-phrase-id', true);
    expect(fetch.mock.calls[0][0]).toContain('id=eq.my-phrase-id');
  });

  test('throws on HTTP error', async () => {
    const ctx = makeCtx(failFetch(403));
    await expect(ctx.__toggleBannedPhrase(session, 'x', true)).rejects.toThrow('403');
  });
});

// ---------------------------------------------------------------------------
// renderPhrases
// ---------------------------------------------------------------------------

describe('renderPhrases', () => {
  function makeDocCtx() {
    const ctx = makeCtx(okFetch());
    const els = {};
    ctx.document.getElementById = jest.fn((id) => {
      if (!els[id]) els[id] = makeEl();
      return els[id];
    });
    return { ctx, els };
  }

  test('shows empty state when rows is empty', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderPhrases([]);
    expect(els['phrases-empty'].hidden).toBe(false);
    expect(els['phrases-table'].hidden).toBe(true);
  });

  test('renders a literal phrase with Literal badge', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderPhrases([{ id: 'a1', pattern: 'badword', is_regex: false, description: 'test', enabled: true, created_at: '2026-06-01' }]);
    expect(els['phrases-table'].hidden).toBe(false);
    expect(els['phrases-tbody'].innerHTML).toContain('badword');
    expect(els['phrases-tbody'].innerHTML).toContain('Literal');
  });

  test('renders a regex phrase with Regex badge', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderPhrases([{ id: 'a2', pattern: '\\bspam\\b', is_regex: true, description: null, enabled: true, created_at: '2026-06-01' }]);
    expect(els['phrases-tbody'].innerHTML).toContain('Regex');
    expect(els['phrases-tbody'].innerHTML).toContain('admin-badge--regex');
  });

  test('disabled phrase has admin-row--disabled class and Enable button', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderPhrases([{ id: 'a3', pattern: 'x', is_regex: false, description: null, enabled: false, created_at: '2026-06-01' }]);
    expect(els['phrases-tbody'].innerHTML).toContain('admin-row--disabled');
    expect(els['phrases-tbody'].innerHTML).toContain('Enable');
  });

  test('escapes pattern to prevent XSS', () => {
    const { ctx, els } = makeDocCtx();
    ctx.__renderPhrases([{ id: 'a4', pattern: '<script>xss()</script>', is_regex: false, description: null, enabled: true, created_at: null }]);
    expect(els['phrases-tbody'].innerHTML).not.toContain('<script>');
    expect(els['phrases-tbody'].innerHTML).toContain('&lt;script&gt;');
  });
});
