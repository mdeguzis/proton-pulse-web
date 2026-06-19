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

  test('a failed is_flagged PATCH does not fail the flag (RLS owner-only)', async () => {
    const { mod } = loadApi((url) =>
      url.includes('/rpc/submit_flag')
        ? Promise.resolve({ ok: true, status: 204 })
        : Promise.resolve({ ok: false, status: 403 }));
    const ok = await mod.flagReport({ reportId: 5, appId: '730', reportKey: 'k', source: 'pulse' });
    expect(ok).toBe(true);
  });
});
