const { loadEsm } = require('./_esm-vm.js');

function loadApi(fetchImpl) {
  const calls = [];
  const ctx = {
    SB_URL: 'https://sb.example/rest/v1',
    SB_KEY: 'anon-key',
    console: { log() {}, debug() {}, warn() {}, error() {} },
    fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
  };
  const mod = loadEsm(['js/app/api/supabase.js'], ctx);
  return { mod, calls };
}

describe('fetchSupabase', () => {
  test('non-Steam ids skip the query (#404: bigint app_id column 400s on them)', async () => {
    const { mod, calls } = loadApi(() => Promise.resolve({ ok: true, status: 200, json: async () => [] }));
    await expect(mod.fetchSupabase('pgwiki:The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay')).resolves.toEqual([]);
    await expect(mod.fetchSupabase('gog:1514133152')).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('numeric Steam ids still query user_proton_configs', async () => {
    const { mod, calls } = loadApi(() => Promise.resolve({ ok: true, status: 200, json: async () => [] }));
    await mod.fetchSupabase('730');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/user_proton_configs?app_id=eq.730');
  });
});

describe('flagReport', () => {
  test('submits through the submit_flag RPC (upsert + re-open), not a raw insert', async () => {
    const { mod, calls } = loadApi(() => Promise.resolve({ ok: true, status: 204 }));
    const ok = await mod.flagReport({ appId: 9999992, reportKey: 'k', source: 'protondb', reasonCategory: 'spam' });
    expect(ok).toBe(true);
    const flagCall = calls.find(c => c.url.includes('/rpc/submit_flag'));
    expect(flagCall).toBeTruthy();
    expect(JSON.parse(flagCall.opts.body)).toMatchObject({ p_app_id: '9999992', p_report_key: 'k', p_source: 'protondb' });
    // no direct POST to the flagged_reports table
    expect(calls.some(c => /\/flagged_reports(\?|$)/.test(c.url))).toBe(false);
  });

  test('never writes user_configs directly; the trigger sets is_flagged', async () => {
    // A client PATCH of user_configs.is_flagged used to follow the RPC. The
    // policy that allowed it let anyone rewrite any report, and was dropped.
    const { mod, calls } = loadApi(() => Promise.resolve({ ok: true, status: 204 }));
    const ok = await mod.flagReport({ reportId: 5, appId: '730', reportKey: 'k', source: 'pulse' });
    expect(ok).toBe(true);
    expect(calls.some(c => c.url.includes('/user_configs'))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('a failed RPC reports failure', async () => {
    const { mod } = loadApi(() => Promise.resolve({ ok: false, status: 500 }));
    expect(await mod.flagReport({ reportId: 5, appId: '730', reportKey: 'k', source: 'pulse' })).toBe(false);
  });
});
