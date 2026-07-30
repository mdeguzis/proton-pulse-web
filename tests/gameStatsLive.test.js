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
    expect(src).toMatch(/const \[cdnReports, searchIndex, pulseReports, configs, liveSummary, flightlessEntry\] = await Promise\.all\(\[/);
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

describe('game-stats page: data loaders route through dataUrl (#380/#361)', () => {
  test('loadGame fetches per-game buckets via dataUrl so R2 host is honored', () => {
    expect(src).toMatch(/await\s+dataUrl\(`data\/\$\{appIdToDir\(appId\)\}\/latest\.json`\)/);
  });

  test('loadSearchIndex + loadFlightlessEntry also route through dataUrl', () => {
    expect(src).toMatch(/await\s+dataUrl\('search-index\.json'\)/);
    expect(src).toMatch(/await\s+dataUrl\('flightless-benchmarks\.json'\)/);
  });

  test('legacy CDN_BASE / SITE_BASE path-based routing is gone', () => {
    expect(src).not.toMatch(/CDN_BASE/);
    expect(src).not.toMatch(/SITE_BASE/);
    expect(src).not.toMatch(/proton-pulse-web-staging/);
  });
});

describe('game-stats page dedups CDN pulse mirror against live Supabase (#430)', () => {
  // Same failure mode as the confidence page and #423 on the game page:
  // CDN latest.json carries pulse-mirrored rows AND fetchNativeReports
  // returns the same submission live. Naive spread double-counted them,
  // inflating every downstream computeGameStats / computeConfidence.
  test('imports mergeReportsById from app/utils.js', () => {
    expect(src).toMatch(/import\s*\{\s*mergeReportsById\s*\}\s*from\s*['"]\.\.\/app\/utils\.js/);
  });

  test('allReports goes through mergeReportsById, not [ ...cdn, ...pulse ]', () => {
    expect(src).toMatch(/let allReports = mergeReportsById\(cdnReports,\s*pulseReports\)/);
    expect(src).not.toMatch(/let allReports = \[\.\.\.cdnReports,\s*\.\.\.pulseReports\]/);
  });

  test('loadPulseReports aliases id -> reportId so mergeReportsById can join', () => {
    // mergeReportsById keys on native.reportId, CDN rows carry .pulseId. Without
    // the alias the join fails silently and dedup collapses back into the
    // pre-fix double-count. Assert the map is present in loadPulseReports.
    expect(src).toMatch(/rows\.map\(\(r\)\s*=>\s*\(\s*\{\s*\.\.\.r,\s*reportId:\s*r\.id\s*\}\s*\)\)/);
  });
});
