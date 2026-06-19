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
  test('detail view offers Release / Shadow ban / Delete report for ANY source', () => {
    expect(flaggedComponentSrc).toContain('data-action="flag-release"');
    expect(flaggedComponentSrc).toContain('data-action="flag-shadowban"');
    expect(flaggedComponentSrc).toContain('data-action="flag-delete-report"');
    // No source gate around the action buttons; they live in a reusable bar
    expect(flaggedComponentSrc).toContain('const actionBar =');
    expect(flaggedComponentSrc).not.toMatch(/isPulseSource\(flagRow\.source\)\s*\?\s*`\s*<button[^`]*flag-release/);
  });

  test('the action bar is rendered only once (top), not at the bottom', () => {
    const occurrences = (flaggedComponentSrc.match(/\$\{actionBar\}/g) || []).length;
    expect(occurrences).toBe(1);
  });

  test('Shadow ban is a stateful toggle showing current state', () => {
    expect(flaggedComponentSrc).toContain('const isShadowed = state === \'shadowbanned\'');
    expect(flaggedComponentSrc).toContain('Un-shadow ban');
    expect(flaggedComponentSrc).toContain('flag-detail-state');
    // when shadowed, the toggle releases
    expect(flaggedComponentSrc).toMatch(/isShadowed[\s\S]*?data-action="flag-release"[\s\S]*?Un-shadow ban/);
  });

  test('flagged list shows Flagged and Reviewed date columns', () => {
    expect(flaggedComponentSrc).toContain('fmtDateTime(r.flagged_at)');
    expect(flaggedComponentSrc).toContain('fmtDateTime(r.updated_at)');
  });

  test('a report action re-renders the detail instead of returning to the list', () => {
    // After release/shadow ban/delete the handler reloads the detail so the
    // state toggle updates in place; only Back leaves the screen.
    expect(adminMainSrc).toContain('await loadFlagDetail(target || flag)');
  });

  test('fetchReportState resolves visible vs shadowbanned', async () => {
    const created = '2026-06-16T00:00:00Z';
    const ts = Math.floor(new Date(created).getTime() / 1000);
    const key = `${ts}:NV:GE`;
    const { mod } = loadFlaggedApi((url) =>
      url.includes('/user_configs')
        ? ok([{ id: 1, gpu: 'NV', proton_version: 'GE', created_at: created, is_hidden: true }])
        : ok([]));
    const st = await mod.fetchReportState({}, { app_id: '730', report_key: key, source: 'pulse' });
    expect(st).toEqual({ kind: 'pulse', state: 'shadowbanned' });
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

  test('suppressMirrorReport upserts into report_moderation', async () => {
    const { mod, calls } = loadFlaggedApi(() => ok(null));
    await mod.suppressMirrorReport({}, { flagId: 5, appId: '730', reportKey: 'k', source: 'protondb', action: 'shadowban' });
    expect(calls[0].url).toContain('/report_moderation');
    // must name the unique key so a second action upserts instead of 409ing
    expect(calls[0].url).toContain('on_conflict=app_id,report_key,source');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers.Prefer).toContain('merge-duplicates');
    expect(JSON.parse(calls[0].opts.body)).toMatchObject({ app_id: '730', source: 'protondb', action: 'shadowban', flag_id: 5 });
  });

  test('unsuppressMirrorReport deletes the suppression by key', async () => {
    const { mod, calls } = loadFlaggedApi(() => ok(null));
    await mod.unsuppressMirrorReport({}, { appId: '730', reportKey: 'k', source: 'protondb' });
    expect(calls[0].opts.method).toBe('DELETE');
    expect(calls[0].url).toContain('report_key=eq.k');
  });

  test('admin handler routes Pulse to DB and mirror reports to suppression', () => {
    expect(adminMainSrc).toContain("action === 'flag-shadowban'");
    expect(adminMainSrc).toContain('findPulseConfigId(currentSession, flag.app_id, flag.report_key)');
    expect(adminMainSrc).toContain('suppressMirrorReport(currentSession');
    expect(adminMainSrc).toContain('unsuppressMirrorReport(currentSession, ref)');
    expect(adminMainSrc).toContain("updateFlagStatus(currentSession, id, 'complete')");
  });
});
