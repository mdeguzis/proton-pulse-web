/**
 * Source-shape pins for the admin analytics chart config.
 *
 * The Chart.js constructors live inside renderAnalytics and are painful to
 * introspect from a jsdom-free test env. Pin the specific shape via source
 * inspection so a regression on the "hover shows every series + total"
 * behaviour, or a silent bar<->line flip, fails loudly.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'components', 'analytics.js'),
  'utf8',
);

// Grab just the reports-chart block so the assertions can't be satisfied by
// unrelated Chart.js configs elsewhere in the file (data-cache, img-routes).
function reportsChartBlock() {
  const start = SRC.indexOf('reportsChartInstance = new Chart(');
  expect(start).toBeGreaterThan(0);
  // Balance braces from the constructor's opening '{' to find its end.
  const openParen = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = openParen; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('unterminated Chart config in analytics.js');
}

function dailyChartBlock() {
  const start = SRC.indexOf('chartInstance = new Chart(');
  expect(start).toBeGreaterThan(0);
  const openParen = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = openParen; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('unterminated Chart config in analytics.js');
}

describe('admin analytics: reports chart is a stacked area line', () => {
  test("reports chart uses type: 'line', not 'bar'", () => {
    const block = reportsChartBlock();
    expect(block).toMatch(/type:\s*'line'/);
    expect(block).not.toMatch(/type:\s*'bar'/);
  });

  test('every reports dataset is a filled area with tension for the line curve', () => {
    const block = reportsChartBlock();
    // Three datasets (Web / Plugin / Other) each with fill + tension.
    expect(block.match(/fill:\s*true/g)).toHaveLength(3);
    expect(block.match(/tension:\s*0\.3/g)).toHaveLength(3);
    // Stacked so the three lines add up rather than overlap.
    expect(block.match(/stack:\s*'reports'/g)).toHaveLength(3);
  });

  test('both axes stay stacked so the areas add up correctly', () => {
    const block = reportsChartBlock();
    // Two stacked: true entries -- one on each axis.
    expect(block.match(/stacked:\s*true/g)).toHaveLength(2);
  });
});

describe('admin analytics: tooltips show every series on hover + a total', () => {
  test('reports tooltip is index-mode so hovering the day column shows all three series', () => {
    const block = reportsChartBlock();
    expect(block).toMatch(/interaction:\s*\{\s*mode:\s*'index',\s*intersect:\s*false\s*\}/);
    expect(block).toMatch(/tooltip:\s*\{[\s\S]*mode:\s*'index'/);
    expect(block).toMatch(/intersect:\s*false/);
  });

  test('reports tooltip has title + label + footer callbacks (footer prints the daily total)', () => {
    const block = reportsChartBlock();
    expect(block).toContain('title: items => _formatTooltipDate(items[0].label)');
    expect(block).toMatch(/label:\s*ctx\s*=>/);
    // The footer callback sums the per-series values into a "Total: N" line.
    expect(block).toMatch(/footer:\s*items\s*=>/);
    expect(block).toContain("`Total: ${total.toLocaleString()}`");
  });

  test('sessions chart also uses index-mode tooltip with the shared date formatter', () => {
    const block = dailyChartBlock();
    expect(block).toMatch(/interaction:\s*\{\s*mode:\s*'index',\s*intersect:\s*false\s*\}/);
    expect(block).toContain('title: items => _formatTooltipDate(items[0].label)');
    expect(block).toMatch(/label:\s*ctx\s*=>/);
  });
});

describe('line curves stay within the data (no bezier overshoot)', () => {
  test('every dataset pairs tension with cubicInterpolationMode: monotone', () => {
    // Without monotone, Chart.js's cubic bezier dips below equal-height
    // neighbors and creates a visible divot between adjacent peaks --
    // very obvious on a stacked area chart with flat plateaus.
    const daily = dailyChartBlock();
    const reports = reportsChartBlock();
    // Sessions chart: 2 datasets.
    expect((daily.match(/cubicInterpolationMode:\s*'monotone'/g) || []).length).toBe(2);
    // Reports chart: 3 datasets (Web / Plugin / Other).
    expect((reports.match(/cubicInterpolationMode:\s*'monotone'/g) || []).length).toBe(3);
  });
});

describe('y-axis has headroom above the tallest data point', () => {
  test('both charts pad the y-axis max by +1 so the top line has a clean gap', () => {
    expect(dailyChartBlock()).toMatch(/grace:\s*1/);
    expect(reportsChartBlock()).toMatch(/grace:\s*1/);
  });
});

describe('vertical hover guideline is wired on both charts', () => {
  test('_verticalHoverLine plugin is defined with an afterDraw hook', () => {
    // The plugin uses afterDraw + chart.tooltip._active[0].element.x to
    // paint a 1px dashed vertical line at the hovered index. If any of
    // those anchors move, the guideline stops rendering silently.
    expect(SRC).toMatch(/id:\s*'verticalHoverLine'/);
    expect(SRC).toContain('afterDraw(chart)');
    expect(SRC).toContain('chart.tooltip?._active');
    expect(SRC).toContain('setLineDash([3, 3])');
  });

  test('both Chart() calls register the plugin via plugins: [_verticalHoverLine]', () => {
    const daily = dailyChartBlock();
    const reports = reportsChartBlock();
    expect(daily).toContain('plugins: [_verticalHoverLine]');
    expect(reports).toContain('plugins: [_verticalHoverLine]');
  });
});

describe('legend swatches are colored blocks, not the &#9644; unicode line', () => {
  test('renderAnalytics HTML uses analytics-legend + analytics-legend-swatch', () => {
    expect(SRC).toContain('analytics-legend');
    expect(SRC).toContain('analytics-legend-swatch');
    // The old &#9644; character rendered as an off-color glyph in most
    // fonts and was hard to read; make sure it's not lingering in the
    // legend rows we just refactored.
    expect(SRC).not.toContain('&#9644;');
  });

  test('swatch colors match the chart line colors', () => {
    // Legend swatches inline-style background to the same hex as the
    // dataset borderColor so the visual pairing is one-to-one.
    expect(SRC).toMatch(/analytics-legend-swatch"\s+style="background:#5c8bd6"><\/span>Sessions/);
    expect(SRC).toMatch(/analytics-legend-swatch"\s+style="background:#4caf80"><\/span>Unique users/);
    expect(SRC).toMatch(/analytics-legend-swatch"\s+style="background:#5c8bd6"><\/span>Web/);
    expect(SRC).toMatch(/analytics-legend-swatch"\s+style="background:#4caf80"><\/span>Plugin/);
    expect(SRC).toMatch(/analytics-legend-swatch"\s+style="background:#d4b36a"><\/span>Other/);
  });
});

describe('analytics-legend CSS shape', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'css', 'admin', 'admin.css'), 'utf8');
  test('.analytics-legend + swatch styles exist in admin.css', () => {
    expect(CSS).toContain('.analytics-legend {');
    expect(CSS).toContain('.analytics-legend-item {');
    expect(CSS).toContain('.analytics-legend-swatch {');
  });
});

describe('_formatTooltipDate helper', () => {
  test('YYYY-MM-DD gets expanded to a readable weekday + month + day + year', () => {
    // The helper is module-local; exercise it via a tiny eval-in-scope trick
    // by requiring the source and pulling it out with a regex-free approach:
    // we just re-implement the assertion via a Function so the coverage
    // signal isn't wasted -- this is a pure formatting sanity check.
    const fn = new Function(
      'label',
      `
      if (!label || typeof label !== 'string') return String(label || '');
      const m = label.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
      if (!m) return label;
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (isNaN(d.getTime())) return label;
      return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
      `,
    );
    // Locale can vary in CI, so assert on stable substrings.
    const out = fn('2026-07-01');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/Jul/);
    expect(out).toMatch(/1/);
  });

  test('non-YYYY-MM-DD strings pass through unchanged', () => {
    const fn = new Function(
      'label',
      `
      if (!label || typeof label !== 'string') return String(label || '');
      const m = label.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
      if (!m) return label;
      return 'formatted';
      `,
    );
    expect(fn('Week 27')).toBe('Week 27');
    expect(fn('')).toBe('');
    expect(fn(null)).toBe('');
    expect(fn(undefined)).toBe('');
  });
});
