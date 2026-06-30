/**
 * Tests for #146: Approve / Deny on the All Reports detail panel for
 * currently-pending rows, plus the admin-link-btn link styling fix.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN_SRC      = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'main.js'), 'utf8');
const ALLREPS_CMP   = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'components', 'allReports.js'), 'utf8');
const ADMIN_CSS     = fs.readFileSync(path.join(ROOT, 'css', 'admin', 'admin.css'), 'utf8');

describe('All Reports table row buttons (#146)', () => {
  test('actionBtns now accepts isP and adds Approve + Deny when pending', () => {
    expect(ALLREPS_CMP).toContain('function actionBtns(id, isF, isH, isP)');
    const fn = ALLREPS_CMP.slice(
      ALLREPS_CMP.indexOf('function actionBtns'),
      ALLREPS_CMP.indexOf('function actionBtns') + 1500
    );
    expect(fn).toContain('if (isP)');
    expect(fn).toContain('data-action="ar-approve"');
    expect(fn).toContain('>Approve<');
    expect(fn).toContain('data-action="ar-deny"');
    expect(fn).toContain('>Deny<');
  });

  test('Approve + Deny never render when row is flagged or hidden', () => {
    // Flagged/hidden rows go to Release; pending-only branch stays out.
    const fn = ALLREPS_CMP.slice(
      ALLREPS_CMP.indexOf('function actionBtns'),
      ALLREPS_CMP.indexOf('function actionBtns') + 1500
    );
    const flaggedBlock = fn.slice(fn.indexOf('if (isH || isF)'), fn.indexOf('if (isP)'));
    expect(flaggedBlock).toContain('data-action="ar-release"');
    expect(flaggedBlock).not.toContain('data-action="ar-approve"');
    expect(flaggedBlock).not.toContain('data-action="ar-deny"');
  });

  test('row template passes is_pending through to actionBtns', () => {
    expect(ALLREPS_CMP).toContain('actionBtns(r.id, r.is_flagged, r.is_hidden, r.is_pending)');
  });

  test('updateAllReportsRow accepts optional isPending and rewrites buttons', () => {
    expect(ALLREPS_CMP).toContain('export function updateAllReportsRow(id, isF, isH, flaggedReason, isPending)');
    expect(ALLREPS_CMP).toContain('actionBtns(id, isF, isH, isP)');
  });
});

describe('All Reports detail panel buttons (#146)', () => {
  test('renders Approve + Deny in the action row when pending', () => {
    expect(ALLREPS_CMP).toContain('pendingButtons');
    const block = ALLREPS_CMP.slice(
      ALLREPS_CMP.indexOf('const pendingButtons = isP'),
      ALLREPS_CMP.indexOf('const pendingButtons = isP') + 600
    );
    expect(block).toContain('data-action="ar-approve"');
    expect(block).toContain('data-action="ar-deny"');
  });

  test('action delegate whitelist now includes ar-approve and ar-deny', () => {
    expect(ALLREPS_CMP).toContain("['ar-flag','ar-hide','ar-release','ar-approve','ar-deny']");
  });

  test('detail status badge passes flagged_reason for the tooltip', () => {
    expect(ALLREPS_CMP).toContain('statusBadges(isF, isH, isP, report.flagged_reason)');
  });
});

describe('main.js handlers for ar-approve / ar-deny (#146)', () => {
  test('imports approveReport from api/pending.js', () => {
    expect(MAIN_SRC).toContain("import { approveReport } from './api/pending.js");
  });

  test('detail-panel onAction handles ar-approve via approveReport(currentSession, report)', () => {
    // The detail panel already has the full report in scope, so it can
    // approve directly without an extra fetch.
    expect(MAIN_SRC).toMatch(/action === 'ar-approve'[\s\S]{0,400}approveReport\(currentSession, report\)/);
  });

  test('detail-panel onAction handles ar-deny with promptFlagReason + patchReportFlags', () => {
    const block = MAIN_SRC.slice(
      MAIN_SRC.indexOf("} else if (action === 'ar-deny')"),
      MAIN_SRC.indexOf("} else if (action === 'ar-deny')") + 800
    );
    expect(block).toContain('promptFlagReason(action)');
    expect(block).toContain('is_flagged: true');
    expect(block).toContain('is_hidden: true');
    expect(block).toContain("'denied: ' + reason");
  });

  test('row-click handler fetches the full row before approving', () => {
    // The row click handler does not have the full record in scope, so
    // it has to fetch by id first and pass that to approveReport. Use
    // lastIndexOf to land on the row-click block (the detail panel
    // block appears earlier in main.js).
    const rowApproveIdx = MAIN_SRC.lastIndexOf("if (action === 'ar-approve') {");
    const block = MAIN_SRC.slice(rowApproveIdx, rowApproveIdx + 800);
    expect(block).toContain('await fetchReportById(currentSession, rid)');
    expect(block).toContain('await approveReport(currentSession, full)');
  });

  test('row-click handler ar-deny uses promptFlagReason and patches the row', () => {
    const rowDenyIdx = MAIN_SRC.lastIndexOf("if (action === 'ar-deny') {");
    const block = MAIN_SRC.slice(rowDenyIdx, rowDenyIdx + 800);
    expect(block).toContain('promptFlagReason(action)');
    expect(block).toContain("'denied: ' + reason");
    expect(block).toContain('updateAllReportsRow(rid, true, true');
  });

  test('approve flips the row out of pending state via updateAllReportsRow(..., false)', () => {
    // Pin the fifth argument so the row buttons re-render without
    // Approve/Deny (which only show when isP is truthy).
    const rowApproveIdx = MAIN_SRC.lastIndexOf("if (action === 'ar-approve') {");
    const block = MAIN_SRC.slice(rowApproveIdx, rowApproveIdx + 800);
    expect(block).toMatch(/updateAllReportsRow\(rid, false, false, null, false\)/);
  });
});

describe('admin-link-btn link styling fix', () => {
  test('admin-link-btn sets cursor: pointer', () => {
    expect(ADMIN_CSS).toMatch(/\.admin-link-btn \{[\s\S]{0,400}cursor: pointer/);
  });

  test('admin-link-btn strips default button chrome', () => {
    const block = ADMIN_CSS.slice(
      ADMIN_CSS.indexOf('.admin-link-btn {'),
      ADMIN_CSS.indexOf('.admin-link-btn {') + 400
    );
    expect(block).toContain('background: none');
    expect(block).toContain('border: 0');
    expect(block).toContain('padding: 0');
  });

  test('admin-link-btn underlines on hover so it reads as a link', () => {
    expect(ADMIN_CSS).toMatch(/\.admin-link-btn:hover \{ text-decoration: underline/);
  });

  test('admin-link-btn keeps a visible focus ring for keyboard users', () => {
    expect(ADMIN_CSS).toContain('.admin-link-btn:focus-visible');
    expect(ADMIN_CSS).toMatch(/\.admin-link-btn:focus-visible \{[\s\S]{0,400}outline:/);
  });
});
