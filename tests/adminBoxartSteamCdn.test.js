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

  test('empty-results branch tells the admin no variants loaded (does not falsely claim delisted)', () => {
    // Original copy claimed the app was "delisted or region-locked" but
    // we do not actually check either -- 0 hits just means "the CDN
    // did not serve any variant right now". Say that instead.
    expect(BOXART_SRC).toContain('No Steam CDN variants loaded');
    expect(BOXART_SRC).not.toContain('delisted or region-locked');
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

describe('boxart admin batch: Set first Steam CDN wide image (filtered)', () => {
  test('menu item is present in the Actions dropdown', () => {
    expect(BOXART_SRC).toContain('id="boxart-steamcdn-header-all-btn"');
    expect(BOXART_SRC).toContain('Set first Steam CDN wide image (filtered)');
  });

  test('batch handler skips non-Steam rows before iterating', () => {
    expect(BOXART_SRC).toMatch(
      /steamCdnAllBtn[\s\S]{0,400}state\.rows\.filter\(\(r\) => r\.type === 'steam'\)/,
    );
  });

  test('batch tries wide-aspect variants in preference order', () => {
    // header first (canonical site format), then capsule sizes, then hero.
    // Skips vertical variants (library_600x900) and non-image ones (logo).
    expect(BOXART_SRC).toContain('STEAM_CDN_WIDE_PREF');
    for (const f of ['header.jpg', 'capsule_616x353.jpg', 'capsule_467x181.jpg', 'capsule_231x87.jpg', 'library_hero.jpg']) {
      expect(BOXART_SRC).toContain(f);
    }
    // Verify no vertical variants leak into the preference list. The
    // portrait library_600x900 is not a widescreen shape and should not
    // be considered by the batch.
    const prefBlock = BOXART_SRC.match(/STEAM_CDN_WIDE_PREF = \[[\s\S]{0,300}?\]/);
    expect(prefBlock).toBeTruthy();
    expect(prefBlock[0]).not.toContain('library_600x900');
  });

  test('batch handler uses shared _imgLoads (Image + timeout) helper', () => {
    expect(BOXART_SRC).toContain('_imgLoads');
    expect(BOXART_SRC).toMatch(/setTimeout\([^,]+,\s*timeoutMs/);
  });

  test('batch handler applies the first hit via setBoxArtOverride', () => {
    expect(BOXART_SRC).toMatch(
      /steamCdnAllBtn[\s\S]{0,3000}setBoxArtOverride\(r\.appId, picked\)/,
    );
  });

  test('setBatchRunning disables the batch button too', () => {
    expect(BOXART_SRC).toMatch(/setBatchRunning[\s\S]{0,300}steamCdnAllBtn\.disabled\s*=\s*running/);
  });
});

describe('boxart admin detail: override-metadata spacing', () => {
  test('URL sources table has a spacer row above the override metadata block', () => {
    // Visual separator between the URL list and the ADMIN OVERRIDE badge.
    expect(BOXART_SRC).toMatch(
      /aria-hidden="true"[\s\S]{0,120}height:14px[\s\S]{0,80}\$\{_urlRowHtml\('Override metadata'/,
    );
  });
});
