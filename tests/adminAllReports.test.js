const { loadEsm } = require('./_esm-vm.js');

function makeSession() {
  return { access_token: 'tok', user: { id: 'uid' } };
}

function loadApi(fetchImpl) {
  const calls = [];
  const ctx = {
    SUPABASE_URL: 'https://sb.example',
    supabaseHeaders: () => ({ Authorization: 'Bearer tok', apikey: 'anon' }),
    fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
  };
  loadEsm(['js/admin/api/allReports.js'], ctx);
  return { ctx, calls };
}

describe('fetchAllReports', () => {
  test('fetches user_configs ordered by created_at desc', async () => {
    const rows = [{ id: 1, app_id: '730', title: 'Counter-Strike 2', rating: 'platinum', source: 'pulse', created_at: '2025-01-01T00:00:00Z' }];
    const { ctx, calls } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve(rows) }));

    const result = await ctx.fetchAllReports(makeSession());

    expect(result).toEqual(rows);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/user_configs');
    expect(calls[0].url).toContain('order=created_at.desc');
  });

  test('appends search filter when query is provided', async () => {
    const { ctx, calls } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    await ctx.fetchAllReports(makeSession(), { search: '730' });

    expect(calls[0].url).toContain('or=');
    expect(calls[0].url).toContain('730');
  });

  test('throws when response is not ok', async () => {
    const { ctx } = loadApi(() => Promise.resolve({ ok: false, status: 403 }));

    await expect(ctx.fetchAllReports(makeSession())).rejects.toThrow('403');
  });
});
