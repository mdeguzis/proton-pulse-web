/**
 * #415 slice 1: filter Save must be an explicit press.
 *
 * The prior behavior auto-wrote to localStorage on every dropdown change
 * whenever the persist toggle was on. That made it impossible to "try" a
 * filter without accidentally persisting it. These asserts pin the new
 * behavior in the source so a future refactor cannot silently reintroduce
 * the auto-save path.
 *
 * Structural tests only -- game-page.js is a large IIFE that does its work
 * against real DOM + localStorage. Same pattern as filterPanelRegressions.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8'
);
const reportsCss = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'app', 'reports.css'),
  'utf8'
);

describe('#415 slice 1: filter Save is explicit press-to-save', () => {
  test('saveFiltersIfEnabled is gone (retired)', () => {
    expect(src).not.toMatch(/saveFiltersIfEnabled/);
  });

  test('the free-floating persistFilters boolean is retired', () => {
    // The identifier is banned entirely -- it had one meaning (auto-save
    // toggle) and that meaning no longer applies. Reusing it would confuse
    // future readers who came in through the old behavior.
    expect(src).not.toMatch(/\bpersistFilters\b/);
  });

  test('every dropdown change calls _updateSaveButtonState instead of writing to storage', () => {
    // Ensure all seven scalar-filter change handlers (and playtime) fire the
    // dirty-state update, not the auto-save. Also make sure none of them
    // touch localStorage directly.
    const handlers = [
      "el.querySelector('#fGpu')",
      "el.querySelector('#fArch')",
      "el.querySelector('#fOs')",
      "el.querySelector('#fRating')",
      "el.querySelector('#fRunType')",
      "el.querySelector('#fSource')",
      "el.querySelector('#fDevice')",
      "el.querySelector('#fPlaytime')",
    ];
    for (const sel of handlers) {
      const idx = src.indexOf(sel);
      expect(idx).toBeGreaterThan(0);
      // Grab a slice of the handler body so we only match calls in-context
      const slice = src.slice(idx, idx + 400);
      expect(slice).toContain('_updateSaveButtonState()');
      expect(slice).not.toContain('localStorage.setItem');
      expect(slice).not.toContain('saveFilters');
    }
  });

  test('Save button click calls _saveFiltersNow and supports shift-click forget', () => {
    // Search for the click handler specifically (not the helper that also
    // does getElementById('gp-filter-persist') to update button state).
    const idx = src.indexOf("document.getElementById('gp-filter-persist')?.addEventListener('click'");
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 500);
    expect(slice).toMatch(/if\s*\(e\.shiftKey\s*&&\s*_getPersistedSnapshot\(\)\)/);
    expect(slice).toContain('_forgetSavedFilters()');
    expect(slice).toContain('_saveFiltersNow()');
  });

  test('Clear filters does NOT write to localStorage anymore', () => {
    const idx = src.indexOf("document.getElementById('gp-filter-clear')");
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 900);
    expect(slice).not.toContain('localStorage.setItem');
    expect(slice).not.toContain('localStorage.removeItem');
    expect(slice).toContain('_updateSaveButtonState');
    expect(slice).toContain('refreshReports');
  });

  test('_saveFiltersNow writes the snapshot AND drops the legacy opt-out marker', () => {
    // The '0' value on FILTER_PERSIST_KEY meant "do not restore on load".
    // First explicit Save should remove it so a later load honors the new
    // snapshot instead of ignoring it because of the legacy marker.
    const idx = src.indexOf('function _saveFiltersNow');
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 600);
    expect(slice).toContain('localStorage.setItem(FILTER_STORAGE_KEY');
    expect(slice).toMatch(/localStorage\.removeItem\(FILTER_PERSIST_KEY\)/);
    expect(slice).toContain('_updateSaveButtonState()');
  });

  test('_isDirty compares current snapshot to persisted', () => {
    expect(src).toContain('function _isDirty()');
    expect(src).toContain('_getPersistedSnapshot()');
    expect(src).toContain('_filterSnapshot()');
  });

  test('CSS ships dirty AND clean state variants for the save button', () => {
    expect(reportsCss).toContain('.filter-save-btn.is-dirty');
    expect(reportsCss).toContain('.filter-save-btn.is-clean');
    // is-active alias retained so existing DOM inspectors + tests do not
    // suddenly see a missing selector.
    expect(reportsCss).toContain('.filter-save-btn.is-active');
  });

  test('button HTML no longer templates a persistFilters conditional class or aria-pressed', () => {
    // The template on line ~1394 used to bake persistFilters into is-active
    // and aria-pressed. Both must be static now; state comes from the runtime
    // updater, not the render.
    expect(src).toContain(
      '<button class="filter-save-btn" id="gp-filter-persist" type="button" aria-pressed="false"'
    );
  });
});
