/**
 * status.html CSP regression: pin the vendor status origins that the
 * vendor-status card fetches at runtime. Dropping one silently would
 * make the tile read "unreachable" in production without any local
 * signal. #329-followup.
 */
const fs = require('fs');
const path = require('path');

const STATUS_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'status.html'),
  'utf8',
);

describe('status.html Content-Security-Policy', () => {
  const cspMatch = STATUS_HTML.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  const csp = cspMatch ? cspMatch[1] : '';

  test('CSP tag is present', () => {
    expect(csp).not.toBe('');
  });

  test('connect-src allows www.githubstatus.com (GitHub Pages + Actions health)', () => {
    expect(csp).toMatch(/connect-src[^;]*https:\/\/www\.githubstatus\.com/);
  });

  test('connect-src allows www.cloudflarestatus.com (Workers, DNS, CDN health)', () => {
    expect(csp).toMatch(/connect-src[^;]*https:\/\/www\.cloudflarestatus\.com/);
  });

  test('connect-src allows the Supabase project + edge-status worker (already relied on)', () => {
    expect(csp).toMatch(/connect-src[^;]*https:\/\/ilsgdshkaocrmibwdezk\.supabase\.co/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/pp-edge-status\.mdeguzis\.workers\.dev/);
  });
});
