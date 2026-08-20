/**
 * Every top-level data file the frontend fetches must actually be deployed.
 *
 * Found via #246: vr-index.json and vrdb.json were written by the pipeline,
 * listed in gh-pages-manifest.txt and the update-data.yml copy loops, and
 * still never reached the site -- because the Cloudflare publish path
 * (#362) keeps its OWN list in publish-cloudflare.sh, a third registration
 * point that is easy to miss.
 *
 * The failure mode is what makes this worth a test: Cloudflare Pages answers
 * an unknown path with the SPA fallback, so the fetch gets HTTP 200 and an
 * HTML body. Every one of these loaders treats a bad payload as "no data" and
 * renders nothing, so a missing file looks exactly like a game having no
 * entry. anti-cheat.json had been broken on PROD this way since the migration
 * and nothing surfaced it.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PUBLISH_SH = fs.readFileSync(path.join(REPO, 'scripts', 'publish-cloudflare.sh'), 'utf8');
const PUBLISH_SHELL_YML = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'publish-shell.yml'), 'utf8');

// publish-shell.yml keeps a SECOND list: the shell-only deploy re-fetches
// these from the live site so a CSS-tweak deploy does not wipe pipeline data
// it never built. A file in SMALL_DATA but missing here survives the pipeline
// and then vanishes on the next shell deploy -- which is how vr-index.json,
// vrdb.json and anti-cheat.json went missing while looking fine for hours.
const PRESERVED = (() => {
  const lines = PUBLISH_SHELL_YML.split('\n');
  const start = lines.findIndex((l) => /^\s*FILES=\(/.test(l));
  if (start === -1) throw new Error('FILES=( not found in publish-shell.yml');
  const names = new Set();
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\)\s*$/.test(lines[i])) return names;
    for (const t of lines[i].replace(/#.*$/, '').split(/\s+/)) if (t) names.add(t);
  }
  throw new Error('FILES=( is not terminated');
})();

// Parse the SMALL_DATA array into a set of filenames. Tokenizing beats
// regex-matching the raw file on two counts: it checks the actual shipping
// list rather than any mention anywhere in the script, and it needs no
// escaping of the filename (building a regex from a string and escaping only
// dots is what CodeQL flags as incomplete string escaping).
// Line-based, not a `\(([\s\S]*?)\)` match: a non-greedy scan for the closing
// paren stops at the first ')' anywhere in the block, including one inside a
// comment, which silently truncates the list and makes this test pass for
// files that are NOT shipped.
const SHIPPED = (() => {
  const lines = PUBLISH_SH.split('\n');
  const start = lines.findIndex((l) => /^\s*SMALL_DATA=\(/.test(l));
  if (start === -1) throw new Error('SMALL_DATA array not found in publish-cloudflare.sh');
  const names = new Set();
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\)\s*$/.test(lines[i])) return names;   // closing paren on its own line
    for (const token of lines[i].replace(/#.*$/, '').split(/\s+/)) {
      if (token) names.add(token);
    }
  }
  throw new Error('SMALL_DATA array is not terminated');
})();

// Files fetched through dataUrl() that are deliberately NOT shipped to the
// site root. Each needs a reason -- this list is the escape hatch, so an
// unexplained entry defeats the point of the test.
const KNOWN_UNSHIPPED = new Map([
  // Served by the pp-edge-status Worker, not the pipeline (see the CSP
  // connect-src entry on status.html), so there is no artifact to publish.
  ['edge-status.json', 'served by the edge-status Worker, not the pipeline'],
  // Admin-only box-art tooling. These are large probe caches; the admin page
  // degrades to "no cache data" rather than breaking, and shipping tens of MB
  // of cache to every visitor to serve one admin screen is the wrong trade.
  ['game-images-cache.json', 'admin-only probe cache, too large to ship'],
  ['nonsteam-images-cache.json', 'admin-only probe cache, too large to ship'],
  // Profile app-type breakdown. Same reasoning: a large cache behind one
  // optional widget that already handles absence.
  ['steam-type-cache.json', 'large cache behind an optional profile widget'],
  // Shipped, just not via SMALL_DATA: preserve-cert-monitor.sh (invoked by
  // publish-cloudflare.sh) carries these across the deploy because they
  // accumulate history that a fresh pipeline output does not contain. Both
  // verified serving application/json on prod.
  ['cert-status.json', 'shipped by preserve-cert-monitor.sh, not SMALL_DATA'],
  ['cert-history.json', 'shipped by preserve-cert-monitor.sh, not SMALL_DATA'],
]);

function requestedDataFiles() {
  const files = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/dataUrl\(\s*'([^']+)'\s*\)/g)) files.add(m[1]);
    }
  };
  walk(path.join(REPO, 'js'));
  return [...files].sort();
}

describe('pipeline data files reach the deployed site', () => {
  const requested = requestedDataFiles();

  test('the scan finds the known data fetches', () => {
    // Guard the guard: if dataUrl() is renamed or the call shape changes, the
    // scan would silently match nothing and every assertion below would pass.
    expect(requested.length).toBeGreaterThan(10);
    expect(requested).toContain('search-index.json');
  });

  test.each(requested.filter((f) => !f.startsWith('data/')))(
    '%s is in publish-cloudflare.sh SMALL_DATA (or documented as unshipped)',
    (file) => {
      if (KNOWN_UNSHIPPED.has(file)) {
        expect(KNOWN_UNSHIPPED.get(file)).toBeTruthy();
        return;
      }
      // Exact set membership, so 'game-images.json' cannot satisfy
      // 'game-images-cache.json'.
      expect(SHIPPED.has(file)).toBe(true);
    },
  );

  test('the #246 files and the anti-cheat regression are covered', () => {
    for (const f of ['vr-index.json', 'vrdb.json', 'anti-cheat.json']) {
      expect(SHIPPED.has(f)).toBe(true);
    }
  });

  test('every shipped data file is also preserved across shell deploys', () => {
    // Otherwise the file ships on a pipeline run and disappears the next time
    // someone deploys a CSS change, which reads as "it worked yesterday".
    const jsonOnly = [...SHIPPED].filter((f) => f.endsWith('.json'));
    const missing = jsonOnly.filter((f) => !PRESERVED.has(f));
    expect(missing).toEqual([]);
  });

  test('data/ paths are exempt because they reroute to R2', () => {
    // dataUrl() only rewrites the host for data/ prefixed paths; those are
    // synced wholesale by publish-cloudflare.sh rather than named individually.
    const dataPaths = requested.filter((f) => f.startsWith('data/'));
    for (const f of dataPaths) expect(f.startsWith('data/')).toBe(true);
  });
});
