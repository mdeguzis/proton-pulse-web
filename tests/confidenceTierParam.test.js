/**
 * #192: the confidence breakdown must show the same overall tier as the game
 * page. The game page factors in native Pulse reports the CDN-only confidence
 * page can't see, so instead of recomputing, the game page passes its
 * authoritative tier via ?tier= and the breakdown prefers it.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const GAME = read('js/app/components/game-page.js');
const CONF = read('js/confidence/main.js');

describe('confidence tier hand-off (#192)', () => {
  test('game page passes overallTier on both the dial link and the why link', () => {
    // dial link
    expect(GAME).toContain('grp-dial-link" href="confidence.html?app=${appId}&tier=${overallTier}"');
    // why link
    expect(GAME).toContain('href="confidence.html?app=${appId}&tier=${overallTier}"');
  });

  test('confidence page prefers the passed tier over its local mode', () => {
    expect(CONF).toContain("new URLSearchParams(location.search).get('tier')");
    expect(CONF).toContain('TIER_ORDER.includes(_tierParam) ? _tierParam : null');
    // local mode is only the fallback now
    expect(CONF).toContain('if (!overallTier && n > 0)');
  });
});

describe('confidence page data loaders route through dataUrl (#380/#361)', () => {
  test('the game title comes from the batch API, not the search-index blob (#437)', () => {
    expect(CONF).toMatch(/getGamesByIds\(\[appId\]\)/);
    expect(CONF).not.toMatch(/dataUrl\('search-index\.json'\)/);
    expect(CONF).not.toMatch(/_usesProdData/);
  });

  test('legacy CDN_BASE / SITE_BASE constants are gone', () => {
    expect(CONF).not.toMatch(/const\s+CDN_BASE\s*=/);
    expect(CONF).not.toMatch(/const\s+SITE_BASE\s*=/);
    expect(CONF).not.toMatch(/proton-pulse-web-staging/);
  });
});

describe('confidence page dedups CDN pulse mirror against live Supabase (#430)', () => {
  // #430 was the sister bug to #423: game page dedups on pulseId/reportId via
  // mergeReportsById, confidence page did NOT and merged CDN + native naively.
  // Every game with a mirrored pulse row ended up double-counting the same
  // submission, so the aggregate confidence % ran higher than the game-page
  // dial for the same app. Guard the import + call-site here so a future
  // refactor cannot silently drift back to the raw-spread merge.
  test('imports mergeReportsById from app/utils.js', () => {
    expect(CONF).toMatch(/import\s*\{\s*mergeReportsById\s*\}\s*from\s*['"]\.\.\/app\/utils\.js/);
  });

  test('reports merge goes through mergeReportsById, not a raw spread', () => {
    expect(CONF).toMatch(/mergeReportsById\(cdnReports,\s*nativeReports\s*\|\|\s*\[\]\)/);
    // The old naive form must be gone -- catches a "just spread them" revert.
    expect(CONF).not.toMatch(/\[\.\.\.cdnReports\.map\([^)]*\),\s*\.\.\.\(nativeReports/);
  });
});
