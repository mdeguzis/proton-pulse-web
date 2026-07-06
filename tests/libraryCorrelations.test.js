/**
 * Tests for js/shared/library-correlations.js (#209, umbrella #204).
 *
 * Pure aggregation over stubbed user_configs rows + owned-appid sets. The
 * matcher itself has its own test file (analyticsPatterns.test.js); these
 * tests focus on the join + rollup logic.
 */

const { aggregateLibraryPatterns } = require('../js/shared/library-correlations.js');
const { OPTIMIZATION_PATTERNS } = require('../js/shared/analytics-patterns.js');

function mkReport(appId, notes) {
  return { app_id: appId, notes };
}

describe('aggregateLibraryPatterns', () => {
  test('empty inputs yield empty shape', () => {
    expect(aggregateLibraryPatterns([], [], OPTIMIZATION_PATTERNS))
      .toEqual({ perPattern: [], perGame: [], totalReports: 0, totalGames: 0 });
    expect(aggregateLibraryPatterns(null, ['1'], OPTIMIZATION_PATTERNS))
      .toEqual({ perPattern: [], perGame: [], totalReports: 0, totalGames: 0 });
    expect(aggregateLibraryPatterns([mkReport('1', 'gamemode helps')], [], OPTIMIZATION_PATTERNS))
      .toEqual({ perPattern: [], perGame: [], totalReports: 0, totalGames: 0 });
  });

  test('reports outside the owned set are dropped', () => {
    const reports = [
      mkReport('111', 'gamemoderun works'),
      mkReport('222', 'gamemoderun works'),  // not owned
    ];
    const out = aggregateLibraryPatterns(reports, ['111'], OPTIMIZATION_PATTERNS);
    expect(out.totalReports).toBe(1);
    expect(out.totalGames).toBe(1);
    expect(out.perPattern.find(p => p.key === 'gamemode')?.gameCount).toBe(1);
  });

  test('per-pattern rollup counts distinct games, not raw report count', () => {
    const reports = [
      mkReport('100', 'gamemoderun ftw'),
      mkReport('100', 'gamemoderun again'),   // same game, 2 reports
      mkReport('200', 'mangohud shows drops'),
      mkReport('300', 'gamemoderun helps'),
    ];
    const owned = new Set(['100', '200', '300']);
    const out = aggregateLibraryPatterns(reports, owned, OPTIMIZATION_PATTERNS);
    const gamemode = out.perPattern.find(p => p.key === 'gamemode');
    expect(gamemode).toBeDefined();
    expect(gamemode.gameCount).toBe(2);        // games 100 + 300
    expect(gamemode.reportCount).toBe(3);      // 2 reports on 100 + 1 on 300
    const mango = out.perPattern.find(p => p.key === 'mangohud');
    expect(mango.gameCount).toBe(1);
    expect(mango.reportCount).toBe(1);
  });

  test('per-pattern is sorted by gameCount desc, then reportCount desc', () => {
    const reports = [
      // gamemode: 3 games, 3 reports
      mkReport('1', 'gamemoderun'),
      mkReport('2', 'gamemoderun'),
      mkReport('3', 'gamemoderun'),
      // mangohud: 1 game, 4 reports
      mkReport('4', 'mangohud'),
      mkReport('4', 'mangohud'),
      mkReport('4', 'mangohud'),
      mkReport('4', 'mangohud'),
    ];
    const out = aggregateLibraryPatterns(reports, ['1','2','3','4'], OPTIMIZATION_PATTERNS);
    expect(out.perPattern[0].key).toBe('gamemode');   // 3 games > 1 game
    expect(out.perPattern[1].key).toBe('mangohud');
  });

  test('perGame lists top pattern per owned game, sorted by reportCount desc', () => {
    const reports = [
      mkReport('111', 'gamemoderun + mangohud helps'),  // 1 report, 2 patterns
      mkReport('222', 'mangohud'),
      mkReport('222', 'mangohud'),
      mkReport('222', 'mangohud'),                      // 3 reports, 1 pattern
    ];
    const out = aggregateLibraryPatterns(reports, ['111', '222'], OPTIMIZATION_PATTERNS);
    expect(out.perGame).toHaveLength(2);
    expect(out.perGame[0].appId).toBe('222');           // more reports first
    expect(out.perGame[0].topPattern).toBe('mangohud');
    expect(out.perGame[1].appId).toBe('111');
    expect(out.perGame[1].patterns).toEqual(expect.arrayContaining(['gamemode', 'mangohud']));
  });

  test('games with reports but no pattern hits do not appear in perGame', () => {
    const reports = [
      mkReport('999', 'no keywords here'),
      mkReport('111', 'gamemoderun'),
    ];
    const out = aggregateLibraryPatterns(reports, ['999', '111'], OPTIMIZATION_PATTERNS);
    // scanned 2 reports across 2 games, but only 1 game surfaces in perGame
    expect(out.totalReports).toBe(2);
    expect(out.totalGames).toBe(2);
    expect(out.perGame.map(g => g.appId)).toEqual(['111']);
  });

  test('appId is coerced to string so a numeric row from JSON still matches a string owned-set', () => {
    const reports = [{ app_id: 111, notes: 'gamemoderun' }];   // numeric
    const owned = new Set(['111']);                            // string set
    const out = aggregateLibraryPatterns(reports, owned, OPTIMIZATION_PATTERNS);
    expect(out.totalGames).toBe(1);
    expect(out.perPattern[0].key).toBe('gamemode');
  });

  test('empty pattern group yields empty shape', () => {
    const reports = [mkReport('1', 'gamemoderun')];
    const out = aggregateLibraryPatterns(reports, ['1'], []);
    expect(out.perPattern).toEqual([]);
    expect(out.perGame).toEqual([]);
  });
});
