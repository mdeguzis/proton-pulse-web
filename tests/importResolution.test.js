/**
 * Static import validator. For every ES-module file under js/ that uses
 * `import { A, B } from './foo.js?v=...'`, verify that ./foo.js actually
 * exports A and B. Catches the class of bug that broke the Submit a Report
 * page (drafts.js imported SUPABASE_URL from shared/config.js which only
 * re-exports SupaAuth). #199 follow-up.
 *
 * Deliberately blunt: text-based scans, not a real ESM resolver. That keeps
 * the test fast and avoids pulling in transformers. Blind spots:
 *   - Dynamic imports and default imports are ignored on purpose.
 *   - Re-exports (`export { x } from './y.js'`) are followed one level.
 *   - Files in tests/, coverage/, node_modules/ are ignored.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_ROOT = path.join(ROOT, 'js');

// Recursively walk js/ collecting *.js files, skipping obvious non-module noise.
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Strip the `?v=<hash>` cache-buster suffix so path resolution works.
function stripVersion(spec) {
  return spec.replace(/\?v=[a-f0-9]+$/i, '');
}

// Extract every `import { A, B as C } from './foo.js'` statement in the file.
// Returns an array of { spec, names } where names is the raw list including
// any `as` renames (we only care about the source-side identifier, so we
// keep the part before `as`).
function parseImports(src) {
  const results = [];
  const re = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[2];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // skip bare pkgs
    const names = m[1]
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => x.split(/\s+as\s+/i)[0].trim())
      .filter(Boolean);
    results.push({ spec, names });
  }
  return results;
}

// Extract every named export (`export function X`, `export const X`,
// `export { A, B }`, `export { A } from './y.js'`). Returns Set<string>.
// Also returns re-export targets so the checker can follow them.
function parseExports(src) {
  const names = new Set();
  const reexports = [];

  const declRe = /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/gm;
  let m;
  while ((m = declRe.exec(src)) !== null) names.add(m[1]);

  // export { a, b as c, ... };            (local re-export)
  // export { a, b } from './y.js';        (delegated re-export)
  const groupRe = /^\s*export\s*\{([^}]+)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;?/gm;
  while ((m = groupRe.exec(src)) !== null) {
    const list = m[1].split(',').map(x => x.trim()).filter(Boolean);
    const from = m[2] || null;
    for (const item of list) {
      const parts = item.split(/\s+as\s+/i);
      const exposedName = (parts[1] || parts[0]).trim();
      names.add(exposedName);
      if (from) reexports.push({ from, name: parts[0].trim(), exposedAs: exposedName });
    }
  }

  return { names, reexports };
}

// Resolve `from` (an import specifier or re-export target) against the
// importing file's directory. Only handles relative paths.
function resolveModule(fromFile, spec) {
  const abs = path.resolve(path.dirname(fromFile), stripVersion(spec));
  if (fs.existsSync(abs)) return abs;
  if (fs.existsSync(abs + '.js')) return abs + '.js';
  return null;
}

// Cache export sets so a big module isn't parsed once per importer.
const _exportsCache = new Map();
function exportsOf(file) {
  if (_exportsCache.has(file)) return _exportsCache.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const parsed = parseExports(src);
  // Follow one level of `export { X } from './y.js'` so shared/config-style
  // re-exports show up as exports on the intermediate module.
  for (const rex of parsed.reexports) {
    const target = resolveModule(file, rex.from);
    if (!target) continue;
    const targetSet = exportsOf(target).names;
    if (targetSet.has(rex.name) || rex.name === '*') {
      parsed.names.add(rex.exposedAs);
    }
  }
  _exportsCache.set(file, parsed);
  return parsed;
}

const files = walk(JS_ROOT);

describe('every relative named import resolves to an actual export', () => {
  test('js/ modules do not import identifiers that the target file never exports', () => {
    const problems = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const imports = parseImports(src);
      for (const imp of imports) {
        const target = resolveModule(file, imp.spec);
        if (!target) {
          problems.push(`${path.relative(ROOT, file)} imports from ${imp.spec} but the target file does not exist`);
          continue;
        }
        const exported = exportsOf(target).names;
        for (const name of imp.names) {
          if (!exported.has(name)) {
            problems.push(
              `${path.relative(ROOT, file)} imports { ${name} } from ${imp.spec} `
              + `but ${path.relative(ROOT, target)} does not export it. `
              + `Known exports: ${[...exported].sort().join(', ') || '(none)'}`,
            );
          }
        }
      }
    }
    // One big failure with every offending import so a broken sweep is
    // fixable in one pass instead of whack-a-mole.
    if (problems.length > 0) {
      throw new Error(`Broken imports:\n  - ${problems.join('\n  - ')}`);
    }
  });
});
