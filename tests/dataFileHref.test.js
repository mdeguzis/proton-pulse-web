/**
 * dataFileHref() per-game data-file links.
 *
 * Every per-game file the pipeline emits (latest.json, year buckets,
 * votes.json, depots.json) lands in the same data/<dir>/ folder and syncs to
 * the same R2 bucket. The depot link in the metadata modal used to be a
 * hand-built `github.com/.../blob/gh-pages/data/<rawId>/depots.json` URL,
 * which 404'd twice over: gh-pages is the branch #396 archives and never
 * carried depots.json, and the raw canonical id skipped the appIdToDir
 * colon -> underscore mapping so gog:/epic: games missed the directory too.
 *
 * These pin the host routing and the id mapping so a future per-game link
 * cannot regress back to a hardcoded branch URL.
 */

function loadConfigOn(hostname) {
  jest.resetModules();
  delete global.window;
  global.window = { location: { hostname, pathname: '/', origin: `https://${hostname}` } };
  return require('../js/app/config.js');
}

afterEach(() => { delete global.window; });

describe('dataFileHref', () => {
  test('routes per-game files at the production R2 data host', () => {
    const { dataFileHref } = loadConfigOn('www.proton-pulse.com');
    expect(dataFileHref('730', 'depots.json'))
      .toBe('https://data.proton-pulse.com/data/730/depots.json');
  });

  test('staging routes at the staging data host, not prod', () => {
    const { dataFileHref } = loadConfigOn('staging.proton-pulse.com');
    expect(dataFileHref('730', 'depots.json'))
      .toBe('https://staging-data.proton-pulse.com/data/730/depots.json');
  });

  test('defaults to latest.json when no file is named', () => {
    const { dataFileHref } = loadConfigOn('www.proton-pulse.com');
    expect(dataFileHref('730')).toBe('https://data.proton-pulse.com/data/730/latest.json');
  });

  test('applies the appIdToDir colon mapping for non-Steam ids', () => {
    const { dataFileHref } = loadConfigOn('www.proton-pulse.com');
    expect(dataFileHref('gog:1207658930', 'depots.json'))
      .toBe('https://data.proton-pulse.com/data/gog_1207658930/depots.json');
    // Multi-colon pgwiki slugs must map every colon, not just the first.
    expect(dataFileHref('pgwiki:The_Chronicles:_Escape'))
      .toBe('https://data.proton-pulse.com/data/pgwiki_The_Chronicles__Escape/latest.json');
  });

  test('dataFilesHref stays a latest.json wrapper over the same builder', () => {
    const { dataFileHref, dataFilesHref } = loadConfigOn('www.proton-pulse.com');
    expect(dataFilesHref('epic:abc')).toBe(dataFileHref('epic:abc', 'latest.json'));
  });
});

describe('per-game data links do not hardcode a git branch', () => {
  test('game-page.js builds the depot link through dataFileHref', () => {
    const fs = require('fs');
    const raw = fs.readFileSync(require.resolve('../js/app/components/game-page.js'), 'utf8');
    // Strip line comments so the assertion is about code, not the comment
    // that explains why the old hardcoded branch URL was wrong.
    const code = raw.replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/github\.com\/[^\s'"`]*\/blob\//);
    expect(code).toMatch(/dataFileHref\(meta\.appId, 'depots\.json'\)/);
  });
});
