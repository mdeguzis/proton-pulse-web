/**
 * Tests for app-chart-interactions.js -- attachClickToFilter, dispatchFilter,
 * onFilterChange, and attachChartHover's continuous-tracking path.
 *
 * jsdom doesnt do real SVG measurement, but the helper only needs
 * getBoundingClientRect on the svg (which jsdom returns as zeros) plus
 * the viewBox.baseVal width. We mock both so attachChartHover can pick
 * the nearest data index from a mousemove event.
 */

const path = require('path');

const MOD_PATH = path.join(__dirname, '..', 'app-chart-interactions.js');

function loadMod() {
  delete require.cache[require.resolve(MOD_PATH)];
  return require(MOD_PATH);
}

// Minimal CustomEvent shim if not present
if (typeof global.CustomEvent !== 'function') {
  global.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
}

// Fake DOM node with classList + listener storage. Just enough surface to
// drive the helper without pulling in jsdom for these focused unit tests.
function fakeEl({ classes = [], dataset = {}, parent = null } = {}) {
  const _classes = new Set(classes);
  const listeners = {};
  const el = {
    classList: {
      add: c => _classes.add(c),
      remove: c => _classes.delete(c),
      toggle: c => { _classes.has(c) ? _classes.delete(c) : _classes.add(c); },
      contains: c => _classes.has(c),
      _set: _classes,
    },
    getAttribute: k => dataset[k] != null ? String(dataset[k]) : null,
    style: {},
    parentNode: parent,
    addEventListener: (type, fn) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    fire: (type, ev = {}) => {
      (listeners[type] || []).forEach(fn => fn(ev));
    },
    _listeners: listeners,
  };
  return el;
}

describe('dispatchFilter / onFilterChange', () => {
  // Use the real jsdom document. Track listeners so we can detach in afterEach
  const tracked = [];
  afterEach(() => {
    while (tracked.length) {
      const fn = tracked.pop();
      document.removeEventListener('chart-filter', fn);
    }
  });

  test('dispatchFilter sends a chart-filter event with the payload', () => {
    const { dispatchFilter } = loadMod();
    const received = [];
    const fn = ev => received.push(ev.detail);
    document.addEventListener('chart-filter', fn);
    tracked.push(fn);
    dispatchFilter({ key: 'tier', value: 'gold' });
    expect(received).toEqual([{ key: 'tier', value: 'gold' }]);
  });

  test('onFilterChange registers a listener that receives the payload', () => {
    const { dispatchFilter, onFilterChange } = loadMod();
    const received = [];
    // onFilterChange wraps the document.addEventListener so we cant detach
    // it cleanly via tracked[], but the helper unwraps the CustomEvent for us
    onFilterChange(p => received.push(p));
    dispatchFilter(null);
    expect(received).toEqual([null]);
  });
});

describe('attachClickToFilter', () => {
  // Listen on the real jsdom document for chart-filter events. Easier than
  // trying to swap document.dispatchEvent which jsdom owns
  let dispatched;
  let listener;
  beforeEach(() => {
    dispatched = [];
    listener = ev => { dispatched.push(ev.detail); };
    document.addEventListener('chart-filter', listener);
  });
  afterEach(() => {
    document.removeEventListener('chart-filter', listener);
  });

  test('clicking a chip dispatches the payload and toggles active class', () => {
    const { attachClickToFilter } = loadMod();
    const chipA = fakeEl({ dataset: { 'data-tier': 'gold' } });
    const chipB = fakeEl({ dataset: { 'data-tier': 'platinum' } });
    const all = [chipA, chipB];
    const root = {
      querySelectorAll: sel => sel.includes('.is-active')
        ? all.filter(c => c.classList.contains('is-active'))
        : all,
    };
    attachClickToFilter({
      root,
      selector: '.chip',
      getFilter: el => ({ key: 'tier', value: el.getAttribute('data-tier') }),
    });

    chipA.fire('click');
    expect(chipA.classList.contains('is-active')).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({ key: 'tier', value: 'gold' });

    chipA.fire('click');
    expect(chipA.classList.contains('is-active')).toBe(false);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]).toBeNull();
  });

  test('clicking a second chip clears the first', () => {
    const { attachClickToFilter } = loadMod();
    const chipA = fakeEl({ classes: ['is-active'], dataset: { 'data-tier': 'gold' } });
    const chipB = fakeEl({ dataset: { 'data-tier': 'platinum' } });
    const all = [chipA, chipB];
    const root = {
      querySelectorAll: sel => sel.includes('.is-active')
        ? all.filter(c => c.classList.contains('is-active'))
        : all,
    };
    attachClickToFilter({
      root,
      selector: '.chip',
      getFilter: el => ({ key: 'tier', value: el.getAttribute('data-tier') }),
    });

    chipB.fire('click');
    expect(chipA.classList.contains('is-active')).toBe(false);
    expect(chipB.classList.contains('is-active')).toBe(true);
    expect(dispatched[0]).toEqual({ key: 'tier', value: 'platinum' });
  });

  test('cursor style is set to pointer for clickability hint', () => {
    const { attachClickToFilter } = loadMod();
    const chip = fakeEl({ dataset: { 'data-tier': 'gold' } });
    const root = { querySelectorAll: () => [chip] };
    attachClickToFilter({
      root,
      selector: '.chip',
      getFilter: () => ({ key: 'tier', value: 'gold' }),
    });
    expect(chip.style.cursor).toBe('pointer');
  });
});

describe('attachChartHover (continuous tracking)', () => {
  // Build a minimal SVG with a .ci-hover-full target, guide line, dots,
  // and a tooltip in a host element. The helper finds elements via
  // querySelector and listens for mousemove on the full target
  function buildChart(data) {
    const host = document.createElement('div');
    host.style.position = 'relative';
    host.innerHTML = `
      <svg viewBox="0 0 1000 200">
        <line class="ci-hover-guide" id="guide"/>
        <circle class="ci-hover-dot" id="dot0"/>
        <rect class="ci-hover-target ci-hover-full" data-idx="0" x="0" y="0" width="1000" height="200"/>
      </svg>
      <div class="ci-tooltip" id="tip"></div>
    `;
    document.body.appendChild(host);
    const svg = host.querySelector('svg');
    // jsdom doesnt populate viewBox.baseVal correctly so stub it
    Object.defineProperty(svg, 'viewBox', {
      value: { baseVal: { width: 1000, height: 200 } },
      configurable: true,
    });
    // Mock getBoundingClientRect so the helper can map viewBox <-> screen
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 });
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 });
    const tooltip = host.querySelector('#tip');
    Object.defineProperty(tooltip, 'offsetWidth', { value: 100, configurable: true });
    return { host, svg, tooltip };
  }

  test('mousemove triggers showAt with the nearest data point', () => {
    const { attachChartHover } = loadMod();
    const { host, svg, tooltip } = buildChart();
    const data = [
      { label: 'A' },
      { label: 'B' },
      { label: 'C' },
    ];
    // x positions: 0=100, 1=500, 2=900
    const getX = i => 100 + i * 400;
    const renderTip = jest.fn(item => `<span>${item.label}</span>`);
    attachChartHover({
      svg, host, tooltip,
      guide: svg.querySelector('#guide'),
      dots: [svg.querySelector('#dot0')],
      data,
      getX,
      getYForDot: () => 50,
      renderTip,
    });

    const fullTarget = svg.querySelector('.ci-hover-full');
    expect(fullTarget).toBeTruthy();

    // Move cursor near data point 1 (x=500). Should snap to it
    const ev = new MouseEvent('mousemove', { clientX: 480, clientY: 50 });
    fullTarget.dispatchEvent(ev);

    expect(host.classList.contains('is-hovered')).toBe(true);
    expect(renderTip).toHaveBeenCalledWith(data[1], 1);
    expect(tooltip.innerHTML).toContain('B');
  });

  test('onClick callback fires with nearest data point on click', () => {
    const { attachChartHover } = loadMod();
    const { host, svg, tooltip } = buildChart();
    const data = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
    const getX = i => 100 + i * 400;
    const onClick = jest.fn();
    attachChartHover({
      svg, host, tooltip,
      guide: svg.querySelector('#guide'),
      dots: [svg.querySelector('#dot0')],
      data, getX, getYForDot: () => 50,
      renderTip: item => item.label,
      onClick,
    });
    const fullTarget = svg.querySelector('.ci-hover-full');
    // Click near data point 2 (x=900)
    const ev = new MouseEvent('click', { clientX: 870, clientY: 50 });
    fullTarget.dispatchEvent(ev);
    expect(onClick).toHaveBeenCalledWith(data[2], 2);
  });

  test('Y interpolation runs when atX is between two data points', () => {
    const { attachChartHover } = loadMod();
    const { host, svg, tooltip } = buildChart();
    const data = [{ label: 'A' }, { label: 'B' }];
    const getX = i => i * 500; // 0=0, 1=500
    const getYForDot = jest.fn((item, di) => di === 0 ? 100 : 50);
    attachChartHover({
      svg, host, tooltip,
      guide: svg.querySelector('#guide'),
      dots: [svg.querySelector('#dot0')],
      data, getX, getYForDot,
      renderTip: item => item.label,
    });
    const fullTarget = svg.querySelector('.ci-hover-full');
    // Move to x=250 — between point 0 (x=0) and point 1 (x=500)
    fullTarget.dispatchEvent(new MouseEvent('mousemove', { clientX: 250, clientY: 50 }));
    // getYForDot should be called for both points to interpolate
    expect(getYForDot).toHaveBeenCalled();
  });

  test('mouseleave clears is-hovered', () => {
    const { attachChartHover } = loadMod();
    const { host, svg, tooltip } = buildChart();
    attachChartHover({
      svg, host, tooltip,
      data: [{}, {}, {}],
      getX: i => i * 100,
      getYForDot: () => 0,
      renderTip: () => '',
    });
    host.classList.add('is-hovered');
    const fullTarget = svg.querySelector('.ci-hover-full');
    fullTarget.dispatchEvent(new MouseEvent('mouseleave'));
    expect(host.classList.contains('is-hovered')).toBe(false);
  });

  test('falls back to discrete rects when no .ci-hover-full present', () => {
    const { attachChartHover } = loadMod();
    const host = document.createElement('div');
    host.innerHTML = `
      <svg viewBox="0 0 1000 200">
        <rect class="ci-hover-target" data-idx="0"/>
        <rect class="ci-hover-target" data-idx="1"/>
      </svg>
      <div class="ci-tooltip"></div>
    `;
    document.body.appendChild(host);
    const svg = host.querySelector('svg');
    Object.defineProperty(svg, 'viewBox', {
      value: { baseVal: { width: 1000, height: 200 } },
      configurable: true,
    });
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 });
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 });
    const tooltip = host.querySelector('.ci-tooltip');
    Object.defineProperty(tooltip, 'offsetWidth', { value: 100, configurable: true });

    const data = [{ id: 0 }, { id: 1 }];
    const renderTip = jest.fn(item => `${item.id}`);
    attachChartHover({
      svg, host, tooltip,
      data, getX: i => i * 100, getYForDot: () => 0, renderTip,
    });

    // Trigger mouseenter on the second rect
    const rects = svg.querySelectorAll('.ci-hover-target');
    rects[1].dispatchEvent(new MouseEvent('mouseenter'));
    expect(renderTip).toHaveBeenCalledWith(data[1], 1);
  });

  test('discrete rect mouseleave clears is-hovered', () => {
    const { attachChartHover } = loadMod();
    const host = document.createElement('div');
    host.innerHTML = `
      <svg viewBox="0 0 1000 200">
        <rect class="ci-hover-target" data-idx="0"/>
      </svg>
      <div class="ci-tooltip"></div>
    `;
    document.body.appendChild(host);
    const svg = host.querySelector('svg');
    Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 1000, height: 200 } }, configurable: true });
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 });
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 });
    const tooltip = host.querySelector('.ci-tooltip');
    Object.defineProperty(tooltip, 'offsetWidth', { value: 100, configurable: true });

    attachChartHover({
      svg, host, tooltip,
      data: [{ id: 0 }], getX: () => 0, getYForDot: () => 0, renderTip: () => '',
    });

    host.classList.add('is-hovered');
    const rect = svg.querySelector('.ci-hover-target');
    rect.dispatchEvent(new MouseEvent('mouseleave'));
    expect(host.classList.contains('is-hovered')).toBe(false);
  });

  test('discrete rect onClick fires with the correct data point', () => {
    const { attachChartHover } = loadMod();
    const host = document.createElement('div');
    host.innerHTML = `
      <svg viewBox="0 0 1000 200">
        <rect class="ci-hover-target" data-idx="0"/>
        <rect class="ci-hover-target" data-idx="1"/>
      </svg>
      <div class="ci-tooltip"></div>
    `;
    document.body.appendChild(host);
    const svg = host.querySelector('svg');
    Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 1000, height: 200 } }, configurable: true });
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 });
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 });
    const tooltip = host.querySelector('.ci-tooltip');
    Object.defineProperty(tooltip, 'offsetWidth', { value: 100, configurable: true });

    const data = [{ id: 0 }, { id: 1 }];
    const onClick = jest.fn();
    attachChartHover({
      svg, host, tooltip,
      data, getX: i => i * 500, getYForDot: () => 0,
      renderTip: item => `${item.id}`,
      onClick,
    });

    const rects = svg.querySelectorAll('.ci-hover-target');
    rects[1].dispatchEvent(new MouseEvent('click'));
    expect(onClick).toHaveBeenCalledWith(data[1], 1);
  });
});
