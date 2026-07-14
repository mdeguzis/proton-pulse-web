/**
 * Behavioral tests for js/admin/api/allReports.js loaded via require()
 * so Istanbul instruments the source for real coverage credit.
 *
 * admin/config.js bridges classic-script globals (window.SUPABASE_URL +
 * SUPABASE_ANON_KEY) into ES module scope. We seed those on globalThis +
 * window before requiring so the import chain resolves.
 */

global.window = global;
global.window.SUPABASE_URL = 'https://test.supabase.co';
global.window.SUPABASE_ANON_KEY = 'test-anon-key';
// jest.config moduleNameMapper strips ?v=<hash> so this require chain
// resolves cleanly.
const {
  fetchReportById,
  fetchAllReports,
  patchReportFlags,
} = require('../js/admin/api/allReports.js');

function makeFetchStub(routes) {
  // routes: { '<url-prefix>': rowsOrPayload }, falls through to []
  return jest.fn(async (url) => {
    const entry = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    const payload = entry ? entry[1] : [];
    return { ok: true, json: async () => payload };
  });
}

const makeSession = () => ({ access_token: 'tok_xyz', user: { id: 'admin-1' } });

describe('fetchAllReports query building', () => {
  beforeEach(() => { delete global.location; global.location = { hostname: 'localhost' }; });

  test('select column list includes flagged_reason for the row tooltip', async () => {
    const fetchSpy = makeFetchStub({});
    global.fetch = fetchSpy;
    await fetchAllReports(makeSession(), { status: '' });
    const callUrl = fetchSpy.mock.calls[0][0];
    expect(callUrl).toMatch(/select=[^&]*flagged_reason/);
  });

  test('search term builds an or= filter on app_id + title.ilike', async () => {
    const fetchSpy = makeFetchStub({});
    global.fetch = fetchSpy;
    await fetchAllReports(makeSession(), { status: '', search: 'half life' });
    const callUrl = fetchSpy.mock.calls[0][0];
    expect(callUrl).toContain('or=(app_id.eq.half%20life,title.ilike.*half%20life*)');
  });

  test('status=flagged adds is_flagged=eq.true to the query', async () => {
    const fetchSpy = makeFetchStub({});
    global.fetch = fetchSpy;
    await fetchAllReports(makeSession(), { status: 'flagged' });
    expect(fetchSpy.mock.calls[0][0]).toContain('is_flagged=eq.true');
  });

  test('status=hidden adds is_hidden=eq.true', async () => {
    const fetchSpy = makeFetchStub({});
    global.fetch = fetchSpy;
    await fetchAllReports(makeSession(), { status: 'hidden' });
    expect(fetchSpy.mock.calls[0][0]).toContain('is_hidden=eq.true');
  });

  test('status=clean and pending both exclude flagged + hidden at the DB level', async () => {
    const fetchSpy = makeFetchStub({});
    global.fetch = fetchSpy;
    await fetchAllReports(makeSession(), { status: 'clean' });
    expect(fetchSpy.mock.calls[0][0]).toContain('is_flagged=eq.false&is_hidden=eq.false');
    fetchSpy.mockClear();
    await fetchAllReports(makeSession(), { status: 'pending' });
    expect(fetchSpy.mock.calls[0][0]).toContain('is_flagged=eq.false&is_hidden=eq.false');
  });

  test('appType filter is forwarded to app_type=eq.<value>', async () => {
    const fetchSpy = makeFetchStub({});
    global.fetch = fetchSpy;
    await fetchAllReports(makeSession(), { status: '', appType: 'gog' });
    expect(fetchSpy.mock.calls[0][0]).toContain('app_type=eq.gog');
  });

  test('date range builds created_at>=from + <=to+T23:59:59', async () => {
    const fetchSpy = makeFetchStub({});
    global.fetch = fetchSpy;
    await fetchAllReports(makeSession(), { status: '', dateFrom: '2026-01-01', dateTo: '2026-06-30' });
    const url = fetchSpy.mock.calls[0][0];
    expect(url).toContain('created_at=gte.2026-01-01');
    expect(url).toContain('created_at=lte.2026-06-30T23%3A59%3A59');
  });
});

describe('fetchAllReports pending/clean partition', () => {
  beforeEach(() => { delete global.location; global.location = { hostname: 'localhost' }; });

  test('status=pending keeps rows without an approval row', async () => {
    const rows = [
      { id: 1, app_id: '730', title: 'A', is_flagged: false, is_hidden: false },
      { id: 2, app_id: '731', title: 'B', is_flagged: false, is_hidden: false },
    ];
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': rows,
      'https://test.supabase.co/rest/v1/report_approvals': [{ report_id: 1 }],
    });
    const result = await fetchAllReports(makeSession(), { status: 'pending' });
    expect(result.map((r) => r.id)).toEqual([2]);
    expect(result[0].is_pending).toBe(true);
  });

  test('status=clean keeps rows that DO have an approval row', async () => {
    const rows = [
      { id: 1, app_id: '730', title: 'A', is_flagged: false, is_hidden: false },
      { id: 2, app_id: '731', title: 'B', is_flagged: false, is_hidden: false },
    ];
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': rows,
      'https://test.supabase.co/rest/v1/report_approvals': [{ report_id: 1 }],
    });
    const result = await fetchAllReports(makeSession(), { status: 'clean' });
    expect(result.map((r) => r.id)).toEqual([1]);
    expect(result[0].is_pending).toBe(false);
  });
});

describe('fetchAllReports fallback title repair (#147)', () => {
  beforeEach(() => {
    delete global.location;
    global.location = { hostname: 'localhost' };
    // Reset the module-level search-index cache so each test gets a clean fetch.
    jest.resetModules();
  });

  test('"App <id>" titles get rewritten from search-index.json', async () => {
    const { fetchAllReports: fresh } = require('../js/admin/api/allReports.js');
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 23, app_id: '2881370', title: 'App 2881370', is_flagged: false, is_hidden: false },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      'https://www.proton-pulse.com/search-index.json': [
        ['2881370', 'Thank You For Your Application', '', 0, 0, 'steam'],
      ],
    });
    const result = await fresh(makeSession(), { status: '' });
    expect(result[0].title).toBe('Thank You For Your Application');
  });

  test('real titles pass through unchanged', async () => {
    const { fetchAllReports: fresh } = require('../js/admin/api/allReports.js');
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '570', title: 'Dota 2', is_flagged: false, is_hidden: false },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      'https://www.proton-pulse.com/search-index.json': [['570', 'Dota: Other Name']],
    });
    const result = await fresh(makeSession(), { status: '' });
    expect(result[0].title).toBe('Dota 2');
  });

  test('all-real-titles skips the search-index fetch entirely', async () => {
    const { fetchAllReports: fresh } = require('../js/admin/api/allReports.js');
    const fetchSpy = jest.fn(async (url) => {
      if (url.startsWith('https://test.supabase.co/rest/v1/user_configs')) {
        return { ok: true, json: async () => [
          { id: 1, app_id: '570', title: 'Dota 2', is_flagged: false, is_hidden: false },
        ]};
      }
      return { ok: true, json: async () => [] };
    });
    global.fetch = fetchSpy;
    await fresh(makeSession(), { status: '' });
    const sawIndex = fetchSpy.mock.calls.some(
      ([url]) => url === 'https://www.proton-pulse.com/search-index.json'
    );
    expect(sawIndex).toBe(false);
  });

  test('rows with no matching index entry keep the fallback title', async () => {
    const { fetchAllReports: fresh } = require('../js/admin/api/allReports.js');
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 1, app_id: '99999', title: 'App 99999', is_flagged: false, is_hidden: false },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      'https://www.proton-pulse.com/search-index.json': [['570', 'Dota 2']],
    });
    const result = await fresh(makeSession(), { status: '' });
    expect(result[0].title).toBe('App 99999');
  });
});

describe('fetchReportById', () => {
  beforeEach(() => { delete global.location; global.location = { hostname: 'localhost' }; });

  test('returns the single row with is_pending=true when no approval row exists', async () => {
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 42, app_id: '730', title: 'Hl2', flagged_reason: null, flagged_at: null },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    });
    const r = await fetchReportById(makeSession(), 42);
    expect(r.id).toBe(42);
    expect(r.is_pending).toBe(true);
  });

  test('flips is_pending=false when an approval row exists', async () => {
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 42, app_id: '730', title: 'Hl2' },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [{ report_id: 42 }],
    });
    const r = await fetchReportById(makeSession(), 42);
    expect(r.is_pending).toBe(false);
  });

  test('resolves steam_username and steam_id from author_avatars for a signed-in reporter', async () => {
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 42, app_id: '730', title: 'Hl2', proton_pulse_user_id: 'user-uuid-1', client_id: 'cid-9' },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
      'https://test.supabase.co/rest/v1/author_avatars': [
        { display_name: 'ProfessorKaos64', steam_id: '76561198000000000' },
      ],
    });
    const r = await fetchReportById(makeSession(), 42);
    expect(r.steam_username).toBe('ProfessorKaos64');
    expect(r.steam_id).toBe('76561198000000000');
  });

  test('leaves steam_username unset and skips the avatar lookup for an anonymous report', async () => {
    const fetchSpy = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': [
        { id: 43, app_id: '730', title: 'Hl2', proton_pulse_user_id: null, client_id: 'cid-anon' },
      ],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    });
    global.fetch = fetchSpy;
    const r = await fetchReportById(makeSession(), 43);
    expect(r.steam_username).toBeUndefined();
    expect(fetchSpy.mock.calls.some(([url]) => url.includes('author_avatars'))).toBe(false);
  });

  test('throws when the row does not exist', async () => {
    global.fetch = makeFetchStub({
      'https://test.supabase.co/rest/v1/user_configs': [],
      'https://test.supabase.co/rest/v1/report_approvals': [],
    });
    await expect(fetchReportById(makeSession(), 999)).rejects.toThrow(/Report not found/);
  });
});

describe('patchReportFlags', () => {
  test('PATCHes the row with the supplied body and Prefer:return=minimal', async () => {
    const fetchSpy = jest.fn(async () => ({ ok: true, json: async () => [] }));
    global.fetch = fetchSpy;
    await patchReportFlags(makeSession(), '7', { is_flagged: true });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/rest/v1/user_configs?id=eq.7');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(init.body)).toEqual({ is_flagged: true });
  });

  test('throws on non-ok response', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 403, text: async () => '' }));
    await expect(patchReportFlags(makeSession(), '7', { is_flagged: true })).rejects.toThrow(/403/);
  });
});
