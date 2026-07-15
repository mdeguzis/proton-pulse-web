/**
 * Source-scan tests for the Steam CDN image panel on the box art
 * admin detail page (#345). Pins the wiring so a future refactor
 * cannot silently drop:
 *   - the panel mount container
 *   - the variant list
 *   - the CDN base URL
 *   - the set-as-override handler
 */
const fs = require('fs');
const path = require('path');

const BOXART_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/admin/components/boxart.js'),
  'utf8',
);

describe('boxart admin detail: Steam CDN image panel (#345)', () => {
  test('detail shell renders the mount container', () => {
    expect(BOXART_SRC).toContain('id="boxart-steam-cdn-panel"');
  });

  test('variant list covers the important Steam image types', () => {
    for (const file of [
      'library_600x900.jpg',
      'library_600x900_2x.jpg',
      'library_hero.jpg',
      'header.jpg',
      'capsule_616x353.jpg',
      'capsule_467x181.jpg',
      'capsule_231x87.jpg',
      'logo.png',
      'page_bg_raw.jpg',
    ]) {
      expect(BOXART_SRC).toContain(file);
    }
  });

  test('base URL is the Cloudflare Steam CDN and includes the appId', () => {
    expect(BOXART_SRC).toMatch(
      /https:\/\/cdn\.cloudflare\.steamstatic\.com\/steam\/apps\/\$\{encodeURIComponent\(row\.appId\)\}/,
    );
  });

  test('non-Steam rows get an empty panel (no CDN variants for GOG / Epic)', () => {
    expect(BOXART_SRC).toMatch(/if \(row\.type !== 'steam'\) return ''/);
  });

  test('per-card <img> uses onerror to hide missing variants (no probe pass needed)', () => {
    expect(BOXART_SRC).toContain("this.closest('.steam-cdn-card').style.display='none'");
  });

  test('click handler routes Set through setBoxArtOverride (same path as SGDB)', () => {
    expect(BOXART_SRC).toMatch(
      /steamCdnPanel[\s\S]{0,400}data-steamcdn-set[\s\S]{0,400}setBoxArtOverride\(row\.appId, url\)/,
    );
  });

  test('successful set updates the preview + refreshes the body', () => {
    // Same post-set treatment SGDB does: mutate row.override, refreshBody(),
    // swap the #boxart-detail-preview image so admins see it immediately.
    expect(BOXART_SRC).toMatch(
      /Steam CDN[\s\S]{0,1200}row\.override\s*=\s*\{[\s\S]{0,80}'manual'[\s\S]{0,200}refreshBody\(\)/,
    );
  });
});
