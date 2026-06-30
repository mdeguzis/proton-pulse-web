/**
 * Tests for #150: user detail Reports section now uses the same row
 * structure as the All Reports table (Report ID | App | Title | Source
 * | Store | Submitted | Status), plus a user-detail-specific Actions
 * cell carrying Edit / Hide / Delete.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UD_CMP    = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'components', 'userDetail.js'), 'utf8');
const UD_API    = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'userDetail.js'), 'utf8');
const MAIN_SRC  = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'main.js'), 'utf8');

describe('user detail Reports row template (#150)', () => {
  test('column headers match All Reports (minus User) plus a trailing Actions', () => {
    expect(UD_CMP).toContain(
      '<th>Report ID</th><th>App</th><th>Title</th><th>Source</th><th>Store</th><th>Submitted</th><th>Status</th><th>Actions</th>'
    );
  });

  test('first cell is the link-styled #NNN button that opens report detail', () => {
    expect(UD_CMP).toContain('<button class="admin-link-btn" data-action="ar-view-detail" data-rid="${id}">#${id}</button>');
  });

  test('app cell is an admin-link to the public game page', () => {
    expect(UD_CMP).toContain('class="admin-link" href="app.html#/app/${appId}');
  });

  test('status badges reuse the admin-badge palette (warn / muted / info)', () => {
    expect(UD_CMP).toContain('admin-badge--warn');
    expect(UD_CMP).toContain('admin-badge--muted');
    expect(UD_CMP).toContain('admin-badge--info');
  });

  test('flagged_reason flows through to the badge title attribute', () => {
    expect(UD_CMP).toMatch(/title="\$\{escapeHtml\(String\(reason\)\)\}"/);
  });

  test('Edit / Hide / Delete actions still render in a trailing Actions cell', () => {
    expect(UD_CMP).toContain('data-action="edit-report"');
    expect(UD_CMP).toContain('data-action="hide-report"');
    expect(UD_CMP).toContain('data-action="delete-report"');
  });

  test('legacy Game/Rating/Proton/Date/Source/Flags header is gone', () => {
    expect(UD_CMP).not.toContain('<th>Game</th><th>Rating</th><th>Proton</th>');
    expect(UD_CMP).not.toContain('<th>Flags</th>');
  });
});

describe('user detail Reports API (#150)', () => {
  test('SELECT pulls flagged_reason + app_type + notes for the unified row', () => {
    const block = UD_API.slice(
      UD_API.indexOf('fetchUserReports'),
      UD_API.indexOf('fetchUserReports') + 800
    );
    expect(block).toContain('flagged_reason');
    expect(block).toContain('app_type');
    expect(block).toContain('notes');
  });
});

describe('user-detail click delegate forwards #NNN to report detail (#150)', () => {
  test('main.js user-detail handler picks up ar-view-detail and calls loadReportDetail', () => {
    const block = MAIN_SRC.slice(
      MAIN_SRC.indexOf("document.getElementById('user-detail-content').addEventListener('click'"),
      MAIN_SRC.indexOf("document.getElementById('user-detail-content').addEventListener('click'") + 2500
    );
    expect(block).toContain("action === 'ar-view-detail'");
    expect(block).toContain('loadReportDetail(rid)');
  });
});
