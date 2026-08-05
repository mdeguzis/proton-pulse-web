/**
 * PCGWiki (pw_*) game page must resolve title + header cover from the
 * pcgwiki-catalog.json snapshot -- otherwise the header renders "App pw_xxx"
 * and a portrait Steam CDN placeholder that 404s (#463). The search dropdown
 * already reads the same catalog for the widescreen result; the game page
 * needs the same source of truth so both surfaces agree.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8',
);

describe('game-page pgwiki title + cover fallback (#463)', () => {
  test('ships a shared _pgwikiEntryFor helper backed by a module-level fetch cache', () => {
    // One fetch per session no matter how many code paths ask for the
    // catalog. Fetch failure returns an empty catalog so the game page
    // gracefully falls through to the App <id> label.
    expect(SRC).toContain('let _pgwikiCatalogPromise = null');
    expect(SRC).toContain('async function _loadPgwikiCatalog()');
    expect(SRC).toContain('async function _pgwikiEntryFor(appId)');
    expect(SRC).toContain("appTypeFromAppId(appId) !== 'pgwiki'");
    expect(SRC).toContain("await dataUrl('pcgwiki-catalog.json')");
  });

  test('title resolution chain uses the pgwiki entry name after index + steam catalog fallbacks', () => {
    // The pgwiki fallback runs late (after report/config/index/steam catalog)
    // so a real report title still wins when both sources have data.
    expect(SRC).toContain('const pgwikiEntry = await _pgwikiEntryFor(appId)');
    expect(SRC).toContain('if (!resolvedTitle && pgwikiEntry?.name) resolvedTitle = pgwikiEntry.name');
  });

  test('header art prefers pgwiki cover_url when present, falls back to Steam CDN', () => {
    // Search dropdown shows the widescreen cover for pgwiki entries; game
    // page must match. Steam CDN URL stays as the fallback so numeric Steam
    // appids keep their old behaviour.
    expect(SRC).toMatch(/src="\$\{esc\(pgwikiEntry\?\.cover_url \|\| STEAM_IMG\(appId\)\)\}"/);
  });

  test('stub-branch pgwiki lookup routes through the shared helper too', () => {
    // Prior code fetched pcgwiki-catalog.json inline in the stub branch AND
    // again during the full render. Now both paths share the memoized
    // _pgwikiEntryFor helper so the browser only fetches the catalog once.
    const stubBlock = SRC.match(/if \(!stubTitle && appTypeFromAppId\(appId\) === 'pgwiki'\) \{([\s\S]*?)\}/);
    expect(stubBlock).not.toBeNull();
    expect(stubBlock[1]).toContain('await _pgwikiEntryFor(appId)');
    expect(stubBlock[1]).not.toContain("await fetch(await dataUrl('pcgwiki-catalog.json'))");
  });
});
