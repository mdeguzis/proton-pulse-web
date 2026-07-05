/**
 * Tests for the cloud draft helpers in js/shared/drafts.js. Locks down the
 * auth-header shape, the RLS-friendly URL params, and the on_conflict clause
 * so the Save Draft button can't silently regress into a stale row (#199).
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SUPABASE_URL  = 'https://test.supabase.co';
const ANON_KEY      = 'test-anon-key';
const SESSION       = { access_token: 'tok', user: { id: 'u-1' } };

function loadSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^import\s.*$/gm, '')
    .replace(/^export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ')
    .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeCtx(fetchMock) {
  const ctx = vm.createContext({
    fetch: fetchMock,
    SUPABASE_URL,
    SUPABASE_ANON_KEY: ANON_KEY,
    console,
    Date,
  });
  vm.runInContext(loadSrc('js/shared/drafts.js'), ctx);
  return ctx;
}

describe('getDraft', () => {
  test('returns null with no session', async () => {
    const fetchMock = jest.fn();
    const ctx = makeCtx(fetchMock);
    const row = await ctx.getDraft(null, '730');
    expect(row).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns null with no appId', async () => {
    const fetchMock = jest.fn();
    const ctx = makeCtx(fetchMock);
    expect(await ctx.getDraft(SESSION, '')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns the single row from the REST response', async () => {
    const row = { form_data: { values: { cpu: 'x' } }, updated_at: '2026-07-05T20:00:00Z' };
    const fetchMock = jest.fn(async () => jsonResponse(200, [row]));
    const ctx = makeCtx(fetchMock);
    const got = await ctx.getDraft(SESSION, '730');
    expect(got).toEqual(row);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('user_report_drafts');
    expect(url).toContain('app_id=eq.730');
    expect(url).toContain('limit=1');
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  test('returns null when the query fails', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(500, []));
    const ctx = makeCtx(fetchMock);
    expect(await ctx.getDraft(SESSION, '730')).toBeNull();
  });
});

describe('upsertDraft', () => {
  test('rejects with no session', async () => {
    const fetchMock = jest.fn();
    const ctx = makeCtx(fetchMock);
    await expect(ctx.upsertDraft(null, '730', {})).rejects.toThrow(/Sign in/);
  });

  test('posts on_conflict=user_id,app_id with merge-duplicates', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(201, {}));
    const ctx = makeCtx(fetchMock);
    await ctx.upsertDraft(SESSION, '730', { values: { cpu: 'x' } });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('on_conflict=user_id,app_id');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Prefer).toContain('resolution=merge-duplicates');
    const body = JSON.parse(opts.body);
    expect(body.user_id).toBe('u-1');
    expect(body.app_id).toBe('730');
    expect(body.form_data).toEqual({ values: { cpu: 'x' } });
    expect(typeof body.updated_at).toBe('string');
  });

  test('throws on non-2xx', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(403, { error: 'nope' }));
    const ctx = makeCtx(fetchMock);
    await expect(ctx.upsertDraft(SESSION, '730', {})).rejects.toThrow(/HTTP 403/);
  });
});

describe('deleteDraft', () => {
  test('no-ops without session or appId', async () => {
    const fetchMock = jest.fn();
    const ctx = makeCtx(fetchMock);
    await ctx.deleteDraft(null, '730');
    await ctx.deleteDraft(SESSION, '');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends DELETE with app_id filter and auth', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(204, ''));
    const ctx = makeCtx(fetchMock);
    await ctx.deleteDraft(SESSION, '730');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('user_report_drafts');
    expect(url).toContain('app_id=eq.730');
    expect(opts.method).toBe('DELETE');
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });
});

describe('snapshotFormData', () => {
  test('captures text inputs, radios, and _formState', () => {
    const ctx = makeCtx(jest.fn());
    // Fake form with .elements iteration matching the shape submit uses.
    const cpu = { name: 'cpu', value: 'Ryzen', type: 'text' };
    const yes = { name: 'canInstall', value: 'yes', type: 'radio', checked: true };
    const no  = { name: 'canInstall', value: 'no', type: 'radio', checked: false };
    const form = {
      elements: [cpu, yes, no],
      _formState: {
        canInstall: 'yes', canPlay: 'yes',
        faults: { performanceFaults: 'no' },
        tinkeringMethods: new Set(['winetricks']),
      },
    };
    const snap = ctx.snapshotFormData(form);
    expect(snap.values.cpu).toBe('Ryzen');
    expect(snap.values.canInstall).toBe('yes');
    expect(snap.state.canInstall).toBe('yes');
    expect(snap.state.faults).toEqual({ performanceFaults: 'no' });
    expect(snap.state.tinkeringMethods).toEqual(['winetricks']);
  });
});
