/**
 * Source-scan guards for the admin Deployments tab (#367). Post-CF Pages
 * migration a push can end up on any of four workflows (publish-shell,
 * deploy-worker, build-site-data finalize, deploy-functions) and users
 * had no single place to see which SHA was actually live. This tab is
 * that place; the checks below pin the pieces that make it useful.
 */
const fs = require('fs');
const path = require('path');

const COMP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'components', 'deployments.js'),
  'utf8',
);
const ADMIN_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'admin.html'),
  'utf8',
);
const ADMIN_MAIN = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'main.js'),
  'utf8',
);
const PERMISSIONS = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'permissions.js'),
  'utf8',
);
const MANIFEST = fs.readFileSync(
  path.join(__dirname, '..', 'gh-pages-manifest.txt'),
  'utf8',
);

describe('Deployments tab is wired into the admin panel', () => {
  test('admin.html carries the tab option + hidden section', () => {
    expect(ADMIN_HTML).toMatch(/<option value="deployments">Deployments<\/option>/);
    expect(ADMIN_HTML).toMatch(/id="tab-deployments"/);
  });

  test('permissions.js gates the tab on view_analytics', () => {
    // Same audience as the Logging + Analytics tabs -- diagnostic /
    // observability. If someone adds a distinct perm later this test
    // stops passing and the discussion happens.
    expect(PERMISSIONS).toMatch(/deployments:\s*\[['"]view_analytics['"]\]/);
  });

  test('admin main.js imports the component + wires it into TAB_LOADERS', () => {
    expect(ADMIN_MAIN).toMatch(/import\s*\{\s*renderDeploymentsTab\s*\}\s*from\s*['"]\.\/components\/deployments\.js/);
    expect(ADMIN_MAIN).toMatch(/deployments:\s*\(\)\s*=>\s*\{\s*renderDeploymentsTab\(\)/);
  });

  test('gh-pages-manifest.txt includes the new component file', () => {
    // Without this the ES-module import 404s on the deployed shell and
    // clicking the Logging or Deployments tab silently breaks with a
    // module-load error in the console.
    expect(MANIFEST).toContain('js/admin/components/deployments.js');
  });

  test('admin.html CSP connect-src allows api.github.com for the runs fetch', () => {
    // Deployments fetches directly from the GitHub Actions API; without
    // this CSP allow, the browser blocks the request and the tab shows a
    // generic error instead of the run list.
    expect(ADMIN_HTML).toMatch(/connect-src[^;]*https:\/\/api\.github\.com/);
  });
});

describe('component fetches the right workflows', () => {
  test('whitelist covers every workflow that actually deploys', () => {
    // Adding a new deploy workflow requires adding it here or it will be
    // invisible on the Deployments tab -- easy to miss when merging.
    expect(COMP_SRC).toContain("'Publish Shell to Cloudflare Pages'");
    expect(COMP_SRC).toContain("'Deploy Cloudflare Workers'");
    expect(COMP_SRC).toContain("'Build Site Data'");
    expect(COMP_SRC).toContain("'Deploy Cloudflare Functions'");
  });

  test('hits the public actions runs endpoint (no auth needed)', () => {
    // Unauthed reads work on public repos; rate limit is 60/hr per IP.
    // If a future refactor tries to authenticate this from the frontend
    // it would need a PAT which we do not want on the client.
    expect(COMP_SRC).toContain('api.github.com/repos/mdeguzis/proton-pulse-web/actions/runs');
  });

  test('per-branch target inference for publish-shell distinguishes staging vs prod', () => {
    // The whole point of the tab is telling you where a specific push
    // landed. If both branches inferred the same target it would be
    // misleading.
    expect(COMP_SRC).toContain('staging.proton-pulse.com');
    expect(COMP_SRC).toContain('www.proton-pulse.com');
  });

  test('caches results in sessionStorage with a short TTL', () => {
    // 60 req/hr rate limit means we must not fire on every render.
    // Cache TTL should be short (tens of seconds), long (minutes) would
    // hide fresh deploys.
    expect(COMP_SRC).toMatch(/pp:admin:deployments/);
    expect(COMP_SRC).toMatch(/CACHE_TTL_MS\s*=\s*\d+\s*\*\s*1000/);
  });
});
