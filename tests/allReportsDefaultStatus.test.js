/**
 * Tests that the All Reports tab defaults the status filter to "pending"
 * instead of "clean". Admins land on the work-to-do view first, not the
 * already-approved firehose.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADMIN_HTML  = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const ALLREPS_CMP = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'components', 'allReports.js'), 'utf8');

describe('All Reports status filter default', () => {
  test('admin.html marks the Pending approval option as selected', () => {
    expect(ADMIN_HTML).toMatch(/<option value="pending" selected>Pending approval<\/option>/);
  });

  test('admin.html does NOT mark Approved (clean) as selected', () => {
    expect(ADMIN_HTML).not.toMatch(/<option value="clean" selected>/);
  });

  test('JS fallback when the select is missing also defaults to pending', () => {
    // Defensive: even if the option markup gets stripped, the JS picks
    // up the pending bucket so admins still see actionable work.
    expect(ALLREPS_CMP).toContain("statusEl ? statusEl.value : 'pending'");
  });
});
