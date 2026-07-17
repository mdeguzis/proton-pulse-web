/**
 * Pin the admin All Reports SOURCE column to use the shared
 * formatReportSourceLabel helper. Without this, a future refactor
 * could regress the cell back to the raw source string and the plugin
 * submissions would once again show up as bare "user" -- confusing
 * admins and hiding where the report actually came from.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'components', 'allReports.js'),
  'utf8',
);

describe('All Reports admin table: SOURCE column formatting', () => {
  test('imports formatReportSourceLabel from the shared reportSource module', () => {
    expect(SRC).toMatch(/import\s*\{\s*formatReportSourceLabel\s*\}\s*from\s*['"]\.\.\/lib\/reportSource\.js/);
  });

  test('row-render passes the whole row to formatReportSourceLabel', () => {
    // Whole-row (not just r.source) so the formatter can see
    // installation_id -- the Deck-plugin signature that distinguishes a
    // real plugin submission from a mislabeled 'user' row.
    expect(SRC).toContain('formatReportSourceLabel(r)');
    expect(SRC).toContain('escapeHtml(formatReportSourceLabel(r))');
  });

  test('detail modal Source row also passes the whole report to the formatter', () => {
    expect(SRC).toMatch(/\['Source',[\s\S]{0,200}formatReportSourceLabel\(report\)/);
  });

  test('no lingering raw escapeHtml(r.source) that would bypass the formatter', () => {
    // Regression guard: catch a future refactor that swaps back to the raw
    // string. The row-render is the only place r.source lands in the DOM
    // from this file; if we see the bare escape it means the formatter was
    // dropped.
    expect(SRC).not.toContain('escapeHtml(r.source || \'\')');
  });

  test('no formatReportSourceLabel(r.source) calls sneak back (must pass the row)', () => {
    // Passing r.source drops the installation_id signal and re-opens the
    // Half-Life 4: Gabe's Revenge mislabel where a user-string row was
    // silently promoted to 'plugin'.
    expect(SRC).not.toContain('formatReportSourceLabel(r.source)');
    expect(SRC).not.toContain('formatReportSourceLabel(report.source)');
  });
});
