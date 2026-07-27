/**
 * Editing a currently-published report (#144, reworked in the #389 batch).
 *
 * The original #144 behavior was a window.confirm() popup before the form
 * loaded. Per review, the popup is gone: the re-approval consequence now
 * rides in the 30-day edit-window notice as an extra line, shown only when
 * the report actually has an approval row. These pins keep the pre-check
 * wiring alive and the popup dead.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'submit', 'main.js'),
  'utf8'
);

describe('submit.html ?edit= flow: published-report notice (no popup)', () => {
  test('still pre-checks report_approvals before the prefill fetch', () => {
    const approvalIdx = SRC.indexOf('report_approvals?report_id=eq.${editReportId}&select=approval_hash');
    const prefillIdx = SRC.indexOf('user_configs?id=eq.${encodeURIComponent(editReportId)}&select=*');
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(prefillIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeLessThan(prefillIdx);
  });

  test('the confirm() popup is gone for good', () => {
    expect(SRC).not.toContain('window.confirm(');
    expect(SRC).not.toContain('Continue?');
  });

  test('published state feeds the edit-window notice instead', () => {
    expect(SRC).toContain('window.__editReportIsPublished = preCheckRows.length > 0');
    expect(SRC).toContain('back into <strong>pending review</strong> until the daily pipeline re-approves it.');
    expect(SRC).toContain("window.__editReportIsPublished ? '<div class=\"sew-line\">");
  });

  test('the pre-check stays best-effort (a network blip must not block editing)', () => {
    expect(SRC).toContain('// Approval pre-check is best-effort');
    expect(SRC).toContain('[submit] edit pre-check failed:');
  });

  test('non-edit submissions never call the pre-check fetch', () => {
    const guardIdx = SRC.indexOf('if (isEdit && session)');
    const preCheckIdx = SRC.indexOf('report_approvals?report_id=eq.${editReportId}');
    expect(guardIdx).toBeGreaterThan(0);
    expect(preCheckIdx).toBeGreaterThan(guardIdx);
  });
});
