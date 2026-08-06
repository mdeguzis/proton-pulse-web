/**
 * sgdb-covers.json must ride the publish paths so the JS consumer never
 * 404s on it. Live-target preservation on the shell publish AND the
 * SMALL_DATA list on the pipeline publish both need to reference it. #466.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'publish-shell.yml'),
  'utf8',
);
const CF_SH = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'publish-cloudflare.sh'),
  'utf8',
);

describe('sgdb-covers.json ships through both publish paths (#466)', () => {
  test('publish-shell.yml preserves sgdb-covers.json from the live target on shell-only pushes', () => {
    expect(WORKFLOW).toMatch(/FILES=\([\s\S]*sgdb-covers\.json[\s\S]*\)/);
  });

  test('publish-cloudflare.sh SMALL_DATA copies sgdb-covers.json from pipeline output', () => {
    expect(CF_SH).toMatch(/SMALL_DATA=\([\s\S]*sgdb-covers\.json[\s\S]*\)/);
  });
});
