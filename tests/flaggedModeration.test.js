const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const flaggedComponentSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'components', 'flagged.js'),
  'utf8'
);
const adminMainSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'main.js'),
  'utf8'
);

function loadFlaggedApi(fetchImpl) {
  const calls = [];
  const ctx = {
    SUPABASE_URL: 'https://sb.example',
    supabaseHeaders: (_s, extra = {}) => ({ ...extra }),
    fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
  };
  const mod = loadEsm(['js/admin/api/flagged.js'], ctx);
  return { mod, calls };
}

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

describe('flagged report moderation', () => {
  test('detail view offers Release / Shadow ban / Delete report for Pulse sources only', () => {
    expect(flaggedComponentSrc).toContain('data-action="flag-release"');
    expect(flaggedComponentSrc).toContain('data-action="flag-shadowban"');
    expect(flaggedComponentSrc).toContain('data-action="flag-delete-report"');
    expect(flaggedComponentSrc).toContain('isPulseSource(flagRow.source)');
  });

  test('isPulseSource recognizes pulse and proton-pulse', () => {
    const { mod } = loadFlaggedApi(() => ok([]));
    // isPulseSource is exported from the component, load it via the component module
    const comp = loadEsm(['js/admin/components/flagged.js'], {
      escapeHtml: s => s, fmtDateTime: s => s, friendlyReason: s => s,
    });
    expect(comp.isPulseSource('pulse')).toBe(true);
    expect(comp.isPulseSource('proton-pulse')).toBe(true);
    expect(comp.isPulseSource('protondb')).toBe(false);
  });

  test('shadowBanReport PATCHes is_hidden=true on the config row', async () => {
    const { mod, calls } = loadFlaggedApi(() => ok(null));
    await mod.shadowBanReport({}, 42);
    expect(calls[0].url).toContain('/user_configs?id=eq.42');
    expect(calls[0].opts.method).toBe('PATCH');
    expect(JSON.parse(calls[0].opts.body)).toMatchObject({ is_hidden: true });
  });

  test('releaseReportContent clears hidden and flagged', async () => {
    const { mod, calls } = loadFlaggedApi(() => ok(null));
    await mod.releaseReportContent({}, 7);
    expect(JSON.parse(calls[0].opts.body)).toEqual({ is_hidden: false, is_flagged: false });
  });

  test('deleteReportContent issues a DELETE on the config row', async () => {
    const { mod, calls } = loadFlaggedApi(() => ok(null));
    await mod.deleteReportContent({}, 99);
    expect(calls[0].opts.method).toBe('DELETE');
    expect(calls[0].url).toContain('/user_configs?id=eq.99');
  });

  test('findPulseConfigId matches the row whose report_key derives from created_at/gpu/proton', async () => {
    const created = '2026-06-16T00:00:00Z';
    const ts = Math.floor(new Date(created).getTime() / 1000);
    const key = `${ts}:NVIDIA RTX 4090:GE-Proton9-5`;
    const { mod } = loadFlaggedApi(() => ok([
      { id: 1, gpu: 'AMD', proton_version: 'x', created_at: created },
      { id: 2, gpu: 'NVIDIA RTX 4090', proton_version: 'GE-Proton9-5', created_at: created },
    ]));
    const id = await mod.findPulseConfigId({}, '730', key);
    expect(id).toBe(2);
  });

  test('admin handler resolves the config then marks the flag complete', () => {
    expect(adminMainSrc).toContain("action === 'flag-shadowban'");
    expect(adminMainSrc).toContain('findPulseConfigId(currentSession, flag.app_id, flag.report_key)');
    expect(adminMainSrc).toContain("updateFlagStatus(currentSession, id, 'complete')");
  });
});
