/**
 * Tests for the pending review detail page wrapping long opaque IDs
 * (md5 approval hash, UUIDs) instead of forcing horizontal scroll.
 *
 * Source-shape only -- pending.js renders into a real DOM and pulls Supabase
 * state, so the full behavior needs jsdom + supabase mocks. The wrap intent
 * is small enough that pinning the field list + render branch is enough to
 * catch regressions.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'components', 'pending.js'),
  'utf8'
);

describe('pending review detail: long-ID wrap (#141 verification UX)', () => {
  test('Approval Hash field carries wrap:true so it breaks across lines', () => {
    expect(SRC).toMatch(/\['Approval Hash',\s*val\(report\._approval_hash\),\s*\{\s*wrap:\s*true\s*\}\]/);
  });

  test('Author and Client ID fields also wrap (long UUIDs)', () => {
    expect(SRC).toContain("['Author', report.proton_pulse_user_id || report.client_id || 'anonymous', { wrap: true }]");
    expect(SRC).toContain("['Client ID', val(report.client_id), { wrap: true }]");
  });

  test('non-wrap fields stay 2-tuples (regression guard)', () => {
    // App ID, Title, OS, etc. should NOT carry wrap because they are short
    // and look weird if forced to break-all.
    expect(SRC).toMatch(/\['App ID', val\(report\.app_id\)\],/);
    expect(SRC).toMatch(/\['Title', val\(report\.title\)\],/);
    expect(SRC).toMatch(/\['Rating', val\(report\.rating\)\],/);
  });

  test('renderer applies word-break:break-all only when opts.wrap is set', () => {
    expect(SRC).toContain("opts && opts.wrap");
    expect(SRC).toContain('word-break:break-all');
    expect(SRC).toContain('white-space:normal');
  });

  test('renderer uses monospace font for wrapped cells', () => {
    // Long hex hashes read much cleaner in mono; also visually distinguishes
    // them from prose values like Notes.
    expect(SRC).toContain('font-family:var(--mono)');
  });
});

describe('pending review detail: collapsed details section (#145)', () => {
  test('summary section contains the always-visible identifiers', () => {
    // Order matters for visual layout: status badge first, then identity
    // (Report ID, Hash, App ID, Title, Author). Detail fields move down.
    const idx = (s) => SRC.indexOf(s);
    expect(idx("['Report ID',")).toBeGreaterThan(0);
    expect(idx("['Approval Hash',")).toBeGreaterThan(0);
    expect(idx("['Author',")).toBeGreaterThan(0);
    // Author must appear in the summary half, before the detailFields array.
    expect(idx("const summaryFields = [")).toBeLessThan(idx("['Author',"));
    expect(idx("['Author',")).toBeLessThan(idx("const detailFields = ["));
  });

  test('detailFields contains CPU/GPU/Notes/Form Responses (hidden by default)', () => {
    const detailIdx = SRC.indexOf('const detailFields = [');
    const tail = SRC.slice(detailIdx, detailIdx + 1500);
    expect(tail).toContain("['CPU',");
    expect(tail).toContain("['GPU',");
    expect(tail).toContain("['Notes',");
    expect(tail).toContain("['Submitted',");
  });

  test('renders a See details toggle button with aria-controls', () => {
    expect(SRC).toContain('id="pending-details-toggle"');
    expect(SRC).toContain('aria-controls="pending-details-extra"');
    expect(SRC).toContain('aria-expanded="false"');
    expect(SRC).toContain('Show details');
  });

  test('detail section is hidden by default and lives behind the toggle', () => {
    // The collapsed wrapper must use the `hidden` attribute so it is not
    // rendered visually until expanded. A regression that drops `hidden`
    // would mean the page renders with everything open again.
    expect(SRC).toMatch(/id="pending-details-extra"\s+hidden/);
  });

  test('toggle handler flips both hidden state and aria-expanded', () => {
    expect(SRC).toContain("detailsToggle.setAttribute('aria-expanded'");
    expect(SRC).toContain("detailsExtra.hidden = open");
    expect(SRC).toContain("'Show details'");
    expect(SRC).toContain("'Hide details'");
  });

  test('status badge derives from approval row presence', () => {
    // Approved badge appears when _approval_hash is truthy, pending otherwise.
    expect(SRC).toContain('const isApproved = !!report._approval_hash');
    expect(SRC).toContain('submit-approval-badge--approved');
    expect(SRC).toContain('submit-approval-badge--pending');
  });

  test('Approve / Decline buttons remain rendered (not hidden behind toggle)', () => {
    // The point of the collapse is to keep moderation actions above the
    // fold. If a refactor accidentally moved them inside the details
    // wrapper, the issue would regress.
    const buttonIdx = SRC.indexOf('id="pending-approve-btn"');
    const extraOpenIdx = SRC.indexOf('id="pending-details-extra"');
    const extraCloseIdx = SRC.indexOf('</div>', extraOpenIdx);
    expect(buttonIdx).toBeGreaterThan(extraCloseIdx);
  });
});
