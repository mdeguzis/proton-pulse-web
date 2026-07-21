/**
 * #376 regression guard: the game-page headline confidence must route
 * through the SAME helper the breakdown page reads (computeGameStats),
 * not the simple log formula in pulseTierFromReports. App 9860 read
 * 92% vs 39% before this fix -- the staleness cap in computeGameStats
 * kicks in for old reports and pulseTierFromReports missed it.
 *
 * Also confirms the fallback path (ProtonDB-mirror-only game with zero
 * native reports) still uses the log formula, since computeGameStats
 * returns 0 for empty input.
 */
const fs = require('fs');
const path = require('path');

const PAGE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/app/components/game-page.js'),
  'utf8',
);

describe('game-page confidence source (#376)', () => {
  test('imports computeGameStats from the same module confidence.html uses', () => {
    // The breakdown page reads computeGameStats; the headline must too.
    expect(PAGE_SRC).toMatch(/computeGameStats[\s\S]{0,120}from ['"]\.\.\/\.\.\/lib\/scoring\/gameStats\.js/);
  });

  test('overallConfidencePct routes through computeGameStats when reports exist', () => {
    // The primary branch of the ternary must call the multi-factor helper
    // so the game page + confidence.html show the same number.
    expect(PAGE_SRC).toMatch(/gameStats\?.confidencePct[\s\S]{0,60}gameStats\.confidencePct/);
  });

  test('falls back to the log formula only when no native reports exist', () => {
    // ProtonDB-mirror-only games have zero native reports -> computeGameStats
    // would return 0. The ternary's else branch keeps the ProtonDB-count log
    // formula so those cards still show a confidence number.
    expect(PAGE_SRC).toMatch(/protonDbCount > 0 \? Math\.min\(95, Math\.round\(30 \+ Math\.log2/);
  });

  test('does not read combinedTier.confidencePct for the headline anymore', () => {
    // Regression guard against reverting the fix. combinedTier.tier is still
    // read for the tier itself; only confidencePct changed. If a future edit
    // adds `combinedTier.confidencePct` back into the headline path, this
    // test should fail and force a redesign of the fix.
    const overallLine = PAGE_SRC.match(/const overallConfidencePct = [^;]+;/s);
    expect(overallLine).not.toBeNull();
    expect(overallLine[0]).not.toContain('combinedTier.confidencePct');
  });
});
