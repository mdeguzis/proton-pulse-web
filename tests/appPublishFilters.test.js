const fs = require('fs');
const path = require('path');

// app.js was split into js/app/ ES modules; the publish-filter query strings now
// live across those modules. Concatenate them so the source assertions still hold.
const APP_DIR = path.join(__dirname, '..', 'js', 'app');
const APP_SRC = fs.readdirSync(APP_DIR)
  .filter(f => f.endsWith('.js'))
  .map(f => fs.readFileSync(path.join(APP_DIR, f), 'utf8'))
  .join('\n');

describe('public Proton Pulse config queries', () => {
  test('public app surfaces only request explicitly published cloud configs', () => {
    expect(APP_SRC).toContain('user_proton_configs?is_published=eq.true');
    expect(APP_SRC).toContain("url.searchParams.set('is_published', 'eq.true')");
    expect(APP_SRC).toContain('user_proton_configs?app_id=eq.${appId}&is_published=eq.true');
  });
});
