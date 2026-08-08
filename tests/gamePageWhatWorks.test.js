/**
 * Per-game "What Works?" modal wiring on the game page (#440).
 *
 * The aggregation itself is tested in tests/whatWorks.test.js. Here we pin
 * that the game page imports the module, renders the prominent button in
 * the header-actions row, ships the inline modal chrome, and wires the
 * click handler + close/backdrop/Escape lifecycle.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8',
);
const MANIFEST = fs.readFileSync(
  path.join(__dirname, '..', 'gh-pages-manifest.txt'),
  'utf8',
);
const HEADER_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'app', 'game-header.css'),
  'utf8',
);
const MODALS_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'app', 'modals.css'),
  'utf8',
);

describe('game-page What Works? modal wiring (#440)', () => {
  test('imports the aggregation module from js/app/lib/what-works.js', () => {
    expect(SRC).toMatch(/import\s*\{\s*computeWhatWorks\s*\}\s*from\s*'\.\.\/lib\/what-works\.js/);
  });

  test('ships a prominent What Works? button in the header-actions row', () => {
    expect(SRC).toContain('id="what-works-btn"');
    expect(SRC).toContain('class="what-works-btn"');
    expect(SRC).toContain('What Works?');
    // Must sit inside game-header-actions -- otherwise it lands somewhere
    // random on the page and the "top-right prominent" intent is lost.
    const actionsBlock = SRC.match(/<div class="game-header-actions">([\s\S]*?)<\/div>/);
    expect(actionsBlock).not.toBeNull();
    expect(actionsBlock[1]).toContain('what-works-btn');
  });

  test('ships the inline modal chrome with a body slot for aggregation output', () => {
    expect(SRC).toContain('id="what-works-modal"');
    expect(SRC).toContain('id="what-works-body"');
    expect(SRC).toContain('id="what-works-close"');
    expect(SRC).toContain('role="dialog"');
    expect(SRC).toContain('aria-modal="true"');
    // Modal must be `hidden` by default so it doesn't flash on page load.
    expect(SRC).toMatch(/id="what-works-modal"[^>]*hidden/);
  });

  test('button click handler is wired and dispatches to the opener helper', () => {
    expect(SRC).toMatch(/el\.querySelector\('#what-works-btn'\)\?\.addEventListener\('click'/);
    expect(SRC).toContain('_openWhatWorksModal(el, reports, appId)');
  });

  test('opener helper renders body once and wires close / backdrop / Escape', () => {
    expect(SRC).toMatch(/function _openWhatWorksModal\(el, reports, appId\)/);
    // Body is filled lazily and marked so re-opens are cheap.
    expect(SRC).toContain("modal.dataset.filled");
    // Close via button + backdrop + Escape must all be present.
    expect(SRC).toMatch(/#what-works-close.*addEventListener\('click'/);
    expect(SRC).toMatch(/e\.key === 'Escape'/);
  });

  test('body renderer surfaces all three sections + report totals', () => {
    expect(SRC).toMatch(/function _renderWhatWorksBody\(reports, appId\)/);
    expect(SRC).toContain('Fixes mentioned in notes');
    expect(SRC).toContain('Proton versions that worked');
    expect(SRC).toContain('Launch options that worked');
    // The summary line must show scanned + positive counts so a user knows
    // whether the bars mean anything on a low-report game.
    expect(SRC).toContain('totals.reports');
    expect(SRC).toContain('totals.positive');
  });

  test('manifest lists the new aggregation module so CF Pages ships it', () => {
    const lines = MANIFEST.split('\n').map(l => l.trim());
    expect(lines).toContain('js/app/lib/what-works.js');
  });

  test('CSS ships the prominent button style + full modal chrome', () => {
    // Header CSS -- the CTA that opens the modal.
    expect(HEADER_CSS).toMatch(/\.what-works-btn\s*\{/);
    expect(HEADER_CSS).toMatch(/\.what-works-btn:hover/);
    // Modals CSS -- backdrop, panel, body, close, and each row primitive.
    expect(MODALS_CSS).toMatch(/\.ww-modal-backdrop\s*\{/);
    expect(MODALS_CSS).toMatch(/\.ww-modal\s*\{/);
    expect(MODALS_CSS).toMatch(/\.ww-modal-body\s*\{/);
    expect(MODALS_CSS).toMatch(/\.ww-close/);
    expect(MODALS_CSS).toMatch(/\.ww-row/);
    expect(MODALS_CSS).toMatch(/\.ww-bar-fill/);
  });
});
