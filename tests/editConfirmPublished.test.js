/**
 * Tests for #144: confirm dialog when editing a currently-published report
 * via the submit.html ?edit= entry path.
 *
 * Source-shape only -- submit/main.js is a top-level page entry IIFE that
 * touches the DOM, the Supabase client, and the auth flow. Behavioral tests
 * here are scoped to pinning the order of operations and the bail-out, since
 * a regression would silently re-introduce the issue.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'submit', 'main.js'),
  'utf8'
);

describe('submit.html ?edit= flow: confirm before editing a published report', () => {
  test('fetches report_approvals BEFORE user_configs prefill', () => {
    // Order matters: if we prefill first, the user briefly sees their
    // editable form before being prompted. Cancel-then-bounce only makes
    // sense if the prompt happens first.
    const preCheckIdx = SRC.indexOf('report_approvals?report_id=eq.${editReportId}&select=approval_hash');
    const userConfigsIdx = SRC.indexOf('user_configs?id=eq.${encodeURIComponent(editReportId)}&select=*');
    expect(preCheckIdx).toBeGreaterThan(0);
    expect(userConfigsIdx).toBeGreaterThan(0);
    expect(preCheckIdx).toBeLessThan(userConfigsIdx);
  });

  test('prompts via window.confirm when an approval row exists', () => {
    expect(SRC).toContain('window.confirm(');
    // Pin the message intent (re-review wording) without locking the exact
    // copy -- humanizer rules may tweak phrasing later.
    expect(SRC).toMatch(/currently published/);
    expect(SRC).toMatch(/pending review/);
  });

  test('bounces to returnTo or game page when user cancels', () => {
    // The cancel path must redirect somewhere safe (the same destination
    // a successful save would use), not just return into the prefill code.
    // Widened from 200 to 400 chars to accommodate the nosemgrep suppression
    // comment that lives on the same line as the location.href assignment.
    const cancelBlock = SRC.slice(
      SRC.indexOf('if (!proceed)'),
      SRC.indexOf('if (!proceed)') + 400
    );
    expect(cancelBlock).toContain('returnTo || `app.html#/app/${appId}`');
    expect(cancelBlock).toContain('window.location.href = dest');
    expect(cancelBlock).toContain('return;');
  });

  test('pre-check failure does not block the edit flow', () => {
    // Network blip on the approval table should not strand the user.
    // The catch logs a warning and falls through to the existing prefill +
    // banner, which will still show the right status once it loads.
    const block = SRC.slice(
      SRC.indexOf('// #144:'),
      SRC.indexOf('const r = await fetch')
    );
    expect(block).toContain('catch');
    expect(block).toContain("[submit] edit pre-check failed:");
  });

  test('non-edit submissions never call the pre-check fetch', () => {
    // The pre-check sits inside the `if (isEdit && session)` guard. A
    // brand-new report (no editReportId) must never trigger the dialog.
    const guardIdx = SRC.indexOf('if (isEdit && session)');
    const preCheckIdx = SRC.indexOf('// #144:');
    expect(guardIdx).toBeGreaterThan(0);
    expect(preCheckIdx).toBeGreaterThan(guardIdx);
  });

  test('pending reports (no approval row) skip the prompt', () => {
    // The prompt only fires when preCheckRows.length > 0 (approval exists).
    // Pending reports already invisible to the public should not double-warn.
    expect(SRC).toContain('const isCurrentlyPublished = preCheckRows.length > 0');
    expect(SRC).toContain('if (isCurrentlyPublished)');
  });
});
