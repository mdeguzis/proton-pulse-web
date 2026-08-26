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

describe('game page filter dropdowns (#502, CodeQL alert 60)', () => {
  const SRC = read('js/app/components/game-page.js');

  // Every filter <option> is built the same way from report data:
  //   availX.map(v => `<option value="${v}" ...>${LABEL[v] || v}</option>`)
  // Three of them escaped and three did not. availGpus and availRunTypes are
  // built from r.gpu / r.runType, i.e. fields a submitted report controls, and
  // the `LABEL[v] || v` fallback renders the RAW value whenever the label map
  // has no entry -- so markup in a report's GPU string reached innerHTML.
  const OPTION_BUILDERS = SRC
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.includes('.map(v => `<option'));

  test('the dropdowns are still built the way this guard assumes', () => {
    // If this fails the render was refactored and the assertions below are
    // no longer checking anything real.
    expect(OPTION_BUILDERS.length).toBeGreaterThanOrEqual(5);
  });

  test.each([
    ['availGpus'],
    ['availArchs'],
    ['availOs'],
    ['availRatings'],
    ['availRunTypes'],
  ])('%s escapes both the option value and its label', (name) => {
    const builder = OPTION_BUILDERS.find(({ line }) => line.includes(`${name}.map(`));
    expect(builder).toBeDefined();
    // value="..." must go through esc()
    expect(builder.line).toContain('value="${esc(v)}"');
    // Scan the INNER <option> template only. A naive scan of the whole line
    // trips over the nested template literal: the outer ${availX.map(...)}
    // is closed by the first brace inside it.
    const inner = builder.line.match(/`(<option[\s\S]*?<\/option>)`/);
    expect(inner).not.toBeNull();
    // Nothing may be interpolated bare -- catches `${v}` and the
    // `${LABEL[v]||v}` fallback that was the actual sink.
    const bare = [...inner[1].matchAll(/\$\{([^}]*)\}/g)]
      .map((m) => m[1].trim())
      .filter((e) => !e.startsWith('esc(') && !e.includes('==='));
    expect(bare).toEqual([]);
  });

  test('no option builder interpolates a LABEL fallback unescaped', () => {
    // The specific shape that produced the alert.
    expect(SRC).not.toMatch(/\$\{[A-Z_]+_LABEL\[v\]\s*\|\|\s*v\}/);
  });
});
