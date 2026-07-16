/**
 * Source-scan tests pinning the sanitizer patterns that keep CodeQL and
 * hand-review confident these input surfaces are XSS / open-redirect safe.
 * Each test fixes the *shape* of the sanitizer rather than the runtime
 * output so a future refactor cannot silently swap a strict validator for
 * a loose one.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('submit.html param sanitizers', () => {
  const SRC = read('js/submit/main.js');

  test('editReportId is validated as digits-only before use', () => {
    // report_id is bigint in Supabase. Digits-only is the tightest safe
    // whitelist and stops any script tag / HTML from reaching innerHTML.
    expect(SRC).toContain("const editRaw = params.get('edit');");
    expect(SRC).toContain('/^[0-9]+$/.test(editRaw)');
  });

  test('editReportId is HTML-escaped at every innerHTML render site', () => {
    // Belt-and-braces: even after digits-only validation, wrap in esc()
    // so any accidental widening of the validator does not blow up XSS.
    expect(SRC).toContain('Report #${esc(editReportId)}');
  });

  test('every server-provided approval.* field is escaped before rendering', () => {
    for (const field of ['approval.approved_by', 'approval.approval_hash']) {
      const re = new RegExp(`\\$\\{esc\\(${field.replace('.', '\\.')}`);
      expect(SRC).toMatch(re);
    }
  });

  test('return= sanitizer uses URL parse + origin equality + filename allowlist', () => {
    // Regex-only sanitizers do not satisfy CodeQL taint tracking. Parse
    // the input as a URL against the current page, require the resolved
    // origin to match, and require the final path component to be in a
    // small whitelist of pages that actually link back here.
    expect(SRC).toContain('ALLOWED_RETURN_PAGES');
    expect(SRC).toContain('new URL(returnRaw, window.location.href)');
    expect(SRC).toContain('parsed.origin === window.location.origin');
    expect(SRC).toContain('ALLOWED_RETURN_PAGES.has(filename)');
  });
});

describe('run-type version regex ReDoS guard', () => {
  const SRC = read('js/shared/run-type.js');

  test("Proton-GE version pattern uses [a-zA-Z0-9] segments (no \\w overlap with [-_.])", () => {
    // The old pattern was /^(ge[-_ ]?proton|proton[-_ ]?ge)[-_ ]?\d+([-_.]\w+)*$/i
    // where \w includes '_' -- so 'a_a_a...' could be split among the [-_.]
    // delimiter and \w segments in exponentially many ways. Replacing \w with
    // [a-zA-Z0-9] eliminates the overlap and the CodeQL ReDoS finding.
    expect(SRC).toContain('/^(ge[-_ ]?proton|proton[-_ ]?ge)[-_ ]?\\d+(?:[-_.][a-zA-Z0-9]+)*$/i');
    expect(SRC).not.toMatch(/\(\[\-_\.\]\\w\+\)\*/); // catches the old vulnerable shape
  });
});

describe('boxart admin refetch host allowlist', () => {
  const SRC = read('js/admin/components/boxart.js');

  test('CDN host swap parses the URL and compares .hostname exactly', () => {
    // includes('shared.akamai.steamstatic.com') matches any URL containing
    // that substring anywhere (e.g. a redirect param). Parse via new URL()
    // and check hostname equality instead so CodeQL is satisfied and the
    // check reflects intent.
    expect(SRC).toContain("parsed.hostname === 'shared.akamai.steamstatic.com'");
    expect(SRC).toContain("parsed.hostname === 'shared.fastly.steamstatic.com'");
    // Substring pattern must not creep back in.
    expect(SRC).not.toContain(".includes('shared.akamai.steamstatic.com')");
    expect(SRC).not.toContain(".includes('shared.fastly.steamstatic.com')");
  });
});
