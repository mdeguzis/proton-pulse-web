/**
 * /data/* redirect on the Pages host (decky-proton-pulse#131). Plugin builds
 * up to v1.15.0 fetch www.proton-pulse.com/data/<id>/index.json, which on
 * Cloudflare Pages is the SPA HTML fallback. publish-cloudflare.sh writes a
 * _redirects rule sending /data/* to the R2 data host; run that exact line
 * and check the rule it produces.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'publish-cloudflare.sh'), 'utf8');

function writeRedirects(dataBase) {
  const line = SCRIPT.split('\n').find((l) => l.includes('> "$DEPLOY/_redirects"'));
  if (!line) throw new Error('_redirects printf not found in publish-cloudflare.sh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redir-'));
  execFileSync('bash', ['-c', line], { env: { ...process.env, DATA_BASE: dataBase, DEPLOY: dir } });
  return fs.readFileSync(path.join(dir, '_redirects'), 'utf8');
}

describe('publish-cloudflare.sh /data/* redirect', () => {
  test('prod sends /data/* to the R2 data host with the path kept', () => {
    expect(writeRedirects('https://data.proton-pulse.com'))
      .toBe('/data/* https://data.proton-pulse.com/data/:splat 302\n');
  });

  test('follows DATA_BASE so a staging pipeline deploy points at staging data', () => {
    expect(writeRedirects('https://staging-data.proton-pulse.com'))
      .toBe('/data/* https://staging-data.proton-pulse.com/data/:splat 302\n');
  });

  test('is written after data-config.json, inside the Pages deploy dir', () => {
    const cfg = SCRIPT.indexOf('"$DEPLOY/data-config.json"');
    const redir = SCRIPT.indexOf('"$DEPLOY/_redirects"');
    expect(cfg).toBeGreaterThan(-1);
    expect(redir).toBeGreaterThan(cfg);
  });
});
