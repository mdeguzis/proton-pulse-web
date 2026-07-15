/**
 * Source-scan tests for the Steam CDN image panel on the box art
 * admin detail page (#345). Pins the wiring so a future refactor
 * cannot silently drop:
 *   - the panel mount container
 *   - the variant list
 *   - the CDN base URL
 *   - on-demand fetch button (no auto-render of 9 images per open)
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

  test('panel starts empty with a Fetch button (on-demand, no auto-render)', () => {
    expect(BOXART_SRC).toContain('data-steamcdn="fetch"');
    expect(BOXART_SRC).toContain('id="steamcdn-results"');
    // Panel HTML must NOT pre-render the cards -- the results div is
    // populated by the fetch click handler after each variant is probed.
    const panelFn = BOXART_SRC.match(/function _steamCdnPanelHtml[\s\S]{0,1200}?\n\}/);
    expect(panelFn).toBeTruthy();
    expect(panelFn[0]).not.toContain('STEAM_CDN_VARIANTS.map');
  });

  test('fetch handler probes every variant via Image() onload before rendering', () => {
    // Use <img> load detection, not fetch(). Steam CDN behaves inconsistently
    // for browser fetch() (CORS on some paths, redirects on others), but the
    // Image element always renders the pixels + fires onload/onerror.
    expect(BOXART_SRC).toMatch(
      /data-steamcdn="fetch"[\s\S]{0,1500}STEAM_CDN_VARIANTS\.map[\s\S]{0,400}new Image\(\)[\s\S]{0,200}img\.onload/,
    );
  });

  test('empty-results branch tells the admin the app is delisted or region-locked', () => {
    expect(BOXART_SRC).toContain('No Steam CDN variants loaded');
  });

  test('click handler routes Set through setBoxArtOverride (same path as SGDB)', () => {
    // The setBtn branch inside the steamCdnPanel handler reads
    // data-steamcdn-set, then calls setBoxArtOverride. Pin that the
    // AFTER-declaration slice contains the override call.
    const setBtnIdx = BOXART_SRC.indexOf("ev.target.closest('[data-steamcdn-set]')");
    expect(setBtnIdx).toBeGreaterThan(-1);
    const after = BOXART_SRC.slice(setBtnIdx);
    expect(after).toContain('setBoxArtOverride(row.appId, url)');
  });

  test('successful set updates the preview + refreshes the body', () => {
    // Same post-set treatment SGDB does: mutate row.override, refreshBody(),
    // swap the #boxart-detail-preview image so admins see it immediately.
    expect(BOXART_SRC).toMatch(
      /Steam CDN[\s\S]{0,4000}row\.override\s*=\s*\{[\s\S]{0,80}'manual'[\s\S]{0,300}refreshBody\(\)/,
    );
  });
});

describe('boxart admin batch: Set Steam CDN header (filtered)', () => {
  test('menu item is present in the Actions dropdown', () => {
    expect(BOXART_SRC).toContain('id="boxart-steamcdn-header-all-btn"');
    expect(BOXART_SRC).toContain('Set Steam CDN header (filtered)');
  });

  test('batch handler skips non-Steam rows before iterating', () => {
    expect(BOXART_SRC).toMatch(
      /steamCdnAllBtn[\s\S]{0,400}state\.rows\.filter\(\(r\) => r\.type === 'steam'\)/,
    );
  });

  test('batch handler skips rows that already have an override', () => {
    expect(BOXART_SRC).toMatch(
      /steamCdnAllBtn[\s\S]{0,1500}r\.override\?\.image_url[\s\S]{0,100}skip \+= 1/,
    );
  });

  test('batch handler probes each row via Image() load, not fetch', () => {
    expect(BOXART_SRC).toMatch(
      /steamCdnAllBtn[\s\S]{0,2500}new Image\(\)[\s\S]{0,400}img\.onload/,
    );
  });

  test('batch handler races a timeout so a stuck request cannot hang the run', () => {
    expect(BOXART_SRC).toMatch(
      /steamCdnAllBtn[\s\S]{0,2500}setTimeout\([^,]+,\s*5000\)/,
    );
  });

  test('batch handler applies via setBoxArtOverride (same path as everything else)', () => {
    expect(BOXART_SRC).toMatch(
      /steamCdnAllBtn[\s\S]{0,3000}setBoxArtOverride\(r\.appId, url\)/,
    );
  });

  test('setBatchRunning disables the new batch button too', () => {
    expect(BOXART_SRC).toMatch(/setBatchRunning[\s\S]{0,300}steamCdnAllBtn\.disabled\s*=\s*running/);
  });
});
