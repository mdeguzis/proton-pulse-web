/**
 * Source-shape regression tests for draft capture/restore on the submit form.
 * submit.js is too heavy for jsdom (matching submitMarkdownSpike.test.js), so
 * pin the specific fixes that make the full form state round-trip:
 *   - applyDraftSnapshot must fire change on the CHECKED radio, not the
 *     RadioNodeList (which has no dispatchEvent, so restored yes/no answers
 *     silently never ran their handlers).
 *   - the alsoTestedLinux hidden input must sync its buttons/notes on
 *     programmatic change, since restore sets the value without a click.
 *   - Save Draft is hidden when editing an already-published report.
 */

const fs = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const SUBMIT = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'submit.js'), 'utf8');
const MAIN   = fs.readFileSync(path.join(ROOT, 'js', 'submit', 'main.js'), 'utf8');

describe('draft restore wiring', () => {
  test('applyDraftSnapshot dispatches change on the checked radio, not the RadioNodeList', () => {
    // The RadioNodeList branch must resolve to a real control before dispatch.
    expect(SUBMIT).toContain('controls.find(f => f.checked)?.dispatchEvent');
    // And must not dispatch on the list itself (the old silent no-op bug).
    expect(SUBMIT).not.toMatch(/fields\.dispatchEvent\?\.\(new Event/);
  });

  test('alsoTestedLinux syncs its buttons/notes on programmatic change (draft restore)', () => {
    expect(SUBMIT).toContain("alsoHidden.addEventListener('change'");
    expect(SUBMIT).toContain('syncAlsoLinuxUi');
  });

  test('Save Draft is hidden when editing an already-published report', () => {
    expect(MAIN).toContain('saveDraftBtn && session && !isEdit');
  });

  test('draft restore is offered in the fromCloud flow, not gated out', () => {
    // Was "!isEdit && !fromCloud"; now any unpublished draft gets the restore offer.
    expect(MAIN).toContain('if (!isEdit && session)');
    expect(MAIN).not.toContain('!isEdit && !fromCloud && session');
  });
});
