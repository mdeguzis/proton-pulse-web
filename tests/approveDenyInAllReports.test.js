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
const ADMIN_HTML    = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

describe('All Reports table row layout (#148 follow-up: Actions column removed)', () => {
  test('actionBtns function and ar-actions cell are gone (actions live in detail only)', () => {
    expect(ALLREPS_CMP).not.toContain('function actionBtns');
    expect(ALLREPS_CMP).not.toContain('class="ar-actions"');
  });

  test('row template still emits #NNN, app link, title, source, store, user, date, status', () => {
    // 8 <td> cells per row, no Actions cell at the end.
    const rowTmpl = ALLREPS_CMP.slice(
      ALLREPS_CMP.indexOf('return `<tr data-rid='),
      ALLREPS_CMP.indexOf('return `<tr data-rid=') + 1200
    );
    expect((rowTmpl.match(/<td/g) || []).length).toBe(8);
    expect(rowTmpl).toContain('ar-status');
    expect(rowTmpl).not.toContain('ar-actions');
  });

  test('all-reports-table thead drops the Actions <th>', () => {
    // Other admin tables (flagged, banned, etc.) still have Actions; only
    // the All Reports table loses the column.
    const start = ADMIN_HTML.indexOf('id="all-reports-table"');
    const end = ADMIN_HTML.indexOf('</thead>', start);
    const arHead = ADMIN_HTML.slice(start, end);
    expect(arHead).not.toMatch(/<th>Actions<\/th>/);
  });

  test('updateAllReportsRow no longer touches an actions cell', () => {
    expect(ALLREPS_CMP).toContain('export function updateAllReportsRow(id, isF, isH, flaggedReason, isPending)');
    expect(ALLREPS_CMP).not.toContain("row.querySelector('.ar-actions')");
  });
});

describe('All Reports detail panel toolbar (#146 + #148)', () => {
  test('renders the full toolbar via a btn() helper, not contextual subsets', () => {
    // #148: every report shows the same five buttons; disabled state is
    // what changes by row state. A regression to the old "only show
    // valid buttons" pattern would silently shrink the toolbar again.
    expect(ALLREPS_CMP).toContain('const btn = (action, label, kind, disabled, disabledTitle)');
    const block = ALLREPS_CMP.slice(
      ALLREPS_CMP.indexOf('const actionHtml = ['),
      ALLREPS_CMP.indexOf('const actionHtml = [') + 800
    );
    expect(block).toContain("btn('ar-approve', 'Approve'");
    expect(block).toContain("btn('ar-deny',    'Deny'");
    expect(block).toContain("btn('ar-flag',    'Flag'");
    expect(block).toContain("btn('ar-hide',    'Hide'");
    expect(block).toContain("btn('ar-release', 'Release'");
  });

  test('Approve/Deny disabled when row is not pending', () => {
    // disabled flag passed to btn() is `!isP || isF || isH`.
    const block = ALLREPS_CMP.slice(
      ALLREPS_CMP.indexOf('const actionHtml = ['),
      ALLREPS_CMP.indexOf('const actionHtml = [') + 1000
    );
    expect(block).toMatch(/btn\('ar-approve'[\s\S]{0,200}!isP \|\| isF \|\| isH/);
    expect(block).toMatch(/btn\('ar-deny'[\s\S]{0,200}!isP \|\| isF \|\| isH/);
  });

  test('Flag disabled when already flagged, Hide disabled when already hidden', () => {
    const block = ALLREPS_CMP.slice(
      ALLREPS_CMP.indexOf('const actionHtml = ['),
      ALLREPS_CMP.indexOf('const actionHtml = [') + 1000
    );
    expect(block).toMatch(/btn\('ar-flag'[\s\S]{0,200},\s*isF,\s*'Already flagged'/);
    expect(block).toMatch(/btn\('ar-hide'[\s\S]{0,200},\s*isH,\s*'Already hidden'/);
  });

  test('Release disabled when nothing to release', () => {
    const block = ALLREPS_CMP.slice(
      ALLREPS_CMP.indexOf('const actionHtml = ['),
      ALLREPS_CMP.indexOf('const actionHtml = [') + 1000
    );
    expect(block).toMatch(/btn\('ar-release'[\s\S]{0,200},\s*!\(isF \|\| isH\),\s*'Nothing to release'/);
  });

  test('toolbar lives in the top-right via .ar-detail-header / .ar-detail-actions', () => {
    expect(ALLREPS_CMP).toContain('class="ar-detail-header"');
    expect(ALLREPS_CMP).toContain('class="ar-detail-actions"');
  });

  test('click delegate ignores clicks on disabled buttons', () => {
    expect(ALLREPS_CMP).toContain('if (btn.disabled) return');
  });

  test('action delegate whitelist still includes ar-approve and ar-deny', () => {
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

  test('row-click handler exposes only ar-view-detail now', () => {
    // The Actions column is gone (#148 follow-up). Row clicks only navigate
    // to detail; all moderation actions live inside the detail toolbar.
    const tbodyClickIdx = MAIN_SRC.indexOf("document.getElementById('all-reports-tbody').addEventListener('click'");
    const block = MAIN_SRC.slice(tbodyClickIdx, tbodyClickIdx + 1200);
    expect(block).toContain("action === 'ar-view-detail'");
    expect(block).not.toContain("action === 'ar-flag'");
    expect(block).not.toContain("action === 'ar-hide'");
    expect(block).not.toContain("action === 'ar-release'");
    expect(block).not.toContain("action === 'ar-approve'");
    expect(block).not.toContain("action === 'ar-deny'");
  });
});

describe('Report detail header layout (#148)', () => {
  test('.ar-detail-header is a flex row that pushes the toolbar right', () => {
    expect(ADMIN_CSS).toContain('.ar-detail-header {');
    const block = ADMIN_CSS.slice(
      ADMIN_CSS.indexOf('.ar-detail-header {'),
      ADMIN_CSS.indexOf('.ar-detail-header {') + 400
    );
    expect(block).toContain('display: flex');
    expect(block).toContain('justify-content: space-between');
  });

  test('.ar-detail-actions wraps on narrow viewports so buttons stay visible', () => {
    expect(ADMIN_CSS).toContain('.ar-detail-actions {');
    const block = ADMIN_CSS.slice(
      ADMIN_CSS.indexOf('.ar-detail-actions {'),
      ADMIN_CSS.indexOf('.ar-detail-actions {') + 300
    );
    expect(block).toContain('flex-wrap: wrap');
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
