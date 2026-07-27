/**
 * #412: the "Scoring against: <system>" selector at the top of the stats
 * page must feed a real section. These tests assert the helpers and the
 * render surface are wired so a future refactor cannot silently drop them.
 *
 * Structural tests only -- the game-stats module is a self-invoking IIFE
 * that touches window/localStorage, so we assert against the source string
 * (same pattern as gameStatsLive.test.js).
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'game-stats', 'main.js'),
  'utf8'
);
const htmlSrc = fs.readFileSync(
  path.join(__dirname, '..', 'game-stats.html'),
  'utf8'
);

describe('game-stats hardware comparison (#412)', () => {
  test('detectGpuArch is imported so architecture matching is available', () => {
    expect(src).toMatch(/import\s+\{\s*detectGpuArch\s*\}\s+from\s+'\.\.\/lib\/gpu-arch-detector\.js/);
  });

  test('renderHwComparison exists and short-circuits when hw or reports missing', () => {
    expect(src).toContain('function renderHwComparison(allReports, myHw)');
    expect(src).toMatch(/if\s*\(!myHw\s*\|\|\s*!\(myHw\.gpu\s*\|\|\s*myHw\.gpuVendor\)\)\s*return\s+''/);
    expect(src).toMatch(/if\s*\(!graded\.length\)\s*return\s+''/);
  });

  test('_matchLevel returns arch / vendor / none based on vendor + detectGpuArch', () => {
    expect(src).toContain("function _matchLevel(myHw, report)");
    expect(src).toContain("return 'arch'");
    expect(src).toContain("return 'vendor'");
    expect(src).toContain("return 'none'");
    expect(src).toMatch(/detectGpuArch\(myHw\.gpu\)/);
    expect(src).toMatch(/detectGpuArch\(report\.gpu\)/);
  });

  test('graded tier set matches _TIER_ORDER and _TIER_WORKING is the top three', () => {
    expect(src).toMatch(/_TIER_ORDER\s*=\s*\[\s*'platinum',\s*'gold',\s*'silver',\s*'bronze',\s*'borked'\s*\]/);
    expect(src).toMatch(/_TIER_WORKING\s*=\s*new Set\(\[\s*'platinum',\s*'gold',\s*'silver'\s*\]\)/);
  });

  test('renderAll accepts myHw and threads it through to renderHwComparison', () => {
    expect(src).toMatch(/function renderAll\(appId, title, stats, counts = \{\}, allReports = \[\], flightlessEntry = null, myHw = null\)/);
    expect(src).toMatch(/const hwHtml = renderHwComparison\(allReports, myHw\)/);
  });

  test('run() passes viewer hardware into renderAll', () => {
    // renderAll invocation includes myHw as the trailing arg
    expect(src).toMatch(/renderAll\(appId,\s*title,\s*stats,\s*\{[\s\S]*?\},\s*allReports,\s*flightlessEntry,\s*myHw\)/);
  });

  test('hw comparison section only enters the jump list when it actually renders', () => {
    expect(src).toMatch(/\.\.\.\s*\(hwHtml\s*\?\s*\[\s*\[\s*'hw-match',\s*'How your system compares'\s*\]\s*\]\s*:\s*\[\]\s*\)/);
  });

  test('preview-hardware note points back to the profile page', () => {
    expect(src).toContain("Steam Deck preview");
    expect(src).toMatch(/href="profile\.html"/);
  });

  test('empty-state falls back to a same-vendor summary when arch does not match', () => {
    expect(src).toContain("run other <strong>${esc(myVendor.toUpperCase())}</strong> GPUs");
    expect(src).toContain("gs-hw-empty-line");
  });

  test('CSS block for gs-hw-* classes ships in game-stats.html', () => {
    expect(htmlSrc).toContain('.gs-hw-comparison');
    expect(htmlSrc).toContain('.gs-hw-metric-row');
    expect(htmlSrc).toContain('.gs-hw-tier-bar');
    expect(htmlSrc).toContain('.gs-hw-delta-up');
    expect(htmlSrc).toContain('.gs-hw-delta-down');
    // Tier badge colors must render in both themes (dark bg here, but the
    // hex swatches themselves are theme-neutral and legible on either).
    expect(htmlSrc).toContain('.gs-tier-badge[data-tier="platinum"]');
    expect(htmlSrc).toContain('.gs-tier-badge[data-tier="borked"]');
  });
});
