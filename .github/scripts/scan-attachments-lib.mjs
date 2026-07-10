// Pure helpers for scan-attachments.mjs (#228). Split out so the tests can
// import them without hitting `import.meta.url` (which babel-jest cannot
// transform for a CJS-loaded test file). Zero side effects, no I/O.

// Attachment URLs GitHub renders inline. `objects.githubusercontent.com`
// is the CDN backing github.com/user-attachments/ redirects.
export const ATTACHMENT_URL_RE =
  /https?:\/\/(?:github\.com\/user-attachments|(?:private-)?user-images\.githubusercontent\.com|objects\.githubusercontent\.com)\/\S+/gi;

// Extensions we treat as inherently high-risk when uploaded by a non-owner.
// A hit here alone is enough to hide the comment (VT lookup is a bonus).
export const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'msi', 'scr', 'com', 'bat', 'cmd',
  'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh',
  'jar', 'apk', 'dmg', 'pkg', 'appimage',
  'sh', 'bin', 'run',                     // linux native binaries + install scripts
  'iso', 'img',                           // large payload wrappers
]);

/** Extract every attachment URL from a body of text. */
export function extractAttachmentUrls(body) {
  if (!body || typeof body !== 'string') return [];
  const raw = body.match(ATTACHMENT_URL_RE) || [];
  // Strip trailing ')' or '.' from markdown wrapping.
  return [...new Set(raw.map((u) => u.replace(/[)\].,]+$/g, '')))];
}

/** Best-effort extension pull from a URL or a filename. Returns lowercase. */
export function extensionOf(urlOrName) {
  const s = String(urlOrName || '').toLowerCase();
  // Ignore query strings + fragments.
  const clean = s.split(/[?#]/)[0];
  const m = clean.match(/\.([a-z0-9]{1,10})$/);
  return m ? m[1] : '';
}

/** Would we hide this attachment on extension alone? */
export function isSuspiciousExtension(ext) {
  return EXECUTABLE_EXTENSIONS.has(String(ext || '').toLowerCase());
}

/**
 * Map a VirusTotal /files/{hash} response to a { known, malicious, suspicious, engines } tuple.
 * The public v3 shape:
 *   { data: { attributes: { last_analysis_stats: { malicious, suspicious, ... } } } }
 * A single malicious engine hit is enough to escalate -- false positives on
 * Windows PE binaries are rare in aggregate and the hide is reversible.
 */
export function summarizeVirusTotal(response) {
  const stats = response?.data?.attributes?.last_analysis_stats;
  if (!stats) return { known: false, malicious: 0, suspicious: 0, engines: 0 };
  const malicious = Number(stats.malicious || 0);
  const suspicious = Number(stats.suspicious || 0);
  const engines = malicious + suspicious + Number(stats.undetected || 0)
                + Number(stats.harmless || 0) + Number(stats.timeout || 0)
                + Number(stats.failure || 0);
  return { known: true, malicious, suspicious, engines };
}
