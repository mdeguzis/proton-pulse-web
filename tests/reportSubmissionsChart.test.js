/**
 * Tests for #76: admin analytics Report Submissions chart broken down by
 * source. Covers both the data fetcher (group by day + source bucket) and
 * the chart wiring (3 stacked datasets, legend, caption).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripModuleSyntax } = require('./_esm-vm.js');

const ROOT = path.join(__dirname, '..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'analytics.js'), 'utf8');
const CMP_SRC = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'components', 'analytics.js'), 'utf8');

function loadApi(rowsByUrl, urlSpy = []) {
  const ctx = {
    fetch: async (url) => {
      urlSpy.push(url);
      const rows = rowsByUrl[url] ?? rowsByUrl['*'] ?? [];
      return { ok: true, json: async () => rows };
    },
    SUPABASE_URL: 'https://test.supabase.co',
    supabaseHeaders: () => ({ apikey: 'x', Authorization: 'Bearer x' }),
    console,
    Promise, JSON, Object, Array, Number, String, Date, Math, Map, Set,
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  // Strip ES module syntax so we can load + call exported functions.
  vm.runInContext(stripModuleSyntax(API_SRC), ctx);
  return ctx;
}

describe('fetchReportsByDay source breakdown (#76)', () => {
  test('selects source column from user_configs', () => {
    expect(API_SRC).toContain('select=created_at,source&');
  });

  test('classifyReportSource buckets web-* into web', () => {
    const ctx = loadApi({});
    expect(ctx.classifyReportSource('web-linux')).toBe('web');
    expect(ctx.classifyReportSource('web-windows')).toBe('web');
    expect(ctx.classifyReportSource('web-macos')).toBe('web');
    expect(ctx.classifyReportSource('web-steamdeck')).toBe('web');
    expect(ctx.classifyReportSource('web')).toBe('web');
  });

  test('classifyReportSource buckets plugin-* into plugin', () => {
    const ctx = loadApi({});
    expect(ctx.classifyReportSource('plugin-linux')).toBe('plugin');
    expect(ctx.classifyReportSource('plugin-windows')).toBe('plugin');
    expect(ctx.classifyReportSource('plugin')).toBe('plugin');
  });

  test('classifyReportSource falls back to other for everything else', () => {
    const ctx = loadApi({});
    expect(ctx.classifyReportSource('protondb')).toBe('other');
    expect(ctx.classifyReportSource('protondb-live')).toBe('other');
    expect(ctx.classifyReportSource('')).toBe('other');
    expect(ctx.classifyReportSource(null)).toBe('other');
    expect(ctx.classifyReportSource(undefined)).toBe('other');
  });

  test('classifyReportSource is case-insensitive', () => {
    const ctx = loadApi({});
    expect(ctx.classifyReportSource('WEB-LINUX')).toBe('web');
    expect(ctx.classifyReportSource('Plugin-Steamdeck')).toBe('plugin');
  });

  test('fetchReportsByDay groups by day + source and includes web/plugin/other counts', async () => {
    const ctx = loadApi({
      '*': [
        { created_at: '2026-06-29T10:00:00Z', source: 'web-linux' },
        { created_at: '2026-06-29T12:00:00Z', source: 'web-windows' },
        { created_at: '2026-06-29T13:00:00Z', source: 'plugin-linux' },
        { created_at: '2026-06-29T14:00:00Z', source: 'protondb' },
        { created_at: '2026-06-30T09:00:00Z', source: 'plugin-windows' },
      ],
    });
    const rows = await ctx.fetchReportsByDay({}, 7);
    expect(rows).toEqual([
      { day: '2026-06-29', count: 4, web: 2, plugin: 1, other: 1 },
      { day: '2026-06-30', count: 1, web: 0, plugin: 1, other: 0 },
    ]);
  });

  test('fetchReportsByDay returns days sorted ascending', async () => {
    const ctx = loadApi({
      '*': [
        { created_at: '2026-07-01T10:00:00Z', source: 'web' },
        { created_at: '2026-06-28T10:00:00Z', source: 'web' },
        { created_at: '2026-06-30T10:00:00Z', source: 'web' },
      ],
    });
    const rows = await ctx.fetchReportsByDay({}, 7);
    expect(rows.map((r) => r.day)).toEqual(['2026-06-28', '2026-06-30', '2026-07-01']);
  });

  test('fetchReportsByDay returns [] on fetch failure', async () => {
    const ctx = {
      fetch: async () => ({ ok: false }),
      SUPABASE_URL: 'https://test.supabase.co',
      supabaseHeaders: () => ({}),
      console,
      Promise, JSON, Object, Array, Number, String, Date, Math, Map, Set,
      setTimeout, clearTimeout,
    };
    vm.createContext(ctx);
    vm.runInContext(stripModuleSyntax(API_SRC), ctx);
    const rows = await ctx.fetchReportsByDay({}, 7);
    expect(rows).toEqual([]);
  });

  test('fetchReportsByDay tolerates rows missing source field', async () => {
    const ctx = loadApi({
      '*': [
        { created_at: '2026-06-29T10:00:00Z' },
        { created_at: '2026-06-29T12:00:00Z', source: '' },
        { created_at: '2026-06-29T14:00:00Z', source: 'web' },
      ],
    });
    const rows = await ctx.fetchReportsByDay({}, 7);
    expect(rows).toEqual([
      { day: '2026-06-29', count: 3, web: 1, plugin: 0, other: 2 },
    ]);
  });
});

describe('Report Submissions chart source shape (#76)', () => {
  test('legend swatches show Web, Plugin, Other colors', () => {
    const block = CMP_SRC.slice(CMP_SRC.indexOf('id="sec-reports"'), CMP_SRC.indexOf('id="sec-reports"') + 600);
    expect(block).toContain('Web');
    expect(block).toContain('Plugin');
    expect(block).toContain('Other');
    expect(block).toContain('#5c8bd6'); // Web blue
    expect(block).toContain('#4caf80'); // Plugin green
    expect(block).toContain('#d4b36a'); // Other gold
  });

  test('caption explains the source breakdown', () => {
    expect(CMP_SRC).toContain('stacked by source');
    expect(CMP_SRC).toMatch(/Web = browser submissions, Plugin = Steam Deck plugin, Other/);
  });

  test('chart has 3 datasets with matching stack key', () => {
    // All three series must share stack: 'reports' so they stack visually
    // instead of rendering side-by-side.
    const block = CMP_SRC.slice(CMP_SRC.indexOf('reportsChartInstance = new Chart'), CMP_SRC.indexOf('reportsChartInstance = new Chart') + 2500);
    expect(block).toContain("label: 'Web'");
    expect(block).toContain("label: 'Plugin'");
    expect(block).toContain("label: 'Other'");
    const stackCount = (block.match(/stack: 'reports'/g) || []).length;
    expect(stackCount).toBe(3);
  });

  test('chart axes use stacked: true so bars accumulate', () => {
    const block = CMP_SRC.slice(CMP_SRC.indexOf('reportsChartInstance = new Chart'), CMP_SRC.indexOf('reportsChartInstance = new Chart') + 2500);
    // Both x and y axes must declare stacked, otherwise Chart.js groups bars
    // side-by-side and the stack key is ignored.
    const stackedCount = (block.match(/stacked: true/g) || []).length;
    expect(stackedCount).toBe(2);
  });

  test('defends against rows missing per-source counts with ?? 0', () => {
    const block = CMP_SRC.slice(CMP_SRC.indexOf('reportsChartInstance = new Chart'), CMP_SRC.indexOf('reportsChartInstance = new Chart') + 2500);
    expect(block).toContain('r.web ?? 0');
    expect(block).toContain('r.plugin ?? 0');
    expect(block).toContain('r.other ?? 0');
  });
});
