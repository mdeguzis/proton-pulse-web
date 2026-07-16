const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('edit/submit return-to-origin and toast-only success', () => {
  const submitSrc = read('js/submit/main.js');
  const profileReportsSrc = read('js/profile/components/my-reports.js');

  test('profile edit/publish links pass return=profile.html', () => {
    expect(profileReportsSrc).toContain('&edit=${escapeHtml(String(row.published_id))}&return=profile.html');
    expect(profileReportsSrc).toContain('&fromCloud=1&return=profile.html');
  });

  test('submit reads and sanitizes the return param (no open redirect)', () => {
    expect(submitSrc).toContain("const returnRaw = params.get('return') || ''");
    // Sanitizer: parse the caller-supplied value as a URL against the current
    // page, require the resolved origin to match, and restrict the final path
    // component to an allowlist. This shape (URL parse + origin equality +
    // filename allowlist) is what CodeQL recognizes as a safe sanitizer for
    // `location.href = <userInput>` sinks.
    expect(submitSrc).toContain('ALLOWED_RETURN_PAGES');
    expect(submitSrc).toContain('new URL(returnRaw, window.location.href)');
    expect(submitSrc).toContain('parsed.origin === window.location.origin');
    expect(submitSrc).toContain('ALLOWED_RETURN_PAGES.has(filename)');
  });

  test('redirect prefers returnTo, falls back to the game page', () => {
    expect(submitSrc).toContain('const dest = returnTo || `app.html#/app/${appId}`');
    expect(submitSrc).toContain('window.location.href = dest');
  });

  test('success is shown only via toast, not a duplicate inline status', () => {
    expect(submitSrc).toContain("window.ppToast?.success(isEdit ? 'Changes saved.'");
    expect(submitSrc).not.toContain('savedText');
  });
});
