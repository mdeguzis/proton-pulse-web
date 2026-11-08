/**
 * #474: the site no longer shows ProtonDB reports, so no page may claim it is
 * built on, mirrors, or merges ProtonDB data. The live "Check ProtonDB Live"
 * lookup and the comparison table are the only ProtonDB mentions that stay.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const SOURCES = [
  ...PAGES,
  'js/app/components/home.js',
  'js/app/components/search.js',
];

const STALE = [
  /Built on\s+<a[^>]*>ProtonDB<\/a>\s+community data/i,
  /mirrors ProtonDB/i,
  /merged ProtonDB/i,
  /combined ProtonDB and Proton Pulse/i,
  /Browse ProtonDB Reports/i,
  /ProtonDB data (available|indexed)/i,
  /fair use/i,
];

describe('no stale "built on ProtonDB data" claims (#474)', () => {
  test.each(SOURCES)('%s', (file) => {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const re of STALE) expect(body).not.toMatch(re);
  });

  test('terms still says we are not affiliated and labels the live lookup', () => {
    const terms = fs.readFileSync(path.join(ROOT, 'terms.html'), 'utf8');
    expect(terms).toMatch(/not affiliated with\s+<a[^>]*>ProtonDB<\/a>/);
    expect(terms).toMatch(/Check ProtonDB Live/);
  });
});
