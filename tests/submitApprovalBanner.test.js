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

describe('submit edit banner full hash (#147 follow-up)', () => {
  test('banner renders the full approval_hash, not a 12-char slice', () => {
    // Pin both directions: the slice must be gone and the full value
    // must flow into the rendered <code>.
    expect(SUBMIT_MAIN).not.toContain('approval.approval_hash.slice(0, 12)');
    expect(SUBMIT_MAIN).toContain('<code>${approval.approval_hash}</code>');
  });

  test('banner places the hash on its own row via submit-approval-banner-hash', () => {
    expect(SUBMIT_MAIN).toContain('class="submit-approval-banner-hash"');
  });

  test('top row keeps the status badge + report id + approved date', () => {
    const block = SUBMIT_MAIN.slice(
      SUBMIT_MAIN.indexOf('submit-approval-banner-row'),
      SUBMIT_MAIN.indexOf('submit-approval-banner-row') + 600
    );
    expect(block).toContain('submit-approval-badge--approved');
    expect(block).toContain('Report #${editReportId}');
    expect(block).toContain('Approved: ');
  });
});

describe('approval banner CSS wraps the hash (#147 follow-up)', () => {
  test('code element allows word-break:break-all so a 32-char digest wraps', () => {
    const block = MODALS_CSS.slice(
      MODALS_CSS.indexOf('.submit-approval-banner code {'),
      MODALS_CSS.indexOf('.submit-approval-banner code {') + 500
    );
    expect(block).toContain('word-break: break-all');
    expect(block).toContain('white-space: normal');
  });

  test('banner gets a two-row layout via .submit-approval-banner-hash', () => {
    expect(MODALS_CSS).toContain('.submit-approval-banner-hash {');
    expect(MODALS_CSS).toMatch(/\.submit-approval-banner-hash \{[\s\S]{0,400}margin-top:/);
  });

  test('code uses mono font so the digest reads cleanly', () => {
    const block = MODALS_CSS.slice(
      MODALS_CSS.indexOf('.submit-approval-banner code {'),
      MODALS_CSS.indexOf('.submit-approval-banner code {') + 500
    );
    expect(block).toContain('font-family: var(--mono');
  });
});
