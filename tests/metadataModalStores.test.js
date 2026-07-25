/**
 * #400: the Metadata modal must be store-aware. Steam ids walk the
 * appdetails path; gog:/epic:/pgwiki: ids render from client-held data
 * (their APIs cannot be reached from the browser -- Steam appdetails
 * cannot know those ids at all, and GOG/Epic CORS-lock their APIs).
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/app/components/game-page.js'),
  'utf8',
);

describe('metadata modal store routing (#400)', () => {
  test('derives the store from the app id before any fetch', () => {
    expect(SRC).toMatch(/const storeType = appTypeFromAppId\(appId\);/);
  });

  test('non-Steam ids branch to the non-Steam renderer, never Steam appdetails', () => {
    expect(SRC).toMatch(/if \(storeType !== 'steam'\) \{\s*await _renderNonSteamMetadata\(modal, appId, storeType\);\s*return;/);
  });

  test('loading copy names the actual store, not always Steam', () => {
    expect(SRC).toContain('Loading ${esc(storeLabel(storeType))} metadata...');
    expect(SRC).not.toContain('Loading Steam metadata...');
  });

  test('pgwiki renders from pcgwiki-catalog.json with the CC attribution', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    expect(fn).toContain("dataUrl('pcgwiki-catalog.json')");
    expect(fn).toContain('CC BY-NC-SA 3.0');
    // wiki_url is only trusted on the pcgamingwiki.com origin
    expect(fn).toMatch(/wiki_url.*startsWith\('https:\/\/www\.pcgamingwiki\.com\/'\)/);
  });

  test('pgwiki shows engine, developers, publishers, release year, OS chips', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    for (const bit of ["entry?.engine", "entry?.developers", "entry?.publishers", 'release_year', 'humanPCGamingWikiOs']) {
      expect(fn).toContain(bit);
    }
  });

  test('gog/epic read the pipeline-published store block from per-app metadata.json', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    expect(fn).toContain('data/${appIdToDir(appId)}/metadata.json');
    expect(fn).toMatch(/raw\.store === 'object'/);
    // renders the pipeline facts
    for (const bit of ['store?.developers', 'store?.publishers', 'store?.genres', 'store?.os']) {
      expect(fn).toContain(bit);
    }
  });

  test('store_link from the pipeline is origin-checked before use', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    expect(fn).toMatch(/www\\\.gog\\\.com\|store\\\.epicgames\\\.com/);
  });

  test('fallback links when no store block yet: GOG DB by bare id, Epic store search', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    expect(fn).toContain('https://www.gogdb.org/product/');
    expect(fn).toMatch(/replace\(\/\^\(gog\|epic\):\/, ''\)/);
    expect(fn).toContain('store.epicgames.com');
  });
});


describe('aggregate fallback for catalog-only stubs', () => {
  test('modal falls back to nonsteam-metadata.json when per-app metadata.json is absent', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    expect(fn).toContain("dataUrl('nonsteam-metadata.json')");
    // per-app file is tried FIRST (colocation is the source of truth)
    expect(fn.indexOf('metadata.json')).toBeLessThan(fn.indexOf('nonsteam-metadata.json'));
  });

  test('deploy plumbing ships the aggregate on every surface', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts/publish-cloudflare.sh'), 'utf8');
    const shell = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/publish-shell.yml'), 'utf8');
    const data = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/update-data.yml'), 'utf8');
    for (const src of [sh, shell, data]) expect(src).toContain('nonsteam-metadata.json');
  });
});
