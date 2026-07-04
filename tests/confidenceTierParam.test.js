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
