/**
 * Tests for #139: admin Users table renders the username as a clickable
 * detail link, and the Details button is dropped from the Actions column.
 *
 * Source-shape checks -- users.js is HTML-string heavy and tested end-to-
 * end via the same delegated click handler the rest of admin uses.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const USERS_SRC = fs.readFileSync(
  path.join(ROOT, 'js', 'admin', 'components', 'users.js'),
  'utf8'
);
const MAIN_SRC = fs.readFileSync(
  path.join(ROOT, 'js', 'admin', 'main.js'),
  'utf8'
);

describe('admin Users table: hyperlinked username (#139)', () => {
  test('renders username as an anchor with admin-link styling', () => {
    expect(USERS_SRC).toContain('class="admin-link admin-user-name-link"');
    expect(USERS_SRC).toMatch(/data-action="view-user-detail"[\s\S]{0,400}\$\{name\}<\/a>/);
  });

  test('username anchor carries the full user payload for the detail handler', () => {
    // Same data-userobj shape the old Details button had so the existing
    // dispatcher in admin/main.js keeps working without changes.
    expect(USERS_SRC).toContain("data-userobj='${userObj}'");
    expect(USERS_SRC).toMatch(/proton_pulse_user_id:.*r\.proton_pulse_user_id/);
    expect(USERS_SRC).toMatch(/client_id:.*r\.client_id/);
  });

  test('Details button has been removed from the row template', () => {
    // The old button rendered text "Details" inside an admin-btn--details.
    // Either pattern surviving means the refactor regressed.
    expect(USERS_SRC).not.toContain('admin-btn--details');
    expect(USERS_SRC).not.toMatch(/>Details<\/button>/);
  });

  test('actions column only renders banBtn now', () => {
    // The actions <td> previously concatenated detailsBtn + banBtn. The
    // new template renders ${banBtn} alone so Ban is the only control.
    expect(USERS_SRC).toMatch(/admin-col-actions">\$\{banBtn\}<\/td>/);
  });

  test('view-user-detail click handler preventDefaults the anchor', () => {
    // The trigger is now an <a href="#"> rather than a <button>, so the
    // delegated handler must stop the default # nav before routing.
    const block = MAIN_SRC.slice(
      MAIN_SRC.indexOf("// Users table actions (delegated)"),
      MAIN_SRC.indexOf("// User detail actions (delegated")
    );
    expect(block).toContain("if (action === 'view-user-detail')");
    expect(block).toContain('e.preventDefault()');
  });
});
