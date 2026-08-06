/**
 * SGDB widescreen cover for non-Steam games (#466). The pipeline emits
 * sgdb-covers.json = { canonical_id: sgdb_grid_url }; the game page uses
 * it as the highest-priority source for the header art so pgwiki portrait
 * covers get replaced with a 460x215 widescreen grid that fits the same
 * slot as a Steam header.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8',
);

describe('game-page SGDB cover fallback (#466)', () => {
  test('ships a memoized _loadSgdbCovers helper reading sgdb-covers.json', () => {
    expect(SRC).toContain('let _sgdbCoversPromise = null');
    expect(SRC).toContain('async function _loadSgdbCovers()');
    expect(SRC).toContain('async function _sgdbCoverFor(appId)');
    expect(SRC).toContain("await dataUrl('sgdb-covers.json')");
  });

  test('game-page fetches the SGDB cover for the current appId at render time', () => {
    expect(SRC).toContain('const sgdbCover = await _sgdbCoverFor(appId)');
  });

  test('header art fallback order: sgdb -> pgwiki cover_url -> Steam CDN', () => {
    // SGDB is preferred because it is guaranteed 460x215 shape; pgwiki
    // covers can be portrait Steam-style. Steam CDN stays as the base
    // fallback for numeric Steam ids that never get an SGDB hit.
    expect(SRC).toMatch(/src="\$\{esc\(sgdbCover \|\| pgwikiEntry\?\.cover_url \|\| STEAM_IMG\(appId\)\)\}"/);
  });
});
