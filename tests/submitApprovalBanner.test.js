/**
 * Tests for the Approved banner on submit.html?edit= flow.
 *
 * The user must be able to verify the full md5 approval_hash against a
 * stored value. Truncating the hash to 12 chars + "..." made that
 * impossible. The banner now renders the full hash on its own row.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUBMIT_MAIN = fs.readFileSync(path.join(ROOT, 'js', 'submit', 'main.js'), 'utf8');
const MODALS_CSS  = fs.readFileSync(path.join(ROOT, 'css', 'app', 'modals.css'), 'utf8');

describe('submit edit banner collapsible (#147 + #149)', () => {
  test('renders the full approval_hash, never a slice', () => {
    expect(SUBMIT_MAIN).not.toContain('approval.approval_hash.slice');
    expect(SUBMIT_MAIN).toContain('<code>${approval.approval_hash}</code>');
  });

  test('uses a native <details>/<summary> so collapse works without JS', () => {
    expect(SUBMIT_MAIN).toContain('<details class="submit-approval-banner-details">');
    expect(SUBMIT_MAIN).toContain('<summary class="submit-approval-banner-summary">');
  });

  test('summary line only shows the badge + report number + toggle link', () => {
    const summary = SUBMIT_MAIN.slice(
      SUBMIT_MAIN.indexOf('<summary class="submit-approval-banner-summary">'),
      SUBMIT_MAIN.indexOf('</summary>')
    );
    expect(summary).toContain('submit-approval-badge--approved');
    expect(summary).toContain('Report #${editReportId}');
    expect(summary).toContain('See all details');
    // Date / By / Hash must NOT be in the summary -- those collapse away.
    expect(summary).not.toContain('Approved: ');
    expect(summary).not.toContain('Hash:');
  });

  test('expanded section renders each field on its own row with a label', () => {
    const body = SUBMIT_MAIN.slice(SUBMIT_MAIN.indexOf('</summary>'));
    expect(body).toContain('submit-approval-banner-field');
    expect(body).toContain('<span class="submit-approval-banner-label">Approved</span>');
    expect(body).toContain('<span class="submit-approval-banner-label">By</span>');
    expect(body).toContain('<span class="submit-approval-banner-label">Hash</span>');
  });
});

describe('approval banner CSS (#147 + #149)', () => {
  test('code element wraps long hashes', () => {
    const block = MODALS_CSS.slice(
      MODALS_CSS.indexOf('.submit-approval-banner code {'),
      MODALS_CSS.indexOf('.submit-approval-banner code {') + 500
    );
    expect(block).toContain('word-break: break-all');
    expect(block).toContain('font-family: var(--mono');
  });

  test('summary strips the default disclosure triangle so the layout stays clean', () => {
    expect(MODALS_CSS).toContain('.submit-approval-banner-details > summary');
    expect(MODALS_CSS).toContain('list-style: none');
    expect(MODALS_CSS).toContain('::-webkit-details-marker { display: none');
  });

  test('toggle text flips its arrow indicator when expanded', () => {
    expect(MODALS_CSS).toMatch(/submit-approval-banner-toggle::before \{ content: "\\25B6/);
    expect(MODALS_CSS).toMatch(/details\[open\][\s\S]{0,200}submit-approval-banner-toggle::before \{ content: "\\25BC/);
  });

  test('expanded field rows use a labeled column layout', () => {
    expect(MODALS_CSS).toContain('.submit-approval-banner-field {');
    expect(MODALS_CSS).toContain('.submit-approval-banner-label {');
  });
});
