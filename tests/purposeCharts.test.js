/**
 * Tests for js/shared/purpose-charts.js (#207, umbrella #204).
 *
 * The module writes into window.Chart at render time -- we stub Chart with a
 * jest.fn constructor so we can inspect the config it built for each purpose.
 * That keeps the tests hermetic without pulling in a real Chart.js.
 */

const {
  renderPurposeChart, crossTabToCorrelation,
} = require('../js/shared/purpose-charts.js');

function stubChart() {
  const instances = [];
  const chartCtor = jest.fn(function (canvas, cfg) {
    this.canvas = canvas;
    this.config = cfg;
    this.data = cfg.data;
    this.options = cfg.options;
    this.destroy = jest.fn();
    instances.push(this);
  });
  global.window = { Chart: chartCtor };
  return { chartCtor, instances };
}

describe('crossTabToCorrelation', () => {
  test('flattens { xLabel: { seriesKey: n } } to labels + series arrays', () => {
    const crossTab = {
      amd:    { platinum: 3, gold: 4, borked: 1 },
      nvidia: { platinum: 5, gold: 2, silver: 1 },
    };
    const out = crossTabToCorrelation(crossTab, ['platinum', 'gold', 'silver', 'borked']);
    expect(out.labels).toEqual(['amd', 'nvidia']);
    // Series ordered by preferredKeys, missing cells zero-filled.
    expect(out.series).toEqual([
      { key: 'platinum', values: [3, 5] },
      { key: 'gold',     values: [4, 2] },
      { key: 'silver',   values: [0, 1] },
      { key: 'borked',   values: [1, 0] },
    ]);
  });

  test('appends unknown keys at the end when preferredKeys does not cover them', () => {
    const crossTab = { linux: { platinum: 1, unknown: 2 } };
    const out = crossTabToCorrelation(crossTab, ['platinum']);
    expect(out.series.map(s => s.key)).toEqual(['platinum', 'unknown']);
  });

  test('empty / null input yields empty shape', () => {
    expect(crossTabToCorrelation(null)).toEqual({ labels: [], series: [] });
    expect(crossTabToCorrelation({})).toEqual({ labels: [], series: [] });
  });
});

describe('renderPurposeChart configurations', () => {
  beforeEach(() => { global.window = undefined; });

  test('distribution -> single bar dataset, legend hidden', () => {
    const { instances } = stubChart();
    renderPurposeChart({}, {
      purpose: 'distribution',
      data: { labels: ['a', 'b'], values: [3, 7] },
    });
    expect(instances).toHaveLength(1);
    const cfg = instances[0].config;
    expect(cfg.type).toBe('bar');
    expect(cfg.data.datasets).toHaveLength(1);
    expect(cfg.data.datasets[0].data).toEqual([3, 7]);
    expect(cfg.options.plugins.legend.display).toBe(false);
  });

  test('correlation -> stacked bar with one dataset per series', () => {
    const { instances } = stubChart();
    renderPurposeChart({}, {
      purpose: 'correlation',
      data: {
        labels: ['amd', 'nvidia'],
        series: [
          { key: 'platinum', values: [3, 5] },
          { key: 'borked',   values: [1, 0] },
        ],
      },
    });
    const cfg = instances[0].config;
    expect(cfg.type).toBe('bar');
    expect(cfg.data.datasets.map(d => d.label)).toEqual(['platinum', 'borked']);
    expect(cfg.options.scales.x.stacked).toBe(true);
    expect(cfg.options.scales.y.stacked).toBe(true);
  });

  test('flow -> grouped bar (not stacked)', () => {
    const { instances } = stubChart();
    renderPurposeChart({}, {
      purpose: 'flow',
      data: {
        labels: ['a', 'b'],
        series: [{ key: 'x', values: [1, 2] }],
      },
    });
    const cfg = instances[0].config;
    expect(cfg.options.scales.x.stacked).toBe(false);
    expect(cfg.options.scales.y.stacked).toBe(false);
  });

  test('time-series -> line with one dataset per series', () => {
    const { instances } = stubChart();
    renderPurposeChart({}, {
      purpose: 'time-series',
      data: {
        labels: ['2024', '2025'],
        series: [
          { key: 'platinum', values: [10, 20] },
          { key: 'borked',   values: [5, 3] },
        ],
      },
    });
    const cfg = instances[0].config;
    expect(cfg.type).toBe('line');
    expect(cfg.data.datasets.map(d => d.label)).toEqual(['platinum', 'borked']);
    expect(cfg.data.datasets[0].tension).toBeGreaterThan(0); // smooths curves
  });

  test('unknown purpose returns null and does not construct a chart', () => {
    const { chartCtor } = stubChart();
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = renderPurposeChart({}, { purpose: 'sankey-dreamland', data: {} });
    expect(out).toBeNull();
    expect(chartCtor).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('no-op when Chart.js is not loaded (window.Chart missing)', () => {
    global.window = {}; // Chart absent
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = renderPurposeChart({}, { purpose: 'distribution', data: { labels: [], values: [] } });
    expect(out).toBeNull();
    spy.mockRestore();
  });

  test('onSlice is called with { category, key } when a bar segment is clicked', () => {
    const { instances } = stubChart();
    const onSlice = jest.fn();
    renderPurposeChart({}, {
      purpose: 'correlation',
      data: {
        labels: ['amd', 'nvidia'],
        series: [{ key: 'platinum', values: [3, 5] }, { key: 'borked', values: [1, 0] }],
      },
      options: { onSlice },
    });
    const inst = instances[0];
    // Simulate Chart.js invoking onClick with a fake activeEls array.
    inst.config.options.onClick({}, [{ datasetIndex: 1, index: 0 }]);
    expect(onSlice).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'amd', key: 'borked', datasetIndex: 1, index: 0 }),
    );
  });
});
