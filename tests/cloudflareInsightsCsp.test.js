/**
 * #436: Cloudflare Web Analytics beacon must be allowed by every page's CSP.
 *
 * Cloudflare Pages auto-injects static.cloudflareinsights.com/beacon.min.js
 * and it POSTs RUM data to cloudflareinsights.com. Our meta CSP was blocking
 * both, so Web Analytics recorded nothing (96 script-src-elem violations in a
 * single day before the fix). Pin the two origins so a future CSP edit cannot
 * silently re-break the beacon.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Every HTML page that ships a CSP meta tag. lookup.html has no CSP at all
// (pre-existing gap tracked separately) and the Google verification stub is
// not a real page, so both are excluded.
const CSP_PAGES = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => f !== 'lookup.html' && !f.startsWith('google'))
  .filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('Content-Security-Policy'));

describe('#436: CSP allows the Cloudflare Web Analytics beacon on every page', () => {
  test('there are pages to check (guards against a bad glob)', () => {
    expect(CSP_PAGES.length).toBeGreaterThan(10);
  });

  test.each(CSP_PAGES)('%s script-src allows static.cloudflareinsights.com', (page) => {
    const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const csp = (src.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || '';
    expect(csp).toMatch(/script-src[^;]*https:\/\/static\.cloudflareinsights\.com/);
  });

  test.each(CSP_PAGES)('%s connect-src allows cloudflareinsights.com', (page) => {
    const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const csp = (src.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || '';
    expect(csp).toMatch(/connect-src[^;]*https:\/\/cloudflareinsights\.com/);
  });
});
