/**
 * The admin users table lists users sorted by last_active desc from the
 * server. The visual sort arrow was previously only drawn when the user
 * clicked a column for the first time, so the default order looked
 * unsorted. This test locks in the fix: the default column carries a
 * data-sort-default attribute and setupTableSort paints the indicator
 * on init.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'main.js'), 'utf8');

describe('admin users table default sort indicator (bug fix)', () => {
  test('the Last active column in admin.html carries data-sort-default="desc"', () => {
    expect(HTML).toMatch(/data-sort-col="4"\s+data-sort-type="date"\s+data-sort-default="desc"[^>]*>\s*Last active/);
  });

  test('setupTableSort reads data-sort-default and paints the arrow before any click', () => {
    // The initial-paint block must sit inside setupTableSort BEFORE the
    // click handler is registered, otherwise the indicator only shows
    // after the user interacts.
    expect(MAIN).toContain('function setupTableSort');
    expect(MAIN).toContain('const defaultDir = th.dataset.sortDefault');
    expect(MAIN).toContain("defaultDir === 'asc' || defaultDir === 'desc'");
    // Must add the sorted class + the arrow char so the header renders as
    // active immediately.
    expect(MAIN).toContain("th.classList.add('admin-th--sorted')");
    // The two arrow glyphs (up + down) live at the same escape sequence
    // the click handler uses so the visual state matches.
    expect(MAIN).toContain(' \\u25b2');
    expect(MAIN).toContain(' \\u25bc');
  });

  test('only ONE column in the users table declares a default sort (arrow should not be ambiguous)', () => {
    const usersSection = HTML.slice(HTML.indexOf('id="users-table"'), HTML.indexOf('id="users-table"') + 2000);
    const matches = usersSection.match(/data-sort-default=/g) || [];
    expect(matches.length).toBe(1);
  });
});
