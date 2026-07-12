/**
 * Vendor status feed integration for status.html (#278).
 *
 * The vendor-status.js module fetches GitHub Pages component health from
 * githubstatus.com and the Cloudflare overall indicator from
 * cloudflarestatus.com and reshapes both into the same card contract the
 * Supabase edge-fn cards use. These tests exercise the pure mapping
 * helpers plus the fetch integration with global.fetch stubbed.
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const HTML      = fs.readFileSync(path.join(ROOT, 'status.html'), 'utf8');
const MAIN      = fs.readFileSync(path.join(ROOT, 'js', 'status', 'main.js'), 'utf8');
const VENDOR    = fs.readFileSync(path.join(ROOT, 'js', 'status', 'vendor-status.js'), 'utf8');
const MANIFEST  = fs.readFileSync(path.join(ROOT, 'gh-pages-manifest.txt'), 'utf8').split('\n').map(l => l.trim());

const { loadEsm } = require('./_esm-vm.js');

function loadVendor(ctxExtra = {}) {
  const ctx = {
    console: { debug: () => {}, warn: () => {}, log: () => {} },
    Date,
    Promise,
    Array,
    Error,
    Number,
    String,
    JSON,
    Boolean,
    ...ctxExtra,
  };
  loadEsm(['js/status/vendor-status.js'], ctx);
  return ctx;
}

describe('status.html vendor infrastructure wiring', () => {
  test('page wording no longer claims GitHub Actions checks the feeds', () => {
    // Migrated to a Cloudflare Worker cron in #275; the old prose was
    // wrong the moment that landed. Regression pin.
    expect(HTML).not.toMatch(/GitHub Actions job/);
    expect(HTML).toMatch(/Cloudflare Worker cron/);
  });

  test('vendor list container is above the Supabase edge-fn list', () => {
    expect(HTML).toContain('id="status-vendor-list"');
    expect(HTML).toContain('id="status-list"');
    const vendorAt = HTML.indexOf('id="status-vendor-list"');
    const supaAt   = HTML.indexOf('id="status-list"');
    expect(vendorAt).toBeGreaterThan(-1);
    expect(supaAt).toBeGreaterThan(vendorAt);
  });

  test('both status sections are labeled so they read as peers', () => {
    expect(HTML).toContain('Upstream infrastructure');
    expect(HTML).toContain('Supabase edge functions');
  });

  test('main.js imports the vendor helper + wires the refresh interval', () => {
    expect(MAIN).toMatch(/import\s*\{\s*fetchVendorStatuses,\s*VENDOR_REFRESH_MS\s*\}\s*from\s*'\.\/vendor-status\.js/);
    expect(MAIN).toMatch(/loadAndRenderVendor\(\)/);
    expect(MAIN).toMatch(/setInterval\(loadAndRenderVendor, VENDOR_REFRESH_MS\)/);
  });

  test('vendor cards render as buttons that open a component-breakdown modal', () => {
    // Sending the reader straight to the vendor status page loses the
    // critical vs. non-critical distinction Proton Pulse cares about, so
    // vendor cards are buttons that open a modal showing which of OUR
    // services are affected. The modal still links out to the vendor
    // status page for people who want the full picture.
    expect(MAIN).toMatch(/status-card--vendor/);
    expect(MAIN).toMatch(/data-vendor='/);
    expect(MAIN).toMatch(/openVendorModal/);
    expect(MAIN).toMatch(/Services Proton Pulse depends on/);
  });

  test('status page has a jump-to-announcements + back-to-top control', () => {
    expect(HTML).toContain('id="status-announcements"');
    expect(HTML).toMatch(/href="#status-announcements"/);
    expect(HTML).toContain('id="status-back-to-top"');
    expect(MAIN).toMatch(/status-back-to-top/);
    expect(MAIN).toMatch(/window\.scrollTo\(\s*\{\s*top:\s*0/);
  });

  test('gh-pages-manifest.txt lists the new vendor-status module', () => {
    expect(MANIFEST).toContain('js/status/vendor-status.js');
  });
});

describe('vendor-status pure mappers', () => {
  test('componentStatusToState covers every Statuspage.io state', () => {
    const { componentStatusToState } = loadVendor();
    expect(componentStatusToState('operational')).toBe('operational');
    expect(componentStatusToState('degraded_performance')).toBe('degraded');
    expect(componentStatusToState('partial_outage')).toBe('degraded');
    expect(componentStatusToState('under_maintenance')).toBe('degraded');
    expect(componentStatusToState('major_outage')).toBe('down');
    expect(componentStatusToState('something_new')).toBe('unknown');
    expect(componentStatusToState(undefined)).toBe('unknown');
  });

  test('worstOfStates picks the most severe state from a list', () => {
    const { worstOfStates } = loadVendor();
    expect(worstOfStates([])).toBe('unknown');
    expect(worstOfStates(['operational', 'operational'])).toBe('operational');
    expect(worstOfStates(['operational', 'degraded'])).toBe('degraded');
    expect(worstOfStates(['degraded', 'down', 'operational'])).toBe('down');
    expect(worstOfStates(['unknown', 'operational'])).toBe('unknown');
  });

  test('critical component ids are pinned per vendor', () => {
    // Rotating these on Statuspage.io side would silently degrade our
    // matching to "unknown"; pin them so any drift is intentional.
    expect(VENDOR).toContain("'vg70hn9s2tyj'");   // GitHub Pages
    expect(VENDOR).toContain("'br0l2tvcx85d'");   // GitHub Actions
    expect(VENDOR).toContain("'57srcl8zcn7c'");   // Cloudflare Workers
    expect(VENDOR).toContain("'tmh50tx2nprs'");   // Cloudflare Workers KV
    expect(VENDOR).toContain("'5wnz34mhfhrk'");   // Cloudflare CDN/Cache
    expect(VENDOR).toContain("'dp8ppfycqxcs'");   // Cloudflare Authoritative DNS
  });
});

describe('vendor-status fetch integration', () => {
  const GH_COMPONENTS_OK = {
    components: [
      { id: 'vg70hn9s2tyj', name: 'Pages',   status: 'operational' },
      { id: 'br0l2tvcx85d', name: 'Actions', status: 'operational' },
      { id: 'x',            name: 'Copilot', status: 'operational' },
    ],
  };
  const CF_COMPONENTS_OK = {
    components: [
      { id: '57srcl8zcn7c', name: 'Workers',           status: 'operational' },
      { id: 'tmh50tx2nprs', name: 'Workers KV',        status: 'operational' },
      { id: '5wnz34mhfhrk', name: 'CDN/Cache',         status: 'operational' },
      { id: 'dp8ppfycqxcs', name: 'Authoritative DNS', status: 'operational' },
      { id: 'dash',         name: 'Dashboard',         status: 'operational' },
    ],
  };
  const CF_COMPONENTS_DASHBOARD_DEGRADED = {
    components: [
      { id: '57srcl8zcn7c', name: 'Workers',           status: 'operational' },
      { id: 'tmh50tx2nprs', name: 'Workers KV',        status: 'operational' },
      { id: '5wnz34mhfhrk', name: 'CDN/Cache',         status: 'operational' },
      { id: 'dp8ppfycqxcs', name: 'Authoritative DNS', status: 'operational' },
      { id: 'dash',         name: 'Dashboard',         status: 'degraded_performance' },
    ],
  };
  const CF_COMPONENTS_WORKERS_DOWN = {
    components: [
      { id: '57srcl8zcn7c', name: 'Workers',           status: 'major_outage' },
      { id: 'tmh50tx2nprs', name: 'Workers KV',        status: 'operational' },
      { id: '5wnz34mhfhrk', name: 'CDN/Cache',         status: 'operational' },
      { id: 'dp8ppfycqxcs', name: 'Authoritative DNS', status: 'operational' },
      { id: 'dash',         name: 'Dashboard',         status: 'operational' },
    ],
  };

  function stubFetch(routes) {
    return jest.fn((url) => {
      for (const [pattern, resp] of routes) {
        if (String(url).includes(pattern)) {
          return Promise.resolve({
            ok: resp.ok !== false,
            status: resp.status || 200,
            json: () => Promise.resolve(resp.body),
          });
        }
      }
      return Promise.reject(new Error(`no stub for ${url}`));
    });
  }

  test('all critical components operational returns two green cards', async () => {
    const { fetchVendorStatuses } = loadVendor({ fetch: stubFetch([
      ['githubstatus.com', { body: GH_COMPONENTS_OK }],
      ['cloudflarestatus.com', { body: CF_COMPONENTS_OK }],
    ]) });
    const [gh, cf] = await fetchVendorStatuses();
    expect(gh.status).toBe('operational');
    expect(cf.status).toBe('operational');
    expect(gh.critical.map((c) => c.name)).toEqual(['Pages', 'Actions']);
    expect(cf.critical.map((c) => c.name)).toEqual(['Workers', 'Workers KV', 'CDN/Cache', 'Authoritative DNS']);
    expect(cf.other_degraded).toEqual([]);
  });

  test('Cloudflare Dashboard degradation does NOT flip the tile yellow (#278 follow-up)', async () => {
    // This is the exact scenario the user flagged: Cloudflare's Dashboard
    // is Degraded Performance, but Proton Pulse does not touch the
    // Dashboard, so the tile must stay green. The Dashboard row still
    // shows up under other_degraded so a wider incident stays visible.
    const { fetchVendorStatuses } = loadVendor({ fetch: stubFetch([
      ['githubstatus.com', { body: GH_COMPONENTS_OK }],
      ['cloudflarestatus.com', { body: CF_COMPONENTS_DASHBOARD_DEGRADED }],
    ]) });
    const [, cf] = await fetchVendorStatuses();
    expect(cf.status).toBe('operational');
    expect(cf.other_degraded.map((c) => c.name)).toContain('Dashboard');
  });

  test('a Cloudflare Workers outage DOES flip the tile down, since we depend on Workers', async () => {
    const { fetchVendorStatuses } = loadVendor({ fetch: stubFetch([
      ['githubstatus.com', { body: GH_COMPONENTS_OK }],
      ['cloudflarestatus.com', { body: CF_COMPONENTS_WORKERS_DOWN }],
    ]) });
    const [, cf] = await fetchVendorStatuses();
    expect(cf.status).toBe('down');
    const workers = cf.critical.find((c) => c.id === '57srcl8zcn7c');
    expect(workers.state).toBe('down');
  });

  test('a failed feed produces an "unknown" card with an error string, no throw', async () => {
    const { fetchVendorStatuses } = loadVendor({ fetch: stubFetch([
      ['githubstatus.com', { ok: false, status: 503, body: {} }],
      ['cloudflarestatus.com', { body: CF_COMPONENTS_OK }],
    ]) });
    const [gh, cf] = await fetchVendorStatuses();
    expect(gh.status).toBe('unknown');
    expect(gh.error).toMatch(/HTTP 503/);
    expect(cf.status).toBe('operational');
  });

  test('critical component missing from the feed is surfaced as unknown (not silently dropped)', async () => {
    const { fetchVendorStatuses } = loadVendor({ fetch: stubFetch([
      ['githubstatus.com', { body: { components: [{ id: 'x', name: 'Copilot', status: 'operational' }] } }],
      ['cloudflarestatus.com', { body: CF_COMPONENTS_OK }],
    ]) });
    const [gh] = await fetchVendorStatuses();
    expect(gh.status).toBe('unknown');
    expect(gh.critical).toHaveLength(2);
    expect(gh.critical.every((c) => c.state === 'unknown')).toBe(true);
  });
});
