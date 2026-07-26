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
    expect(SUBMIT_MAIN).toMatch(/submit-edit-window--expired[\s\S]{0,900}return;/);
  });

  test('missing created_at fails open (edit allowed) rather than locking a fresh report', () => {
    expect(SUBMIT_MAIN).toMatch(/Number\.isFinite\(createdMs\)\s*\n?\s*\? EDIT_WINDOW_DAYS - [\s\S]{0,80}: EDIT_WINDOW_DAYS/);
  });

  test('notice styles exist for both states', () => {
    expect(CSS).toContain('.submit-edit-window {');
    expect(CSS).toContain('.submit-edit-window--expired {');
  });
});
