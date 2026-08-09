const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Every .pg-* class index.html actually puts on an element must have a rule
// somewhere under css/. A "delete dead CSS" sweep (37de9ceff2) once removed
// .pg-view-controls / .pg-size-btn / .pg-layout-btn / .pg-head / .pg-filter-wrap
// while they were still live, and the homepage S/M/L/XL + Grid/List controls
// fell back to unstyled browser buttons stacked under the Filters button.
// This test makes that class of mistake fail in CI instead of in a screenshot.
describe('index.html .pg-* classes are all styled (regression for #464 sweep)', () => {
  const html = read('index.html');

  const cssFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.css')) cssFiles.push(full);
    }
  })(path.join(root, 'css'));

  // Strip comments so a class mentioned only in an explanatory note does not
  // count as styled -- that is exactly how the original breakage hid itself.
  const css = cssFiles
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const emitted = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) {
      if (cls.startsWith('pg-')) emitted.add(cls);
    }
  }

  test('index.html emits the popular-games controls we expect', () => {
    // Guard the guard: if the markup is refactored away this test should be
    // updated deliberately, not silently pass on an empty set.
    expect(emitted.size).toBeGreaterThan(5);
    for (const cls of ['pg-head', 'pg-filter-wrap', 'pg-view-controls', 'pg-size-toggle', 'pg-size-btn', 'pg-layout-toggle', 'pg-layout-btn']) {
      expect([...emitted]).toContain(cls);
    }
  });

  // Classes that exist purely as querySelectorAll hooks for js/index/main.js.
  // They carry no styling of their own by design -- .pg-store-btn elements get
  // their look from the .pg-filter class applied alongside it. Add to this list
  // only when a class is genuinely a JS handle, never to silence a real gap.
  const JS_HOOK_ONLY = new Set(['pg-store-btn']);

  test('every emitted .pg-* class has at least one CSS rule', () => {
    const unstyled = [...emitted].filter(
      (cls) => !JS_HOOK_ONLY.has(cls) && !new RegExp(`\\.${cls}(?![\\w-])`).test(css)
    );
    expect(unstyled).toEqual([]);
  });

  test('.pg-view-controls keeps margin-left:auto so the toggles stay right-aligned', () => {
    // Without this the S/M/L/XL + List/Grid set drifts to the left of the
    // .pg-head row instead of sitting opposite the search box.
    const indexCss = read('css/index/index.css');
    expect(indexCss).toMatch(/\.pg-view-controls\s*\{[^}]*margin-left:\s*auto/);
  });

  test('.pg-head stays a flex row so the controls do not stack', () => {
    const indexCss = read('css/index/index.css');
    expect(indexCss).toMatch(/^\.pg-head\s*\{[^}]*display:\s*flex/m);
  });
});
