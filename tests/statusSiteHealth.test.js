/**
 * Source-scan tests for the "Site health" section on status.html. Motivated
 * by the outage where GH Pages Let's Encrypt cert expired and Cloudflare
 * responded 526 for 24+ hours before anyone noticed. The status page now
 * has a dedicated section that reads payload.sites (populated by the
 * pp-edge-status Cloudflare Worker) and renders one card per probed site.
 */
const fs = require('fs');
const path = require('path');

const STATUS_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'status.html'),
  'utf8',
);
const STATUS_MAIN = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'status', 'main.js'),
  'utf8',
);

describe('status.html has a Site health section', () => {
  test('section header and mount div land between vendor list and edge-fn list', () => {
    const vendorIdx = STATUS_HTML.indexOf('status-vendor-list');
    const siteIdx = STATUS_HTML.indexOf('status-site-list');
    // Anchor on the H2 heading, not the raw phrase -- the meta
    // description at the top of the page also contains "edge functions"
    // and would give a false-early match.
    const edgeIdx = STATUS_HTML.indexOf('<h2 class="status-section-heading">Supabase edge functions</h2>');
    expect(vendorIdx).toBeGreaterThan(0);
    expect(siteIdx).toBeGreaterThan(vendorIdx);
    expect(edgeIdx).toBeGreaterThan(siteIdx);
    expect(STATUS_HTML).toContain('<h2 class="status-section-heading">Site health</h2>');
    expect(STATUS_HTML).toContain('<div id="status-site-list"');
  });
});

describe('js/status/main.js renders site cards from payload.sites', () => {
  test('renderFromPayload writes into the site list when payload.sites is present', () => {
    // The block that populates the new section: read payload.sites, map
    // to renderSiteCard, inject into #status-site-list.
    expect(STATUS_MAIN).toContain("document.getElementById('status-site-list')");
    expect(STATUS_MAIN).toMatch(
      /const sites = Array\.isArray\(payload\.sites\) \? payload\.sites : \[\]/,
    );
    expect(STATUS_MAIN).toMatch(/sites\.map\(renderSiteCard\)\.join\(''\)/);
  });

  test('empty payload.sites falls back to a "not run yet" message', () => {
    // Backward compatibility for a KV payload written by the pre-site-probe
    // worker: the section stays informative rather than blank.
    expect(STATUS_MAIN).toContain('Site probes have not run yet');
  });

  test('renderSiteCard shows the origin_hint below the primary meta row', () => {
    // origin_hint is the fix-pointer for the operator (e.g. "GitHub Pages
    // Let's Encrypt cert on the CNAME target"). Regression guard: a future
    // refactor must not drop the hint.
    expect(STATUS_MAIN).toContain('site.origin_hint');
    expect(STATUS_MAIN).toContain('status-card--site');
  });

  test('siteReasonLabel spells out the Cloudflare 526 cert case', () => {
    // The outage that motivated this section: 526 is Cloudflare's "origin
    // SSL certificate invalid" code. The label must call it out by name so
    // an operator glancing at the card knows exactly where to look.
    expect(STATUS_MAIN).toMatch(/origin_ssl_cert_invalid[\s\S]{0,200}Cloudflare 526/);
    expect(STATUS_MAIN).toMatch(/origin_ssl_handshake_failed[\s\S]{0,200}Cloudflare 525/);
  });

  test('SSL-error tiles link to the wiki renewal walkthrough', () => {
    // We do not try to proactively read cert expiry (would require a
    // GitHub PAT on the worker, one more secret to rotate). Instead: when
    // Cloudflare 525/526 fires on the fetch probe, the tile shows a
    // "Renewal steps: wiki" link pointing at
    // https://github.com/mdeguzis/proton-pulse-web/wiki/GitHub-Pages-Cert-Renewal
    // so the operator sees the fix without hunting.
    expect(STATUS_MAIN).toContain('GitHub-Pages-Cert-Renewal');
    // Only wire the renewal link on cert-shaped reasons (525/526), not
    // every non-200 response.
    expect(STATUS_MAIN).toMatch(/origin_ssl_cert_invalid[\s\S]{0,200}origin_ssl_handshake_failed/);
  });

  test('renderSiteCard does NOT depend on cert.* fields (no GH API auth path)', () => {
    // Regression guard: an earlier design fetched cert expiry from the
    // GitHub Pages REST API and dropped it onto payload.sites[i].cert.
    // That is intentionally gone -- the fetch probe alone is enough. If a
    // future refactor re-adds cert.expires_at / cert.days_remaining
    // rendering this test forces a discussion about the secret rotation
    // burden that comes with the GH PAT.
    expect(STATUS_MAIN).not.toMatch(/cert\.expires_at/);
    expect(STATUS_MAIN).not.toMatch(/cert\.days_remaining/);
    expect(STATUS_MAIN).not.toMatch(/cert\.fetch_error/);
    expect(STATUS_MAIN).not.toContain('certSummary');
  });
});
