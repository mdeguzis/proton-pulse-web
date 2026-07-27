/**
 * #389: 30-day report edit window. Source-shape pins on the submit edit
 * flow: a countdown notice inside the window, a hard block past it that
 * routes corrections through moderation (delete or anonymize per the
 * Content-Moderation lifecycle contract).
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SUBMIT_MAIN = read('js/submit/main.js');
const MY_REPORTS = read('js/profile/components/my-reports.js');
const PROFILE_HTML = read('profile.html');
const ADMIN_ALL = read('js/admin/components/allReports.js');
const ADMIN_MAIN = read('js/admin/main.js');
const CSS = read('css/app/game-header.css');

describe('30-day edit window (#389)', () => {
  test('the window is 30 days, computed from the report created_at', () => {
    expect(SUBMIT_MAIN).toContain('const EDIT_WINDOW_DAYS = 30;');
    expect(SUBMIT_MAIN).toContain("Date.parse(rec.created_at)");
    expect(SUBMIT_MAIN).toMatch(/EDIT_WINDOW_DAYS - Math\.floor\(\(Date\.now\(\) - createdMs\) \/ 86400000\)/);
  });

  test('inside the window: a notice says how many days are left', () => {
    expect(SUBMIT_MAIN).toContain("left to edit.</strong>");
    expect(SUBMIT_MAIN).toMatch(/\$\{daysLeft\} day\$\{daysLeft !== 1 \? 's' : ''\}/);
    expect(SUBMIT_MAIN).toContain('submit-edit-window');
    // Countdown sits ABOVE the form, not instead of it.
    expect(SUBMIT_MAIN).toContain('formHost.parentNode.insertBefore(notice, formHost)');
  });

  test('past the window: the form is replaced with the moderation path', () => {
    expect(SUBMIT_MAIN).toContain('This report can no longer be edited.');
    expect(SUBMIT_MAIN).toContain('submit-edit-window--expired');
    expect(SUBMIT_MAIN).toContain('delete or anonymize');
    // Hard stop -- no form prefill happens after the expired branch.
    expect(SUBMIT_MAIN).toMatch(/submit-edit-window--expired[\s\S]{0,1400}return;/);
  });

  test('missing created_at fails open (edit allowed) rather than locking a fresh report', () => {
    expect(SUBMIT_MAIN).toMatch(/Number\.isFinite\(createdMs\)\s*\n?\s*\? EDIT_WINDOW_DAYS - [\s\S]{0,80}: EDIT_WINDOW_DAYS/);
  });

  test('notice styles exist for both states', () => {
    expect(CSS).toContain('.submit-edit-window {');
    expect(CSS).toContain('.submit-edit-window--expired {');
  });
});

describe('resubmit warning is inline, not a popup (#389 polish)', () => {
  test('the pending-review confirm() popup is gone', () => {
    expect(SUBMIT_MAIN).not.toContain('window.confirm(');
    expect(SUBMIT_MAIN).not.toContain('pending review until the daily pipeline re-approves it. Continue?');
  });

  test('the re-approval consequence rides in the edit-window notice', () => {
    expect(SUBMIT_MAIN).toContain('__editReportIsPublished');
    expect(SUBMIT_MAIN).toContain('back into pending review until the daily pipeline re-approves it.');
  });

  test('both notice states link to the User-Policies wiki page', () => {
    const links = SUBMIT_MAIN.match(/wiki\/User-Policies#report-editing/g) || [];
    expect(links.length).toBe(2);
  });
});

describe('profile locks actions past the window (#389)', () => {
  test('Edit / Delete / Unpublish render as locked buttons past 30 days', () => {
    expect(MY_REPORTS).toContain('const EDIT_WINDOW_DAYS = 30;');
    expect(MY_REPORTS).toContain('profile-configs-locked-btn');
    expect(MY_REPORTS).toMatch(/isLocked \? lockedBtn\('Edit'\)/);
    expect(MY_REPORTS).toMatch(/isLocked\s*\n?\s*\? lockedBtn\('Delete'\)/);
  });

  test('clicking a locked button explains and links the policy instead of acting', () => {
    expect(MY_REPORTS).toContain("closest('.profile-configs-locked-btn')");
    expect(MY_REPORTS).toContain('locked 30 days after submission');
    expect(MY_REPORTS).toContain('wiki/User-Policies#report-editing');
  });
});

describe('My Reports sort + date range (#389 batch)', () => {
  test('sort select offers newest / oldest / name', () => {
    expect(PROFILE_HTML).toContain('id="my-configs-sort"');
    expect(PROFILE_HTML).toContain('value="newest"');
    expect(PROFILE_HTML).toContain('value="oldest"');
    expect(PROFILE_HTML).toContain('value="name"');
    expect(PROFILE_HTML).toContain('id="my-configs-from"');
    expect(PROFILE_HTML).toContain('id="my-configs-to"');
  });

  test('filters wire into applySearch and undated rows stay visible', () => {
    expect(MY_REPORTS).toMatch(/sortMode === 'name'[\s\S]{0,120}localeCompare/);
    expect(MY_REPORTS).toContain("if (!d) return true;");
    expect(MY_REPORTS).toContain("['my-configs-sort', 'my-configs-from', 'my-configs-to']");
  });
});

describe('admin delete-or-anonymize (#398)', () => {
  test('the detail toolbar gains a Delete action', () => {
    expect(ADMIN_ALL).toContain("btn('ar-delete',  'Delete',  'danger'");
    expect(ADMIN_ALL).toContain("'ar-delete'].includes(action)");
  });

  test('delete asks DELETE vs ANON and calls admin_resolve_report', () => {
    expect(ADMIN_MAIN).toContain("Type DELETE to permanently remove");
    expect(ADMIN_MAIN).toContain("Type ANON to keep the data");
    expect(ADMIN_MAIN).toContain('/rest/v1/rpc/admin_resolve_report');
    expect(ADMIN_MAIN).toMatch(/normalized === 'DELETE' \? 'delete' : 'anonymize'/);
  });

  test('the SQL function enforces granular permissions and audits', () => {
    const SQL = read('supabase/migrations/20260726180000_admin_delete_or_anonymize_report.sql');
    expect(SQL).toContain("current_user_has_permission(v_permission)");
    expect(SQL).toMatch(/'delete' then 'delete_reports' else 'manage_reports'/);
    expect(SQL).toContain('admin_audit_log');
    expect(SQL).toContain("'anon_' || replace(gen_random_uuid()::text");
  });
});
