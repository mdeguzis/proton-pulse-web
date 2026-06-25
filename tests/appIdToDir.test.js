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

  test('only replaces the first colon (canonical IDs only have one)', () => {
    const { appIdToDir } = loadMod();
    // Defensive: even if a colon snuck into a tail segment, ensure we never
    // emit a leading colon dir like /:foo
    expect(appIdToDir('gog:abc:def')).toBe('gog_abc:def');
  });

  test('handles numeric coercion safely', () => {
    const { appIdToDir } = loadMod();
    expect(appIdToDir(0)).toBe('0');
  });
});
