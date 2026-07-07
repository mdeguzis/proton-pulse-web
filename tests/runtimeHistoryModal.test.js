/**
 * The runtime-history modal is opened by clicking the Native Linux hint on
 * the game page. Rather than pulling in jsdom + the full game-page render
 * we assert the source contains the aggregation invariants that drive it:
 *   - groups by run_type (unknown for legacy null rows)
 *   - counts reports per runtime
 *   - tracks first-seen (min timestamp) + last-updated (max)
 *   - orders canonical runtimes first, unknown last
 *
 * Regression guards on the SQL-ish shape stay in a source-string test
 * because the aggregation lives inline in the game-page module (no
 * import surface to unit test directly).
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'), 'utf8');

describe('runtime history modal (game-page)', () => {
  test('module exposes _openRuntimeHistoryModal wired from the native badge', () => {
    // Native badge triggers the modal on click AND on Enter/Space (a11y).
    expect(SRC).toMatch(/_openRuntimeHistoryModal\(appId, combined\)/);
    expect(SRC).toMatch(/nativeEl\.addEventListener\('click'/);
    expect(SRC).toMatch(/nativeEl\.addEventListener\('keydown'/);
  });

  test('aggregation buckets on r.runType and falls back to "unknown"', () => {
    expect(SRC).toContain("const key = r.runType || 'unknown';");
    expect(SRC).toContain('byRuntime.set(key, entry)');
  });

  test('tracks report count + first-seen (min ts) + last-updated (max)', () => {
    expect(SRC).toContain('entry.count++');
    expect(SRC).toMatch(/ts && ts < entry\.first/);
    expect(SRC).toMatch(/upd && upd > entry\.last/);
  });

  test('orders canonical runtimes first, unknown last', () => {
    expect(SRC).toContain("const CANONICAL_ORDER = ['native', 'proton', 'proton-experimental', 'proton-ge', 'proton-cachyos', 'proton-tkg', 'proton-lsfg'];");
    expect(SRC).toContain("if (a === 'unknown') return 1;");
    expect(SRC).toContain("if (b === 'unknown') return -1;");
  });

  test('empty state renders when no reports carry a runtime', () => {
    expect(SRC).toMatch(/No reports on this game carry a runtime yet/);
  });

  test('modal closes on Escape and on backdrop click', () => {
    expect(SRC).toContain("if (e.key === 'Escape')");
    expect(SRC).toMatch(/if \(e\.target === modal\) close\(\)/);
  });
});
