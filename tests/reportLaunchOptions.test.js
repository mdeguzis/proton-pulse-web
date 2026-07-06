/**
 * Launch options must round-trip from Supabase to the report card. The prior
 * game-page fetch omitted launch_options from the select clause and the row
 * mapper never surfaced it, so the value existed in the DB but never landed
 * on the card. These grep-level assertions pin the wiring so a future
 * refactor cannot silently drop the field again.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SUPABASE_API = read('js/app/api/supabase.js');
const REPORT_CARD = read('js/app/components/report-card.js');

describe('launch options fetch + render (game page)', () => {
  test('fetchNativeReports selects launch_options from user_configs', () => {
    // The select clause is a long comma-joined list. Just make sure the
    // column is somewhere in there.
    const selectMatch = SUPABASE_API.match(/user_configs\?app_id=eq\.[^`]*select=([^&]+)/);
    expect(selectMatch).not.toBeNull();
    expect(selectMatch[1]).toContain('launch_options');
  });

  test('row mapper exposes launchOptions on the returned report shape', () => {
    // Value string trims to '' when null so the truthiness check on the
    // card side hides the row for reports without one.
    expect(SUPABASE_API).toMatch(/launchOptions:\s+row\.launch_options \|\| ''/);
  });

  test('report card renders launch options in the main summary, not the hidden panel', () => {
    // The rendered order matters: launch options is a headline detail
    // (users copy it into Steam), so it must appear before the
    // .all-details-panel that only opens on click.
    const summaryIdx = REPORT_CARD.indexOf('<div class="card-summary">');
    const launchIdx = REPORT_CARD.indexOf('launch-options-value');
    const panelIdx = REPORT_CARD.indexOf('all-details-panel hw-details-panel');
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(launchIdx).toBeGreaterThan(summaryIdx);
    expect(launchIdx).toBeLessThan(panelIdx);
  });

  test('launch options row still hides itself when the report has none', () => {
    // The optional-render check must be intact so reports without a
    // launch_options entry don't get an empty row.
    expect(REPORT_CARD).toMatch(/\$\{r\.launchOptions \? `<div class="row"><span class="label">Launch Options<\/span>/);
  });
});
