const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'lib', 'topbar.js'),
  'utf8',
);

describe('topbar desktop dropdown pin behavior', () => {
  test('hovering a sibling dropdown clears pinned is-open state from others', () => {
    expect(SRC).toMatch(
      /function closeOtherDropdowns\(active,\s*fromPointer\)[\s\S]*?if \(other === active\) return;[\s\S]*?other\.classList\.remove\('is-open'\)/,
    );
    expect(SRC).toMatch(
      /if \(fromPointer && other\.contains\(document\.activeElement\)\)[\s\S]*?const active = document\.activeElement;[\s\S]*?active && typeof active\.blur === 'function'[\s\S]*?active\.blur\(\)/,
    );
    expect(SRC).toMatch(
      /dd\.addEventListener\('mouseenter',[\s\S]*?closeOtherDropdowns\(dd,\s*true\)/,
    );
  });
});
