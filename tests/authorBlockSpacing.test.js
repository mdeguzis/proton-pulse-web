/**
 * Tests that .card-author has bottom padding so the "N reports / Xh"
 * stats line is not flush against the card border below it.
 */

const fs = require('fs');
const path = require('path');

const REPORTS_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'app', 'reports.css'),
  'utf8'
);

describe('.card-author bottom spacing', () => {
  test('carries padding-bottom so author-stats does not touch the border', () => {
    const block = REPORTS_CSS.slice(
      REPORTS_CSS.indexOf('.card-author {'),
      REPORTS_CSS.indexOf('.card-author {') + 600
    );
    expect(block).toMatch(/padding-bottom:\s*\d+px/);
  });
});
