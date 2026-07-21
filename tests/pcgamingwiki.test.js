/**
 * Source-scan tests for the PCGamingWiki frontend lib + integration into the
 * metadata modal on the game page (#377 slice 2).
 */
const fs = require('fs');
const path = require('path');

const LIB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/app/lib/pcgamingwiki.js'),
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
const PUBLISH_SH = fs.readFileSync(
  path.join(__dirname, '..', 'scripts/publish-cloudflare.sh'),
  'utf8',
);
const WORKFLOW = fs.readFileSync(
  path.join(__dirname, '..', '.github/workflows/update-data.yml'),
  'utf8',
);

describe('pcgamingwiki lib', () => {
  test('loadPCGamingWikiMap memoizes + never throws', () => {
    expect(LIB_SRC).toMatch(/let _cache = null/);
    expect(LIB_SRC).toMatch(/let _pending = null/);
    // Error-tolerant: return {} on any failure so callers can stay optimistic.
    expect(LIB_SRC).toMatch(/catch \{\s*return \{\}/);
  });

  test('getPCGamingWikiForApp returns null for a missing entry', () => {
    expect(LIB_SRC).toContain('return map[String(appId)] || null;');
  });

  test('humanPCGamingWikiOs maps the enricher OS vocabulary to display strings', () => {
    // The enricher writes lowercase strings from the whitelist:
    // windows / os x / linux / dos. Every one has a display label.
    expect(LIB_SRC).toContain("'windows': 'Windows'");
    expect(LIB_SRC).toContain("'os x': 'macOS'");
    expect(LIB_SRC).toContain("'linux': 'Linux'");
    expect(LIB_SRC).toContain("'dos': 'DOS'");
  });

  test('pcgamingwikiSearchUrl deep-links to the PCGamingWiki search page', () => {
    // No page name is in our published data, so we search by title.
    expect(LIB_SRC).toContain('https://www.pcgamingwiki.com/w/index.php?search=');
    expect(LIB_SRC).toContain('encodeURIComponent');
  });
});

describe('metadata modal integration', () => {
  test('imports the lookup helpers from the pcgamingwiki lib', () => {
    expect(PAGE_SRC).toMatch(/getPCGamingWikiForApp[\s\S]{0,80}humanPCGamingWikiOs[\s\S]{0,80}pcgamingwikiSearchUrl/);
    expect(PAGE_SRC).toMatch(/from ['"]\.\.\/lib\/pcgamingwiki\.js/);
  });

  test('modal fetches PGWiki data alongside meta / depot / news / anti-cheat', () => {
    // Same Promise.all so a slow PGWiki call does not serialize the modal.
    expect(PAGE_SRC).toMatch(/Promise\.all\(\[[\s\S]{0,1600}getPCGamingWikiForApp\(appId\)/);
  });

  test('PCGamingWiki section is rendered right after Anti-cheat', () => {
    expect(PAGE_SRC).toMatch(
      /section\('Anti-cheat'[\s\S]{0,200}section\('PCGamingWiki'[\s\S]{0,200}section\('App ID'/,
    );
  });

  test('block is empty when no PGWiki entry exists (does not falsely claim clean)', () => {
    expect(PAGE_SRC).toMatch(/if \(!pgw[\s\S]{0,80}return ''/);
  });

  test('block cites PCGamingWiki + license as the source with a link', () => {
    // CC BY-NC-SA 3.0 requires visible credit + link back.
    expect(PAGE_SRC).toContain('pcgamingwikiSearchUrl');
    expect(PAGE_SRC).toContain('PCGamingWiki');
    expect(PAGE_SRC).toContain('CC BY-NC-SA 3.0');
  });
});

describe('manifest + publish', () => {
  test('js/app/lib/pcgamingwiki.js is listed for gh-pages deploy', () => {
    expect(MANIFEST).toContain('js/app/lib/pcgamingwiki.js');
  });

  test('pcgamingwiki.json is copied to CF Pages by publish-cloudflare.sh', () => {
    expect(PUBLISH_SH).toContain('pcgamingwiki.json');
  });

  test('pcgamingwiki cache files are committed to gh-pages by update-data workflow', () => {
    // Four optional-files loops (staging/prod + pages_only/full); each must
    // include the cache so the enricher's TTL survives across runs.
    const matches = WORKFLOW.match(/pcgamingwiki\.json pcgamingwiki-cache\.json/g) || [];
    expect(matches.length).toBe(4);
  });
});
