/**
 * Validates that every relative JS import in manifest-listed files also
 * appears in gh-pages-manifest.txt.
 *
 * Catches the class of bug where a new JS file is committed and imported
 * but never added to the manifest, causing a 404 on the live site.
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'gh-pages-manifest.txt');

function readManifest() {
  return new Set(
    fs.readFileSync(MANIFEST, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#')),
  );
}

// Matches:  import { x } from './foo.js'
//           import './bar.js'
//           export { x } from './baz.js'
const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*\s+from\s+)?['"](\.[^'"]+)['"]/g;

function collectImports(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const imports = [];
  let m;
  // reset lastIndex each call
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const specifier = m[1];
    // skip external URLs (shouldn't appear but guard anyway)
    if (specifier.startsWith('http')) continue;
    const abs = path.resolve(path.dirname(filePath), specifier);
    const rel = path.relative(ROOT, abs);
    imports.push({ specifier, rel });
  }
  return imports;
}

describe('gh-pages-manifest completeness', () => {
  const manifest = readManifest();
  const jsFiles  = [...manifest].filter(p => p.endsWith('.js'));

  test('manifest file exists', () => {
    expect(fs.existsSync(MANIFEST)).toBe(true);
  });

  test('every manifest JS file exists on disk', () => {
    const missing = jsFiles.filter(f => !fs.existsSync(path.join(ROOT, f)));
    expect(missing).toEqual([]);
  });

  test('every relative import in a manifest JS file is itself in the manifest', () => {
    const violations = [];
    for (const relPath of jsFiles) {
      const abs = path.join(ROOT, relPath);
      for (const { specifier, rel } of collectImports(abs)) {
        if (!manifest.has(rel)) {
          violations.push(`${relPath} imports '${specifier}' -> '${rel}' (not in manifest)`);
        }
      }
    }
    if (violations.length) {
      // Print each violation for easy diagnosis
      violations.forEach(v => console.error('MANIFEST VIOLATION:', v));
    }
    expect(violations).toEqual([]);
  });
});
