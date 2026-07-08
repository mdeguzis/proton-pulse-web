const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'game-stats', 'main.js'),
  'utf8'
);

describe('game-stats page: ProtonDB live summary integration (#219)', () => {
  test('loadProtonDbLive hits the same edge fn the game page uses', () => {
    expect(src).toContain("PROTONDB_LIVE_URL");
    expect(src).toContain("functions/v1/protondb-summary");
    expect(src).toContain("async function loadProtonDbLive(appId)");
  });

  test('run() fetches the live summary in parallel with mirror data', () => {
    expect(src).toMatch(/const \[cdnReports, searchIndex, pulseReports, configs, liveSummary\] = await Promise\.all\(\[/);
    expect(src).toMatch(/loadProtonDbLive\(appId\),?/);
  });

  test('no-mirror branch renders live summary block instead of a bare error', () => {
    expect(src).toContain("gs-live-summary");
    expect(src).toContain("gs-live-summary-tier");
    expect(src).toContain("gs-live-summary-total");
    expect(src).toContain("ProtonDB report");
    expect(src).toContain("we haven't mirrored");
  });

  test('renderHeader accepts liveTotal + shows the effective ProtonDB count', () => {
    expect(src).toContain("liveTotal = 0");
    expect(src).toContain("Math.max(protonDbCount, liveTotal)");
    expect(src).toContain("(live)");
  });

  test('renderAll receives liveTotal so the header stays consistent when reports exist', () => {
    expect(src).toContain("liveTotal: liveSummary?.total || 0");
  });
});
