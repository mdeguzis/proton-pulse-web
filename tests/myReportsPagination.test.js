/**
 * Source-shape tests for #152: My Reports section paginates at 15
 * reports per page and surfaces page-number buttons in the section
 * title's right-aligned slot.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MY_REPORTS_SRC   = fs.readFileSync(path.join(ROOT, 'js', 'profile', 'components', 'my-reports.js'), 'utf8');
const PROFILE_HTML     = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');
const PROFILE_CSS      = fs.readFileSync(path.join(ROOT, 'css', 'profile', 'profile.css'), 'utf8');

describe('My Reports pagination (#152)', () => {
  test('page size is 15', () => {
    expect(MY_REPORTS_SRC).toContain('const PAGE_SIZE = 15');
  });

  test('default page is 1', () => {
    expect(MY_REPORTS_SRC).toContain('let currentPage = 1');
  });

  test('applySearch slices to PAGE_SIZE per page', () => {
    expect(MY_REPORTS_SRC).toContain('const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))');
    expect(MY_REPORTS_SRC).toContain('filtered.slice(start, start + PAGE_SIZE)');
  });

  test('renderPager emits a button per page with data-page', () => {
    expect(MY_REPORTS_SRC).toContain('function renderPager(totalPages)');
    expect(MY_REPORTS_SRC).toContain('class="profile-pager-num${active}" data-page="${p}"');
  });

  test('single-page state still shows a "1" so the slot is not empty', () => {
    expect(MY_REPORTS_SRC).toMatch(/totalPages <= 1[\s\S]{0,400}profile-pager-num--active"?>1</);
  });

  test('search input resets to page 1', () => {
    const block = MY_REPORTS_SRC.slice(
      MY_REPORTS_SRC.indexOf("myConfigsSearch?.addEventListener('input'"),
      MY_REPORTS_SRC.indexOf("myConfigsSearch?.addEventListener('input'") + 400
    );
    expect(block).toContain('currentPage = 1');
  });

  test('pager click delegate flips currentPage and re-renders', () => {
    expect(MY_REPORTS_SRC).toContain("myConfigsPager?.addEventListener('click'");
    expect(MY_REPORTS_SRC).toContain('currentPage = next');
  });

  test('renderMyConfigs resets to page 1 on full refresh', () => {
    const fn = MY_REPORTS_SRC.slice(
      MY_REPORTS_SRC.indexOf('function renderMyConfigs(rows)'),
      MY_REPORTS_SRC.indexOf('function renderMyConfigs(rows)') + 300
    );
    expect(fn).toContain('currentPage = 1');
  });
});

describe('My Reports pager DOM hook', () => {
  test('profile.html ships the pager slot right of the section title', () => {
    expect(PROFILE_HTML).toContain('id="my-configs-pager"');
    // The pager sits in the same flex row as the Refresh button.
    const titleIdx = PROFILE_HTML.indexOf('id="my-configs-pager"');
    const refreshIdx = PROFILE_HTML.indexOf('id="my-configs-refresh-btn"');
    expect(titleIdx).toBeGreaterThan(0);
    expect(refreshIdx).toBeGreaterThan(titleIdx);
  });
});

describe('My Reports pager CSS', () => {
  test('.profile-pager-num + active variant exist', () => {
    expect(PROFILE_CSS).toContain('.profile-pager-num {');
    expect(PROFILE_CSS).toContain('.profile-pager-num--active {');
  });
});
