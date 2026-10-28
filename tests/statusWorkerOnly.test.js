// #519: the status page reads only the pp-edge-status worker. The static
// edge-status.json fallback was dead after the Cloudflare Pages move (the
// path answers with the SPA HTML), and the GitHub Actions cron that fed it
// ran in parallel with the worker.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'js/status/main.js'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/edge-fn-health.yml'), 'utf8');

describe('status page reads the worker only (#519)', () => {
  test('no static edge-status.json fallback fetch remains', () => {
    expect(MAIN).not.toMatch(/dataUrl\(\s*['"]edge-status\.json['"]\s*\)/);
  });

  test('worker failures surface a readable reason instead of a JSON parse error', () => {
    expect(MAIN).toContain("throw new Error('Status service unreachable')");
    expect(MAIN).toContain('Status service unreachable (HTTP ${res.status})');
  });

  test('the edge-fn-health workflow no longer runs on a schedule but can still be run by hand', () => {
    expect(WORKFLOW).not.toMatch(/^\s*schedule:/m);
    expect(WORKFLOW).not.toMatch(/cron:/);
    expect(WORKFLOW).toMatch(/^\s*workflow_dispatch:/m);
  });
});
