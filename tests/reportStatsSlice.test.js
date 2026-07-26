/**
 * #410 variant B: FPS runs on report cards + the single-report stats slice.
 *
 * - renderFpsRow: aggregate row + runs chip capped at 5 inline rows, with
 *   the All stats link to game-stats.html?app=X&report=Y
 * - game-stats.html?report=<id> filters every section to that one report
 *   and renders the per-run graph + sortable table
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const GS_SRC = read('js/game-stats/main.js');
const GS_HTML = read('game-stats.html');
const CARD_CSS = read('css/app/reports.css');

function loadCard() {
  return loadEsm(['js/app/components/report-card.js'], {
    console: { log() {}, debug() {}, warn() {}, error() {} },
    // loadEsm strips imports; esc normally arrives from app/utils.js.
    esc: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  });
}

const runs = (n) => Array.from({ length: n }, (_, i) => ({
  name: `run${i + 1}.csv`, fpsMin: 50 + i, fpsAvg: 60 + i, fpsMax: 70 + i, sampleCount: 1000 + i,
}));

describe('renderFpsRow (report card, variant B)', () => {
  test('renders nothing without aggregate or runs', () => {
    const mod = loadCard();
    expect(mod.renderFpsRow({})).toBe('');
  });

  test('aggregate-only report keeps the plain FPS row, no chip', () => {
    const mod = loadCard();
    const html = mod.renderFpsRow({ fpsMin: 54.2, fpsAvg: 72.8, fpsMax: 101.2 });
    expect(html).toContain('54.2 / 72.8 / 101.2');
    expect(html).not.toContain('fps-runs-chip');
    expect(html).not.toContain('All stats');
  });

  test('runs produce the chip, the panel, and the All stats link', () => {
    const mod = loadCard();
    const html = mod.renderFpsRow({
      appId: '2561580', reportId: 42, fpsMin: 50, fpsAvg: 61, fpsMax: 72,
      formResponses: { fpsRuns: runs(3) },
    });
    expect(html).toContain('3 runs');
    expect(html).toContain('fps-runs-panel');
    expect(html).toContain('game-stats.html?app=2561580&report=42');
    expect(html).toContain('All stats');
    expect((html.match(/fps-run-line-name/g) || []).length).toBe(3);
  });

  test('caps inline rows at 5 and routes overflow to the All stats page', () => {
    const mod = loadCard();
    const html = mod.renderFpsRow({
      appId: '10', reportId: 7, fpsAvg: 60, formResponses: { fpsRuns: runs(8) },
    });
    expect((html.match(/fps-run-line-name/g) || []).length).toBe(5);
    expect(html).toContain('+3 more run');
    expect(html).toContain('game-stats.html?app=10&report=7');
  });

  test('escapes run names (uploaded filenames are user input)', () => {
    const mod = loadCard();
    const html = mod.renderFpsRow({
      appId: '10', reportId: 7, fpsAvg: 60,
      formResponses: { fpsRuns: [{ name: '<img src=x onerror=alert(1)>.csv', fpsAvg: 60, sampleCount: 5 }] },
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  test('card CSS carries the chip and panel styles', () => {
    expect(CARD_CSS).toContain('.fps-runs-chip');
    expect(CARD_CSS).toContain('.fps-run-line');
  });
});

describe('game-stats single-report slice (?report=)', () => {
  test('report param is numeric-validated before use', () => {
    expect(GS_SRC).toMatch(/\/\^\[0-9\]\+\$\/\.test\(reportRaw\)/);
  });

  test('slice filters allReports down to the matching report', () => {
    expect(GS_SRC).toContain("allReports.find(r => String(r.id ?? r.reportId ?? '') === reportId)");
    expect(GS_SRC).toContain('allReports = [sliceReport]');
  });

  test('missing report id falls back to full stats instead of erroring', () => {
    expect(GS_SRC).toContain('report id not found; falling back to full stats');
  });

  test('slice banner links back to the full game stats', () => {
    expect(GS_SRC).toContain('gs-slice-banner');
    expect(GS_SRC).toContain('See the full game stats');
    expect(GS_HTML).toContain('.gs-slice-banner');
  });

  test('per-run section renders an SVG graph and a sortable table', () => {
    expect(GS_SRC).toContain('renderFpsRunsSection');
    expect(GS_SRC).toMatch(/<svg viewBox="0 0 \$\{w\} \$\{h\}"/);
    expect(GS_SRC).toContain('id="fps-runs-table"');
    expect(GS_SRC).toContain('wireFpsRunsSection');
    // Sorting wires both numeric and text comparators.
    expect(GS_SRC).toContain("th.dataset.sort === 'num'");
    expect(GS_HTML).toContain('.gs-fps-table');
  });
});
