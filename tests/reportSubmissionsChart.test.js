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
const API_SRC    = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'analytics.js'), 'utf8');
const CMP_SRC    = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'components', 'analytics.js'), 'utf8');
const RSRC_SRC   = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'lib', 'reportSource.js'), 'utf8');

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
  // reportSource.js is the shared classifier module; load it first so
  // analytics.js's stripped `import { classifyReportSource }` line
  // resolves against a real definition in the vm context.
  vm.runInContext(stripModuleSyntax(RSRC_SRC), ctx);
  vm.runInContext(stripModuleSyntax(API_SRC), ctx);
  return ctx;
}

describe('fetchReportsByDay source breakdown (#76)', () => {
  test('selects source + installation_id columns from user_configs', () => {
    // installation_id is the Deck-plugin signature required by
    // classifyReportSource. Without it the chart could not tell a real
    // plugin submission from a mislabeled 'user' row.
    expect(API_SRC).toContain('select=created_at,source,installation_id&');
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

  test('classifyReportSource treats installation_id as the plugin signature', () => {
    const ctx = loadApi({});
    // Row with installation_id => plugin regardless of source string.
    expect(ctx.classifyReportSource({ source: 'user',     installation_id: 'iid' })).toBe('plugin');
    expect(ctx.classifyReportSource({ source: 'protondb', installation_id: 'iid' })).toBe('plugin');
    expect(ctx.classifyReportSource({ source: '',         installation_id: 'iid' })).toBe('plugin');
  });

  test('classifyReportSource falls to other when a "plugin-ish" source has no installation_id', () => {
    // Half-Life 4: Gabe's Revenge regression guard: source=user but no
    // signature MUST NOT be labelled plugin.
    const ctx = loadApi({});
    expect(ctx.classifyReportSource({ source: 'user' })).toBe('other');
    expect(ctx.classifyReportSource({ source: 'protondb' })).toBe('other');
    expect(ctx.classifyReportSource({ source: 'protondb-local' })).toBe('other');
    expect(ctx.classifyReportSource({ source: '' })).toBe('other');
  });

  test('classifyReportSource is case-insensitive', () => {
    const ctx = loadApi({});
    expect(ctx.classifyReportSource('WEB-LINUX')).toBe('web');
    expect(ctx.classifyReportSource('Plugin-Steamdeck')).toBe('plugin');
  });

  // The padded-range assertions depend on Date.now(). Freeze it to a known
  // day so 'since' and 'today' are deterministic across all environments.
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-06-30T18:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('fetchReportsByDay groups by day + source and includes web/plugin/other counts', async () => {
    // 2d window ending 2026-06-30: covers 06-28 (empty), 06-29, 06-30.
    // 'protondb' is now recognized as a plugin source (see classifier),
    // so include a genuinely unknown source ('cli-import') to still
    // exercise the 'other' bucket.
    const ctx = loadApi({
      '*': [
        { created_at: '2026-06-29T10:00:00Z', source: 'web-linux' },
        { created_at: '2026-06-29T12:00:00Z', source: 'web-windows' },
        { created_at: '2026-06-29T13:00:00Z', source: 'plugin-linux' },
        { created_at: '2026-06-29T14:00:00Z', source: 'cli-import' },
        { created_at: '2026-06-30T09:00:00Z', source: 'plugin-windows' },
      ],
    });
    const rows = await ctx.fetchReportsByDay({}, 2);
    expect(rows).toEqual([
      { day: '2026-06-28', count: 0, web: 0, plugin: 0, other: 0 },
      { day: '2026-06-29', count: 4, web: 2, plugin: 1, other: 1 },
      { day: '2026-06-30', count: 1, web: 0, plugin: 1, other: 0 },
    ]);
  });

  test('fetchReportsByDay pads missing days with zero rows across the full range', async () => {
    // 4d window ending 2026-06-30. Only 06-28 has a report; every other
    // day in the range must still appear as an explicit zero row so the
    // line chart plots a continuous "0 today" signal instead of skipping.
    const ctx = loadApi({
      '*': [
        { created_at: '2026-06-28T10:00:00Z', source: 'web' },
      ],
    });
    const rows = await ctx.fetchReportsByDay({}, 4);
    expect(rows.map(r => r.day)).toEqual([
      '2026-06-26', '2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30',
    ]);
    expect(rows.filter(r => r.count === 0)).toHaveLength(4);
    expect(rows.find(r => r.day === '2026-06-28')).toEqual({
      day: '2026-06-28', count: 1, web: 1, plugin: 0, other: 0,
    });
  });

  test('fetchReportsByDay returns days sorted ascending', async () => {
    const ctx = loadApi({
      '*': [
        { created_at: '2026-06-30T10:00:00Z', source: 'web' },
        { created_at: '2026-06-28T10:00:00Z', source: 'web' },
        { created_at: '2026-06-29T10:00:00Z', source: 'web' },
      ],
    });
    const rows = await ctx.fetchReportsByDay({}, 2);
    expect(rows.map((r) => r.day)).toEqual(['2026-06-28', '2026-06-29', '2026-06-30']);
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
    const rows = await ctx.fetchReportsByDay({}, 1);
    // Padded range: 06-29 (data) + 06-30 (empty). Only 06-29 has counts.
    expect(rows.find(r => r.day === '2026-06-29')).toEqual({
      day: '2026-06-29', count: 3, web: 1, plugin: 0, other: 2,
    });
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

  test('caption explains the signature-based plugin detection', () => {
    // Caption must call out installation_id as the plugin signature so an
    // admin reading the chart understands why a source=user row without
    // the signature does NOT count as Plugin.
    expect(CMP_SRC).toContain('stacked by source');
    expect(CMP_SRC).toContain('Web = browser submissions');
    expect(CMP_SRC).toContain('installation_id');
    // The old caption (source-string trust) must not creep back.
    expect(CMP_SRC).not.toContain('source is "user", "protondb", "protondb-local", or starts with "plugin"');
  });

  test('chart has 3 datasets with matching stack key', () => {
    // All three series must share stack: 'reports' so they stack visually
    // instead of rendering side-by-side.
    const block = CMP_SRC.slice(CMP_SRC.indexOf('reportsChartInstance = new Chart'), CMP_SRC.indexOf('reportsChartInstance = new Chart') + 4000);
    expect(block).toContain("label: 'Web'");
    expect(block).toContain("label: 'Plugin'");
    expect(block).toContain("label: 'Other'");
    const stackCount = (block.match(/stack: 'reports'/g) || []).length;
    expect(stackCount).toBe(3);
  });

  test('chart axes use stacked: true so the three areas add up', () => {
    const block = CMP_SRC.slice(CMP_SRC.indexOf('reportsChartInstance = new Chart'), CMP_SRC.indexOf('reportsChartInstance = new Chart') + 4000);
    // Both x and y axes must declare stacked, otherwise Chart.js overlays the
    // three line areas instead of stacking them and the daily total is lost.
    const stackedCount = (block.match(/stacked: true/g) || []).length;
    expect(stackedCount).toBe(2);
  });

  test('defends against rows missing per-source counts with ?? 0', () => {
    const block = CMP_SRC.slice(CMP_SRC.indexOf('reportsChartInstance = new Chart'), CMP_SRC.indexOf('reportsChartInstance = new Chart') + 4000);
    expect(block).toContain('r.web ?? 0');
    expect(block).toContain('r.plugin ?? 0');
    expect(block).toContain('r.other ?? 0');
  });
});
