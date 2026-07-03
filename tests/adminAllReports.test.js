const { loadEsm } = require('./_esm-vm.js');

function makeSession() {
  return { access_token: 'tok', user: { id: 'uid' } };
}

// Default approval mock: empty list (every row reads as pending). Tests that
// care about approval state override `approvalsImpl`.
function loadApi(fetchImpl, { approvalsImpl } = {}) {
  const calls = [];
  const ctx = {
    SUPABASE_URL: 'https://sb.example',
    supabaseHeaders: (s, extra = {}) => ({ Authorization: 'Bearer tok', apikey: 'anon', ...extra }),
    fetch: (url, opts) => {
      calls.push({ url, opts });
      if (url.includes('/report_approvals')) {
        const impl = approvalsImpl || (() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));
        return impl(url, opts);
      }
      return fetchImpl(url, opts);
    },
  };
  loadEsm(['js/admin/api/allReports.js'], ctx);
  return { ctx, calls };
}

describe('fetchAllReports', () => {
  test('fetches user_configs ordered by created_at desc, defaults to clean', async () => {
    const rows = [{ id: 1, app_id: '730', title: 'Counter-Strike 2', rating: 'platinum', source: 'pulse', created_at: '2025-01-01T00:00:00Z' }];
    const { ctx, calls } = loadApi(
      () => Promise.resolve({ ok: true, json: () => Promise.resolve(rows) }),
      { approvalsImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve([{ report_id: 1 }]) }) },
    );

    const result = await ctx.fetchAllReports(makeSession());

    expect(result).toEqual([{ ...rows[0], is_pending: false }]);
    const userCfgCall = calls.find(c => c.url.includes('/user_configs'));
    expect(userCfgCall).toBeTruthy();
    expect(userCfgCall.url).toContain('order=created_at.desc');
    expect(userCfgCall.url).toContain('is_flagged=eq.false');
    expect(calls.some(c => c.url.includes('/report_approvals'))).toBe(true);
  });

  test('clean status filters out reports without an approval row', async () => {
    const rows = [
      { id: 1, app_id: '730', title: 'Approved game', created_at: '2025-01-01' },
      { id: 2, app_id: '731', title: 'Pending game',  created_at: '2025-01-02' },
    ];
    const { ctx } = loadApi(
      () => Promise.resolve({ ok: true, json: () => Promise.resolve(rows) }),
      { approvalsImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve([{ report_id: 1 }]) }) },
    );

    const result = await ctx.fetchAllReports(makeSession(), { status: 'clean' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
    expect(result[0].is_pending).toBe(false);
  });

  test('pending status keeps only reports without an approval row', async () => {
    const rows = [
      { id: 1, app_id: '730', created_at: '2025-01-01' },
      { id: 2, app_id: '731', created_at: '2025-01-02' },
    ];
    const { ctx } = loadApi(
      () => Promise.resolve({ ok: true, json: () => Promise.resolve(rows) }),
      { approvalsImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve([{ report_id: 1 }]) }) },
    );

    const result = await ctx.fetchAllReports(makeSession(), { status: 'pending' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
    expect(result[0].is_pending).toBe(true);
  });

  test('applies date range filter when provided', async () => {
    const { ctx, calls } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    await ctx.fetchAllReports(makeSession(), { dateFrom: '2025-01-01', dateTo: '2025-06-30' });

    expect(calls[0].url).toContain('created_at=gte.');
    expect(calls[0].url).toContain('created_at=lte.');
  });

  test('appends search filter when query is provided', async () => {
    const { ctx, calls } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    await ctx.fetchAllReports(makeSession(), { search: '730' });

    expect(calls[0].url).toContain('or=');
    expect(calls[0].url).toContain('730');
  });

  test('filters by flagged status', async () => {
    const { ctx, calls } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    await ctx.fetchAllReports(makeSession(), { status: 'flagged' });

    expect(calls[0].url).toContain('is_flagged=eq.true');
  });

  test('filters by hidden status', async () => {
    const { ctx, calls } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    await ctx.fetchAllReports(makeSession(), { status: 'hidden' });

    expect(calls[0].url).toContain('is_hidden=eq.true');
  });

  test('filters by clean status', async () => {
    const { ctx, calls } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    await ctx.fetchAllReports(makeSession(), { status: 'clean' });

    expect(calls[0].url).toContain('is_flagged=eq.false');
    expect(calls[0].url).toContain('is_hidden=eq.false');
  });

  test('throws when response is not ok', async () => {
    const { ctx } = loadApi(() => Promise.resolve({ ok: false, status: 403 }));

    await expect(ctx.fetchAllReports(makeSession())).rejects.toThrow('403');
  });
});

describe('fetchReportById', () => {
  test('fetches a single report by id from user_configs', async () => {
    const report = { id: 42, app_id: '730', title: 'Counter-Strike 2', is_flagged: false, is_hidden: false };
    const { ctx, calls } = loadApi(
      () => Promise.resolve({ ok: true, json: () => Promise.resolve([report]) }),
      { approvalsImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve([{ report_id: 42 }]) }) },
    );

    const result = await ctx.fetchReportById(makeSession(), '42');

    expect(result).toEqual({ ...report, is_pending: false });
    const userCfgCall = calls.find(c => c.url.includes('/user_configs'));
    expect(userCfgCall.url).toContain('id=eq.42');
    expect(calls.some(c => c.url.includes('/report_approvals') && c.url.includes('report_id=eq.42'))).toBe(true);
  });

  test('marks report as pending when no approval row exists', async () => {
    const report = { id: 42, app_id: '730', title: 'Counter-Strike 2', is_flagged: false, is_hidden: false };
    const { ctx } = loadApi(
      () => Promise.resolve({ ok: true, json: () => Promise.resolve([report]) }),
      { approvalsImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) },
    );

    const result = await ctx.fetchReportById(makeSession(), '42');

    expect(result.is_pending).toBe(true);
  });

  test('throws when report is not found', async () => {
    const { ctx } = loadApi(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    await expect(ctx.fetchReportById(makeSession(), '99')).rejects.toThrow('Report not found');
  });

  test('throws when response is not ok', async () => {
    const { ctx } = loadApi(() => Promise.resolve({ ok: false, status: 403 }));

    await expect(ctx.fetchReportById(makeSession(), '1')).rejects.toThrow('403');
  });
});

describe('patchReportFlags', () => {
  test('sends PATCH to user_configs with correct id filter', async () => {
    const { ctx, calls } = loadApi(() => Promise.resolve({ ok: true }));

    await ctx.patchReportFlags(makeSession(), '42', { is_flagged: true });

    expect(calls[0].url).toContain('user_configs');
    expect(calls[0].url).toContain('id=eq.42');
    expect(calls[0].opts.method).toBe('PATCH');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ is_flagged: true });
  });

  test('throws when PATCH fails', async () => {
    const { ctx } = loadApi(() => Promise.resolve({ ok: false, status: 403 }));

    await expect(ctx.patchReportFlags(makeSession(), '1', { is_hidden: true })).rejects.toThrow('403');
  });
});

describe('fetchStatusCounts', () => {
  const withCount = (n) => Promise.resolve({
    ok: true,
    headers: { get: () => `0-0/${n}` },
    json: () => Promise.resolve([]),
  });

  test('uses the exact RPC when available', async () => {
    const { ctx } = loadApi((url) => {
      if (url.includes('/rpc/get_report_status_counts')) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => null },
          json: () => Promise.resolve([{ total: 7, flagged: 1, hidden: 2, approved: 3, pending: 1 }]),
        });
      }
      throw new Error('count queries must not run when the RPC succeeds');
    });
    const c = await ctx.fetchStatusCounts(makeSession());
    expect(c).toEqual({ total: 7, flagged: 1, hidden: 2, approved: 3, pending: 1 });
  });

  test('falls back to count=exact queries when the RPC returns no row', async () => {
    const userTotals = (url) => {
      if (url.includes('is_flagged=eq.true')) return 3;
      if (url.includes('is_hidden=eq.true')) return 2;
      if (url.includes('is_flagged=eq.false&is_hidden=eq.false')) return 100; // clean
      return 105; // total (no status filter)
    };
    const { ctx, calls } = loadApi(
      (url) => withCount(userTotals(url)),
      { approvalsImpl: () => withCount(90) },
    );

    const c = await ctx.fetchStatusCounts(makeSession());
    expect(c.total).toBe(105);
    expect(c.flagged).toBe(3);
    expect(c.hidden).toBe(2);
    expect(c.pending).toBe(10);    // clean 100 - approvals 90
    expect(c.approved).toBe(90);
    expect(calls.some((x) => x.opts && x.opts.headers && x.opts.headers.Prefer === 'count=exact')).toBe(true);
  });
});

describe('Reports admin wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const COMP = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'components', 'allReports.js'), 'utf8');

  test('standalone Flagged Reports menu option is removed (covered by Reports filter)', () => {
    expect(HTML).not.toContain('<option value="flagged">Flagged Reports</option>');
    // the Reports panel still has a "Flagged" status filter
    expect(HTML).toContain('<option value="flagged">Flagged</option>');
  });

  test('Reports panel renders a clickable per-status count strip', () => {
    expect(HTML).toContain('id="all-reports-status-counts"');
    expect(COMP).toContain('fetchStatusCounts');
    expect(COMP).toContain('class="admin-stat');
    expect(COMP).toContain("statusEl.value = btn.dataset.status");
  });
});
