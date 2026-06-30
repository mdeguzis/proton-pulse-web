/**
 * Tests for #141: editing a published or pending report invalidates the
 * report_approvals row so the next pipeline pass treats it as a fresh
 * approval against the new content.
 *
 * Two code paths edit user_configs:
 *   1) js/shared/submit.js submitReport()    -- PATCH with editReportId set
 *   2) js/profile/api/configs.js patchUserConfig() -- profile My Reports modal
 *
 * Both must DELETE the matching report_approvals row after a successful PATCH.
 * A failed DELETE must NOT bubble up -- the live computeHash mismatch already
 * surfaces edits as pending, so cleanup is best-effort.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripModuleSyntax } = require('./_esm-vm.js');

const SUBMIT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'shared', 'submit.js'),
  'utf8'
);
const CONFIGS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'profile', 'api', 'configs.js'),
  'utf8'
);

describe('invalidateReportApproval helper (submit.js)', () => {
  function loadSubmitHelper(fetchImpl) {
    const SCORING_SRC = fs.readFileSync(
      path.join(__dirname, '..', 'js', 'shared', 'scoring.js'),
      'utf8'
    );
    const GPU_ARCH_SRC = fs.readFileSync(
      path.join(__dirname, '..', 'js', 'lib', 'gpu-arch-detector.js'),
      'utf8'
    );
    const ctx = {
      fetch: fetchImpl,
      SupaAuth: { getSession: () => null, onStateChange: () => {}, logout: () => {} },
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_ANON_KEY: 'test-anon-key',
      console,
      Promise, JSON, Object, Array, Number, String, Boolean, RegExp, Error,
      Map, Set, Date, Math,
      URL, URLSearchParams,
      setTimeout, clearTimeout,
      localStorage: { getItem: () => null, setItem: () => {} },
      navigator: { userAgent: '' },
      document: { getElementById: () => null, addEventListener: () => {} },
      addEventListener: () => {},
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(stripModuleSyntax(SCORING_SRC), ctx);
    vm.runInContext(stripModuleSyntax(GPU_ARCH_SRC), ctx);
    vm.runInContext(stripModuleSyntax(SUBMIT_SRC), ctx);
    return ctx;
  }

  test('DELETEs report_approvals?report_id=eq.<id> with auth header', async () => {
    const calls = [];
    const fetchImpl = jest.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    });
    const ctx = loadSubmitHelper(fetchImpl);
    const result = await ctx.invalidateReportApproval(
      'r-123',
      { access_token: 'tok_abc' }
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/report_approvals?report_id=eq.r-123');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok_abc');
  });

  test('returns skipped without firing fetch when reportId missing', async () => {
    const fetchImpl = jest.fn();
    const ctx = loadSubmitHelper(fetchImpl);
    const result = await ctx.invalidateReportApproval(null, { access_token: 'tok' });
    expect(result).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('returns skipped without firing fetch when session missing access_token', async () => {
    const fetchImpl = jest.fn();
    const ctx = loadSubmitHelper(fetchImpl);
    const result = await ctx.invalidateReportApproval('r-1', {});
    expect(result).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does not throw when DELETE returns non-ok', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 404 }));
    const ctx = loadSubmitHelper(fetchImpl);
    const result = await ctx.invalidateReportApproval('r-1', { access_token: 'tok' });
    expect(result).toEqual({ ok: false, status: 404 });
  });

  test('does not throw when fetch itself rejects (network error)', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('offline'); });
    const ctx = loadSubmitHelper(fetchImpl);
    const result = await ctx.invalidateReportApproval('r-1', { access_token: 'tok' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/offline/);
  });

  test('encodes special chars in reportId for the URL', async () => {
    const calls = [];
    const fetchImpl = jest.fn(async (url) => { calls.push(url); return { ok: true }; });
    const ctx = loadSubmitHelper(fetchImpl);
    await ctx.invalidateReportApproval('weird/id?bad', { access_token: 'tok' });
    expect(calls[0]).toContain('weird%2Fid%3Fbad');
  });
});

describe('submit.js source shape (#141 regression guards)', () => {
  test('edit PATCH path calls invalidateReportApproval after success', () => {
    // Pin the call order: only invalidate when PATCH was OK and we have an id.
    // A future refactor that drops the invalidation, or moves it before the
    // PATCH (where a failed write would orphan us into a dirty state), will
    // trip this guard.
    const idx_ok = SUBMIT_SRC.indexOf('if (r.ok) {');
    expect(idx_ok).toBeGreaterThan(0);
    const tail = SUBMIT_SRC.slice(idx_ok, idx_ok + 600);
    expect(tail).toContain('if (isEdit)');
    expect(tail).toContain('invalidateReportApproval(editReportId, session)');
  });

  test('helper targets the report_approvals table by report_id', () => {
    expect(SUBMIT_SRC).toContain('/report_approvals?report_id=eq.');
    expect(SUBMIT_SRC).toContain("method: 'DELETE'");
  });
});

describe('patchUserConfig source shape (#141)', () => {
  test('PATCH success is followed by DELETE on report_approvals', () => {
    // Verify the success path: throw on non-ok, then DELETE. The DELETE
    // is wrapped in try/catch so a transient failure does not poison the
    // save success the caller already saw.
    const idx = CONFIGS_SRC.indexOf('export async function patchUserConfig');
    expect(idx).toBeGreaterThan(0);
    const fn = CONFIGS_SRC.slice(idx, idx + 1000);
    expect(fn).toContain('throw new Error(`Update failed: HTTP ${r.status}`)');
    expect(fn).toContain('/report_approvals?report_id=eq.');
    expect(fn).toContain("method: 'DELETE'");
    expect(fn).toContain('try {');
    expect(fn).toContain('} catch');
  });

  test('DELETE happens AFTER the PATCH success check, not before', () => {
    // If we DELETEd before knowing PATCH succeeded, a failed write would
    // leave a deleted approval row alongside an unchanged user_configs row.
    const fn = CONFIGS_SRC.slice(
      CONFIGS_SRC.indexOf('export async function patchUserConfig'),
      CONFIGS_SRC.indexOf('export async function patchUserConfig') + 1000
    );
    const patchIdx = fn.indexOf("method: 'PATCH'");
    const deleteIdx = fn.indexOf("method: 'DELETE'");
    expect(patchIdx).toBeGreaterThan(0);
    expect(deleteIdx).toBeGreaterThan(patchIdx);
  });
});
