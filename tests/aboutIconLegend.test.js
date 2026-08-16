/**
 * The about page's icon legend must match the icons the app actually renders.
 *
 * The legend is static HTML while the real icons are an SVG sprite injected at
 * runtime by js/lib/topbar.js, so the two can drift with nothing failing. The
 * "In your library" entry drew a four-square grid long after the badge itself
 * became the three-bar #icon-book-open, so the page documenting the icons was
 * teaching the wrong one.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const ABOUT = fs.readFileSync(path.join(REPO, 'about.html'), 'utf8');
const TOPBAR = fs.readFileSync(path.join(REPO, 'js', 'lib', 'topbar.js'), 'utf8');

function spriteBody(id) {
  const m = TOPBAR.match(new RegExp(`<symbol id="${id}"[^>]*>([\\s\\S]*?)</symbol>`));
  if (!m) throw new Error(`sprite ${id} not found in topbar.js`);
  return m[1];
}

// Compare on geometry, not whitespace or attribute order.
function shapes(svg) {
  return [...svg.matchAll(/<(rect|path|circle|ellipse)\b([^>]*)>/g)].map(([, tag, attrs]) => {
    const keep = ['x', 'y', 'width', 'height', 'rx', 'd', 'cx', 'cy', 'r'];
    const parts = keep
      .map((k) => {
        const v = attrs.match(new RegExp(`(?<![-\\w])${k}="([^"]*)"`));
        return v ? `${k}=${v[1].replace(/\s+/g, ' ').trim()}` : null;
      })
      .filter(Boolean);
    return `${tag}:${parts.join(',')}`;
  });
}

describe('about page icon legend matches the real sprites', () => {
  test('In your library uses the same shapes as #icon-book-open', () => {
    const row = ABOUT.slice(ABOUT.indexOf('In your account'), ABOUT.indexOf('On your wishlist'));
    const legend = shapes(row);
    const real = shapes(spriteBody('icon-book-open'));
    expect(real.length).toBeGreaterThan(0);
    for (const shape of real) expect(legend).toContain(shape);
  });

  test('the legend no longer draws the retired four-square grid', () => {
    expect(ABOUT).not.toContain('<rect x="3.4" y="3.4" width="7" height="7" rx="1.5"/>');
  });

  test('On your wishlist uses the same shapes as #icon-wishlist-heart', () => {
    const start = ABOUT.indexOf('On your wishlist');
    const row = ABOUT.slice(ABOUT.lastIndexOf('<div class="il-row">', start), start);
    const legend = shapes(row);
    const real = shapes(spriteBody('icon-wishlist-heart'));
    for (const shape of real) expect(legend).toContain(shape);
  });
});
