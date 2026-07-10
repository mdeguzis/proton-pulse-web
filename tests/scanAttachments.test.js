/**
 * #228: scan-issue-attachments.yml + its scanner (.github/scripts/scan-attachments.mjs).
 * Pins the pure helper contracts + guards against regressions in URL extraction,
 * extension policy, and VirusTotal response parsing. The workflow YAML has its
 * own static tests so a future edit can't silently drop the permission or
 * trigger blocks that the guardrail depends on.
 */
const fs = require('fs');
const path = require('path');

let extractAttachmentUrls, extensionOf, isSuspiciousExtension, summarizeVirusTotal, EXECUTABLE_EXTENSIONS;

beforeAll(async () => {
  // Pure helpers live in a side-effect-free lib (no import.meta), so babel-jest
  // can transform them cleanly for a CommonJS test runner.
  const mod = await import(path.join(__dirname, '..', '.github', 'scripts', 'scan-attachments-lib.mjs'));
  ({ extractAttachmentUrls, extensionOf, isSuspiciousExtension, summarizeVirusTotal, EXECUTABLE_EXTENSIONS } = mod);
});

describe('extractAttachmentUrls', () => {
  test('finds github user-attachment URLs in a plain body', () => {
    const body = 'here is the file: https://github.com/user-attachments/files/12345/thing.exe';
    expect(extractAttachmentUrls(body)).toEqual([
      'https://github.com/user-attachments/files/12345/thing.exe',
    ]);
  });

  test('finds githubusercontent image URLs', () => {
    const body = '![](https://user-images.githubusercontent.com/1/2.png)';
    expect(extractAttachmentUrls(body)).toEqual([
      'https://user-images.githubusercontent.com/1/2.png',
    ]);
  });

  test('finds private-user-images URLs (CDN redirect target)', () => {
    const body = 'redirected: https://private-user-images.githubusercontent.com/abc/def.png?jwt=xxx';
    expect(extractAttachmentUrls(body)).toContain(
      'https://private-user-images.githubusercontent.com/abc/def.png?jwt=xxx'
    );
  });

  test('strips trailing markdown punctuation', () => {
    // GitHub renders attachments inside parens like [file](url)
    const body = 'see [my file](https://github.com/user-attachments/files/1/x.exe).';
    expect(extractAttachmentUrls(body)).toEqual([
      'https://github.com/user-attachments/files/1/x.exe',
    ]);
  });

  test('dedupes repeated URLs so the scanner does not double-hash', () => {
    const body = [
      'https://github.com/user-attachments/files/1/dup.exe',
      'https://github.com/user-attachments/files/1/dup.exe',
    ].join('\n');
    expect(extractAttachmentUrls(body)).toEqual([
      'https://github.com/user-attachments/files/1/dup.exe',
    ]);
  });

  test('returns [] for empty / non-string bodies without throwing', () => {
    expect(extractAttachmentUrls('')).toEqual([]);
    expect(extractAttachmentUrls(null)).toEqual([]);
    expect(extractAttachmentUrls(undefined)).toEqual([]);
    expect(extractAttachmentUrls(1234)).toEqual([]);
  });

  test('ignores non-github URLs', () => {
    const body = 'my blog https://example.com/thing.exe and pastebin http://pastebin.com/x';
    expect(extractAttachmentUrls(body)).toEqual([]);
  });
});

describe('extensionOf', () => {
  test('pulls the trailing extension', () => {
    expect(extensionOf('https://x/y.exe')).toBe('exe');
    expect(extensionOf('foo.tar.gz')).toBe('gz');
    expect(extensionOf('BIG.PNG')).toBe('png');
  });

  test('ignores query strings + fragments', () => {
    expect(extensionOf('https://x/y.msi?jwt=abc')).toBe('msi');
    expect(extensionOf('https://x/y.msi#frag')).toBe('msi');
  });

  test('returns empty string when there is no extension', () => {
    expect(extensionOf('https://x/y')).toBe('');
    expect(extensionOf('')).toBe('');
    expect(extensionOf(null)).toBe('');
  });
});

describe('isSuspiciousExtension', () => {
  test('flags the classic Windows executable set', () => {
    for (const ext of ['exe', 'msi', 'scr', 'com', 'bat', 'cmd', 'ps1', 'vbs']) {
      expect(isSuspiciousExtension(ext)).toBe(true);
    }
  });

  test('flags cross-platform payload wrappers', () => {
    for (const ext of ['jar', 'apk', 'dmg', 'pkg', 'appimage', 'sh', 'iso']) {
      expect(isSuspiciousExtension(ext)).toBe(true);
    }
  });

  test('leaves images / docs / archives alone by default', () => {
    for (const ext of ['png', 'jpg', 'gif', 'pdf', 'txt', 'md', 'zip']) {
      expect(isSuspiciousExtension(ext)).toBe(false);
    }
  });

  test('is case-insensitive', () => {
    expect(isSuspiciousExtension('EXE')).toBe(true);
    expect(isSuspiciousExtension('Msi')).toBe(true);
  });
});

describe('summarizeVirusTotal', () => {
  test('extracts malicious + engine counts from v3 shape', () => {
    const resp = {
      data: { attributes: { last_analysis_stats: {
        malicious: 12, suspicious: 3, undetected: 55, harmless: 0, timeout: 0, failure: 0,
      } } },
    };
    const s = summarizeVirusTotal(resp);
    expect(s).toEqual({ known: true, malicious: 12, suspicious: 3, engines: 70 });
  });

  test('handles unknown hashes (missing attributes)', () => {
    expect(summarizeVirusTotal({})).toEqual({ known: false, malicious: 0, suspicious: 0, engines: 0 });
    expect(summarizeVirusTotal(null)).toEqual({ known: false, malicious: 0, suspicious: 0, engines: 0 });
  });

  test('tolerates missing counters', () => {
    const resp = { data: { attributes: { last_analysis_stats: { malicious: 1 } } } };
    expect(summarizeVirusTotal(resp).malicious).toBe(1);
    expect(summarizeVirusTotal(resp).engines).toBe(1);
  });
});

describe('EXECUTABLE_EXTENSIONS invariants', () => {
  test('is a non-trivial set (guards against accidental empty)', () => {
    expect(EXECUTABLE_EXTENSIONS.size).toBeGreaterThanOrEqual(15);
  });
});

describe('workflow YAML', () => {
  const yamlPath = path.join(__dirname, '..', '.github', 'workflows', 'scan-issue-attachments.yml');
  const src = fs.readFileSync(yamlPath, 'utf8');

  test('fires on the three body-carrying event types', () => {
    // Removing any of these breaks the guardrail silently.
    expect(src).toMatch(/on:\s*[\s\S]*?issues:\s*\n\s*types: \[opened, edited\]/);
    expect(src).toMatch(/issue_comment:\s*\n\s*types: \[created, edited\]/);
    expect(src).toMatch(/pull_request_review_comment:\s*\n\s*types: \[created, edited\]/);
  });

  test('grants issues + PR write so hide + label + comment succeed', () => {
    expect(src).toContain('issues: write');
    expect(src).toContain('pull-requests: write');
  });

  test('exempts the repo owner + known bots from scanning', () => {
    expect(src).toContain("github.actor != github.repository_owner");
    expect(src).toContain("github.actor != 'dependabot[bot]'");
    expect(src).toContain("github.actor != 'github-actions[bot]'");
  });

  test('threads VT_API_KEY through to the script env', () => {
    // Optional secret -- when unset the scanner falls back to extension policy.
    expect(src).toContain('VT_API_KEY: ${{ secrets.VT_API_KEY }}');
  });

  test('invokes the scanner via node .github/scripts/scan-attachments.mjs', () => {
    expect(src).toContain('node .github/scripts/scan-attachments.mjs');
  });
});
