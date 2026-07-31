/**
 * Stub page for every known game (#363). Long-tail Steam titles (e.g. Cat Chess
 * / 4163030) live only in the extended index (search-index-steam-extended.json),
 * not the main search-index.
 *
 * A known game with no reports must render the FULL game page (header art,
 * platform badges, Steam/SteamDB/ProtonDB/... hub-links, action buttons) with a
 * "pending" rating panel -- not a stripped-down stub, and not the generic
 * "not in our mirror" state. So: the title must resolve from the extended index,
 * and known games must fall through to the full render (the minimal stub block
 * is gone). Only a genuinely unknown appId keeps the mirror-miss state.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8',
);

describe('game-page renders the full page for known no-report games (#363)', () => {
  test('imports the extended index loader + array from search.js', () => {
    const imp = SRC.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/search\.js/);
    expect(imp).not.toBeNull();
    expect(imp[1]).toMatch(/loadExtendedSteamIndex/);
    expect(imp[1]).toMatch(/extendedSteamIndex/);
  });

  test('the hard-miss branch resolves a title from the extended index', () => {
    const start = SRC.indexOf('if (!reports.length && !configs.length && !liveSummary)');
    const end = SRC.indexOf('// Known game, no reports yet: fall through', start);
    const branch = SRC.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(branch).toMatch(/_indexRowFor\(appId\)/);
    expect(branch).toMatch(/_fetchSteamCatalog\(\)/);
    expect(branch).toMatch(/loadExtendedSteamIndex\(\)/);
    // Only a genuinely unknown appId short-circuits to the mirror-miss state.
    expect(branch).toMatch(/not in our cached ProtonDB mirror/);
  });

  test('the minimal stub block is removed; known games use the full render', () => {
    // The old stripped-down stub (its own .stub-page block) is gone -- known
    // games now flow into the full header + hub-links render.
    expect(SRC).not.toMatch(/class="stub-page"/);
    expect(SRC).not.toMatch(/Submit the first report/);
  });

  test('the full-render title resolution also consults the extended index', () => {
    const idx = SRC.indexOf('let resolvedTitle');
    const after = SRC.slice(idx, idx + 600);
    expect(idx).toBeGreaterThan(-1);
    expect(after).toMatch(/loadExtendedSteamIndex\(\)/);
    expect(after).toMatch(/extendedSteamIndex/);
  });
});
