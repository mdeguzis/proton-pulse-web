/**
 * Source-scan tests for the anti-cheat frontend lib + integration into the
 * metadata modal on the game page (#242).
 */
const fs = require('fs');
const path = require('path');

const LIB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/app/lib/anti-cheat.js'),
  'utf8',
);
const PAGE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/app/components/game-page.js'),
  'utf8',
);
const MANIFEST = fs.readFileSync(
  path.join(__dirname, '..', 'gh-pages-manifest.txt'),
  'utf8',
);

describe('anti-cheat lib', () => {
  test('bucketAntiCheatStatus maps the AreWeAntiCheatYet vocabulary', () => {
    for (const s of ['supported', 'running']) expect(LIB_SRC).toContain(`status === '${s}'`);
    for (const s of ['broken', 'denied']) expect(LIB_SRC).toContain(`status === '${s}'`);
    // planned + missing collapse into 'unknown' via the trailing return.
    expect(LIB_SRC).toContain("return 'works'");
    expect(LIB_SRC).toContain("return 'broken'");
    expect(LIB_SRC).toContain("return 'unknown'");
  });

  test('loadAntiCheatMap memoizes + never throws', () => {
    // Cached at module scope so subsequent callers await the same fetch.
    expect(LIB_SRC).toMatch(/let _cache = null/);
    expect(LIB_SRC).toMatch(/let _pending = null/);
    // Error-tolerant: return {} on any failure so callers can stay optimistic.
    expect(LIB_SRC).toMatch(/catch \{\s*return \{\}/);
  });

  test('humanAntiCheatStatus covers every upstream status value', () => {
    for (const s of ['supported', 'running', 'broken', 'denied', 'planned']) {
      expect(LIB_SRC).toContain(s);
    }
  });
});

describe('metadata modal integration', () => {
  test('imports the lookup helpers from the anti-cheat lib', () => {
    expect(PAGE_SRC).toMatch(/getAntiCheatForApp[\s\S]{0,80}bucketAntiCheatStatus[\s\S]{0,80}humanAntiCheatStatus/);
    expect(PAGE_SRC).toMatch(/from ['"]\.\.\/lib\/anti-cheat\.js/);
  });

  test('modal fetches anti-cheat data alongside meta / depot / news', () => {
    // Same Promise.all block so a slow upstream does not serialize the modal.
    expect(PAGE_SRC).toMatch(/Promise\.all\(\[[\s\S]{0,1200}getAntiCheatForApp\(appId\)/);
  });

  test('Anti-cheat section is rendered near the top of the modal', () => {
    // Between Name and App ID -- so the deal-breaker signal is above the fold.
    expect(PAGE_SRC).toMatch(
      /section\('Name'[\s\S]{0,200}section\('Anti-cheat'[\s\S]{0,200}section\('App ID'/,
    );
  });

  test('block is empty when no upstream entry exists (does not falsely claim clean)', () => {
    expect(PAGE_SRC).toMatch(/if \(!antiCheat[\s\S]{0,80}return ''/);
  });

  test('block cites AreWeAntiCheatYet as the source with a link', () => {
    expect(PAGE_SRC).toContain('https://areweanticheatyet.com/');
  });
});

describe('manifest', () => {
  test('js/app/lib/anti-cheat.js is listed for gh-pages deploy', () => {
    expect(MANIFEST).toContain('js/app/lib/anti-cheat.js');
  });
});
