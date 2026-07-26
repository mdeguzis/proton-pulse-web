/**
 * Tests for the optional FPS metrics row on the Pulse submit form.
 *
 * Behavior guards:
 *  - three separate inputs with numeric shape (min / avg / max, same line)
 *  - each input has an inline (i) info button
 *  - submit payload maps fpsMin / fpsAvg / fpsMax into fps_min / fps_avg /
 *    fps_max columns; empty fields serialize as null (not "" or 0)
 *  - report card renders the trio in the default view when any of the three
 *    is set, with a monospace layout that keeps '-' placeholders aligned
 */

const fs = require('fs');
const path = require('path');

const SUBMIT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'shared', 'submit.js'), 'utf8');
const CARD_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'report-card.js'), 'utf8');
const API_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'api', 'supabase.js'), 'utf8');

describe('submit form: FPS row', () => {
  test('has three separate optional numeric inputs on the same row', () => {
    expect(SUBMIT_SRC).toContain('class="sf-row sf-row--fps"');
    expect(SUBMIT_SRC).toContain('name="fpsMin"');
    expect(SUBMIT_SRC).toContain('name="fpsAvg"');
    expect(SUBMIT_SRC).toContain('name="fpsMax"');
    // number inputs with an inputmode + step so mobile keyboards + MangoHud
    // decimals (e.g. 58.7) both work.
    expect(SUBMIT_SRC).toMatch(/name="fpsMin"[^>]*type="number"/);
    expect(SUBMIT_SRC).toMatch(/name="fpsAvg"[^>]*step="0\.1"/);
    // All three are optional -- no `required` attribute.
    expect(SUBMIT_SRC).not.toMatch(/name="fpsMin"[^>]*required/);
    expect(SUBMIT_SRC).not.toMatch(/name="fpsAvg"[^>]*required/);
    expect(SUBMIT_SRC).not.toMatch(/name="fpsMax"[^>]*required/);
  });

  test('each FPS input has an inline (i) info button', () => {
    const infoButtons = SUBMIT_SRC.match(/class="sf-fps-info"/g) || [];
    expect(infoButtons.length).toBeGreaterThanOrEqual(3);
    expect(SUBMIT_SRC).toContain('data-fps-info="min"');
    expect(SUBMIT_SRC).toContain('data-fps-info="avg"');
    expect(SUBMIT_SRC).toContain('data-fps-info="max"');
  });

  test('info popover references MangoHud and the SteamOS QAM performance overlay', () => {
    expect(SUBMIT_SRC).toMatch(/wireFpsInfoButtons/);
    expect(SUBMIT_SRC).toMatch(/MangoHud/);
    expect(SUBMIT_SRC).toMatch(/Steam Deck|SteamOS|Quick Access|Performance Overlay/);
  });
});

describe('submit payload: FPS fields serialize to snake_case DB columns', () => {
  test('reads fpsMin / fpsAvg / fpsMax off the form and writes fps_min / fps_avg / fps_max', () => {
    expect(SUBMIT_SRC).toContain("fps_min: form.fpsMin?.value ? Number(form.fpsMin.value) : null");
    expect(SUBMIT_SRC).toContain("fps_avg: form.fpsAvg?.value ? Number(form.fpsAvg.value) : null");
    expect(SUBMIT_SRC).toContain("fps_max: form.fpsMax?.value ? Number(form.fpsMax.value) : null");
  });
});

describe('report card: FPS trio', () => {
  test('renders only when at least one of the three is set', () => {
    expect(CARD_SRC).toContain('r.fpsMin != null || r.fpsAvg != null || r.fpsMax != null');
  });

  test('shows the trio in the DEFAULT view (not behind All details)', () => {
    // The FPS row must live inside .card-summary before the .all-details-panel
    // section so it is visible without expanding the details panel.
    const summaryStart = CARD_SRC.indexOf('<div class="card-summary">');
    const fpsIdx = CARD_SRC.indexOf('${renderFpsRow(r)}');
    const detailsIdx = CARD_SRC.indexOf('all-details-panel hw-details-panel');
    expect(fpsIdx).toBeGreaterThan(summaryStart);
    expect(fpsIdx).toBeLessThan(detailsIdx);
  });

  test('renders monospace values with dashes for missing readings', () => {
    expect(CARD_SRC).toContain('class="fps-values"');
    expect(CARD_SRC).toContain("const fmt = v => (v != null ? Number(v).toFixed(1) : '-')");
  });
});

describe('supabase reader: FPS columns land on the object we render', () => {
  test('select includes fps_min, fps_avg, fps_max', () => {
    expect(API_SRC).toMatch(/fps_min,fps_avg,fps_max/);
  });

  test('mapper exposes fpsMin, fpsAvg, fpsMax with null defaults', () => {
    expect(API_SRC).toContain('fpsMin:            row.fps_min ?? null');
    expect(API_SRC).toContain('fpsAvg:            row.fps_avg ?? null');
    expect(API_SRC).toContain('fpsMax:            row.fps_max ?? null');
  });
});
