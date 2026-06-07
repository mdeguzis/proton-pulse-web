const fs = require('fs');
const path = require('path');

// app.js was split into layered js/app/ ES modules (api/, components/, root);
// the publish-filter query strings now live across those modules. Walk the tree
// and concatenate every .js so the source assertions still hold.
const APP_DIR = path.join(__dirname, '..', 'js', 'app');
function walkJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walkJs(p) : (d.name.endsWith('.js') ? [p] : []);
  });
}
const APP_SRC = walkJs(APP_DIR).map(f => fs.readFileSync(f, 'utf8')).join('\n');

describe('public Proton Pulse config queries', () => {
  test('public app surfaces only request explicitly published cloud configs', () => {
    expect(APP_SRC).toContain('user_proton_configs?is_published=eq.true');
    expect(APP_SRC).toContain("url.searchParams.set('is_published', 'eq.true')");
    expect(APP_SRC).toContain('user_proton_configs?app_id=eq.${appId}&is_published=eq.true');
  });
});
