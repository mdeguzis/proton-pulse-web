/**
 * Tests for js/lib/app-id.js -- the shared canonical-id-to-directory helper.
 * Mirrors scripts/pipeline/common.py app_id_to_dir so the frontend requests
 * the same directory the pipeline writes.
 */

const { loadEsm } = require('./_esm-vm.js');

function loadMod() {
  return loadEsm(['js/lib/app-id.js'], { console });
}

describe('appIdToDir', () => {
  test('passes Steam numeric IDs through untouched', () => {
    const { appIdToDir } = loadMod();
    expect(appIdToDir('730')).toBe('730');
    expect(appIdToDir(730)).toBe('730');
  });

  test('converts GOG canonical IDs colon -> underscore', () => {
    const { appIdToDir } = loadMod();
    expect(appIdToDir('gog:123')).toBe('gog_123');
    expect(appIdToDir('gog:1971477531')).toBe('gog_1971477531');
  });

  test('converts Epic canonical IDs colon -> underscore', () => {
    const { appIdToDir } = loadMod();
    expect(appIdToDir('epic:fortnite')).toBe('epic_fortnite');
  });

  test('replaces ALL colons so pgwiki titles match the pipeline fs layout', () => {
    const { appIdToDir } = loadMod();
    // pgwiki IDs carry colons in the wiki slug itself -- e.g.
    // pgwiki:The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay.
    // The pipeline's Python str.replace(':', '_') replaces them all;
    // the JS side must too or the browser asks for a different path
    // than what R2 has.
    expect(appIdToDir('gog:abc:def')).toBe('gog_abc_def');
    expect(appIdToDir('pgwiki:1914:_The_Great_War')).toBe('pgwiki_1914__The_Great_War');
  });

  test('handles numeric coercion safely', () => {
    const { appIdToDir } = loadMod();
    expect(appIdToDir(0)).toBe('0');
  });
});


describe('dataFilesHref uses the shared appIdToDir (data-disconnect guard)', () => {
  const fs = require('fs');
  const path = require('path');
  const CFG = fs.readFileSync(path.join(__dirname, '..', 'js/app/config.js'), 'utf8');

  test('routes through appIdToDir, never the raw canonical id', () => {
    // The mapping lives in dataFileHref now -- every per-game file link
    // (latest.json, depots.json, year buckets) shares that one builder, so
    // guarding it here covers all of them.
    expect(CFG).toMatch(/dataFileHref = \(appId, file = 'latest\.json'\) =>/);
    expect(CFG).toMatch(/appIdToDir\(appId\)/);
    expect(CFG).toMatch(/import \{ appIdToDir \} from '\.\.\/lib\/app-id\.js/);
  });

  test('dataFilesHref delegates rather than rebuilding the path', () => {
    expect(CFG).toMatch(/dataFilesHref = appId => dataFileHref\(appId, 'latest\.json'\)/);
  });
});
