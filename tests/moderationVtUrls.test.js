/**
 * #378: VirusTotal URL scanning as moderation layer 3.
 *
 * Contract pins (source-level, same style as securityScanners.test.js) plus
 * unit tests for the exported URL helpers. Runtime VT behavior is verified
 * by the workflow itself; these tests keep the layer wired and the helpers
 * honest.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, '.github/scripts/moderate-content.mjs'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/content-moderation.yml'), 'utf8');

describe('moderation layer 3: VirusTotal URL scan wiring (#378)', () => {
  test('workflow passes VT_API_KEY to the scan step', () => {
    expect(WORKFLOW).toMatch(/VT_API_KEY:\s*\$\{\{\s*secrets\.VT_API_KEY\s*\}\}/);
  });

  test('layer 3 only runs after text layers pass and only with a key', () => {
    expect(SRC).toMatch(/if \(!hitReason && VT_KEY\) \{[\s\S]{0,200}scanUrlsWithVirusTotal/);
  });

  test('flag reason carries the vt_url layer tag', () => {
    expect(SRC).toContain("hitLayer = 'vt_url'");
  });

  test('lookups are GET-only (never submit URLs for analysis, quota)', () => {
    expect(SRC).toContain('virustotal.com/api/v3/urls/');
    expect(SRC).not.toMatch(/method:\s*['"]POST['"][\s\S]{0,120}virustotal/);
  });

  test('per-run budget + call spacing + dedupe cache exist', () => {
    expect(SRC).toMatch(/VT_URL_BUDGET/);
    expect(SRC).toMatch(/VT_SPACING_MS\s*=\s*15500/);
    expect(SRC).toMatch(/_vtVerdictCache/);
  });

  test('flag threshold requires >= 2 engines (single-engine FPs are common)', () => {
    expect(SRC).toMatch(/bad >= 2/);
  });
});

describe('URL extraction helper', () => {
  // The .mjs exports extractUrls/vtUrlId; pull them via dynamic import.
  // Jest here has no ESM transform, so import() of the .mjs throws. This used
  // to be caught and every test below returned early, passing without a
  // single assertion. Evaluate the real helpers from the source instead.
  const urlRe = SRC.match(/const URL_RE = [^;]+;/)[0];
  const fnSrc = (name) => {
    const start = SRC.indexOf(`export function ${name}`);
    return SRC.slice(start, SRC.indexOf('\n}\n', start) + 2).replace('export ', '');
  };
  // eslint-disable-next-line no-new-func
  const { extractUrls, vtUrlId } = new Function('Buffer',
    `${urlRe}\n${fnSrc('extractUrls')}\n${fnSrc('vtUrlId')}\nreturn { extractUrls, vtUrlId };`)(Buffer);

  test('extracts and dedupes http(s) URLs, strips trailing punctuation', () => {
    const urls = extractUrls('check https://evil.example/mal.exe, and http://ok.example/x. Also https://evil.example/mal.exe again');
    expect(urls).toEqual(['https://evil.example/mal.exe', 'http://ok.example/x']);
  });

  test('ignores non-URL text and other schemes', () => {
    expect(extractUrls('gamemoderun %command% -novid')).toEqual([]);
    expect(extractUrls('steam://run/730 file:///etc/passwd')).toEqual([]);
  });

  test('vtUrlId is url-safe base64 without padding', () => {
    const id = vtUrlId('http://example.com/a?b=c');
    expect(id).not.toMatch(/[+/=]/);
    expect(Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).toBe('http://example.com/a?b=c');
  });
});
