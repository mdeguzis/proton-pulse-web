/**
 * Every helper a module CALLS must be one it imports.
 *
 * Motivating bug: game-page.js called loadVrIndex() and vrForApp() without
 * importing js/app/lib/vr-index.js. Both were undefined at runtime, so the
 * block threw a ReferenceError -- and because it is a
 * `void (async () => {...})()` with no catch, the throw became an unhandled
 * rejection. The VR chip, the VR-only banner AND the artwork badges all
 * vanished together with an empty console, and it survived a full pre-push
 * plus several deploys because nothing here executes that path.
 *
 * The import went missing because a scripted replace did not match and was
 * not asserted, which is exactly the silent failure this repo's own
 * no-silent-failures rule warns about.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

// Helpers that are only ever legitimate via an import. Deliberately narrow:
// this guards the modules where a missing import fails silently rather than
// trying to be a general linter.
const GUARDED = {
  'lib/vr-index.js': ['loadVrIndex', 'vrForApp', 'matchesVrFilter'],
  'lib/vrdb.js': ['getVrdbForApp', 'loadVrdb', 'bestVrdbRuntime'],
  'shared/vr.js': ['normalizePlayMode', 'normalizeVrRuntime', 'vrRuntimeLabel', 'vrdbRatingColor'],
};

function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const FILES = jsFiles(path.join(REPO, 'js'));

describe('called helpers are imported', () => {
  const cases = [];
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [module, helpers] of Object.entries(GUARDED)) {
      // The module never needs to import itself.
      if (file.endsWith(module.split('/').pop()) && file.includes(module.split('/')[0])) continue;
      for (const helper of helpers) {
        const called = new RegExp(`\\b${helper}\\s*\\(`).test(src);
        if (!called) continue;
        // Defined locally (the module itself) rather than called as an import.
        if (new RegExp(`(function|const|let)\\s+${helper}\\b`).test(src)) continue;
        cases.push([path.relative(REPO, file), helper, module, src]);
      }
    }
  }

  test('the scan finds real call sites', () => {
    // Guard the guard: if the helpers are renamed this test would pass by
    // examining nothing.
    expect(cases.length).toBeGreaterThan(0);
  });

  test.each(cases.map(([f, h, m]) => [f, h, m]))(
    '%s calls %s so it must import %s',
    (file, helper, module) => {
      const src = fs.readFileSync(path.join(REPO, file), 'utf8');
      const base = module.split('/').pop();
      // Import of the right module, and the helper named in it.
      const importLine = (src.match(new RegExp(`^import \\{[^}]*\\} from '[^']*${base.replace('.', '\\.')}[^']*';`, 'm')) || [])[0];
      expect(importLine).toBeDefined();
      expect(importLine).toContain(helper);
    },
  );
});
