/**
 * @jest-environment jsdom
 *
 * Steam Frame compatibility (#594).
 *
 * Valve's compat endpoint returns frame_resolved_category / frame_resolved_items
 * next to the Machine and SteamOS fields, on the same 0-3 scale as Deck. These
 * run the real modules: the API layer (published map + live fallback), the
 * compatibility modal, and the library chart tally.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadApi() {
  jest.resetModules();
  return require('../js/app/api/deck-status.js');
}

function mockFetch({ map = {}, live = null }) {
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('steam-explore')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { results: live } }) };
    }
    return { ok: true, json: async () => map };
  });
}

afterEach(() => { delete global.fetch; });

// Cyberpunk 2077 (1091500) as Valve returned it on 2026-11-01.
const CYBERPUNK_LIVE = {
  resolved_category: 3,
  machine_resolved_category: 3,
  steamos_resolved_category: 2,
  frame_resolved_category: 2,
  frame_resolved_items: [
    { display_type: 3, loc_token: '#SteamFrame_TestResult_DefaultConfigurationIsNotPerformant' },
    { display_type: 4, loc_token: '#SteamFrame_TestResult_ControllerGlyphsMatchDevice' },
  ],
};

describe('API layer', () => {
  test('reads frame + frame_criteria from the published map', async () => {
    mockFetch({ map: { 620: { status: 'verified', frame: 'verified', frame_criteria: [[4, 'InterfaceTextIsLegible']] } } });
    const out = await loadApi().fetchDeckStatusForApp('620');
    expect(out.frame).toBe('verified');
    expect(out.frame_criteria).toEqual([[4, 'InterfaceTextIsLegible']]);
  });

  test('a map entry without frame reads unknown with no criteria', async () => {
    mockFetch({ map: { 413150: { status: 'verified', machine: 'verified' } } });
    const out = await loadApi().fetchDeckStatusForApp('413150');
    expect(out.frame).toBe('unknown');
    expect(out.frame_criteria).toEqual([]);
  });

  test('live fallback parses the Frame rating and strips the token prefix', async () => {
    mockFetch({ map: {}, live: CYBERPUNK_LIVE });
    const out = await loadApi().fetchDeckStatusForApp('1091500');
    expect(out.frame).toBe('playable');
    expect(out.frame_criteria).toEqual([
      [3, 'DefaultConfigurationIsNotPerformant'],
      [4, 'ControllerGlyphsMatchDevice'],
    ]);
  });

  test('null frame_resolved_category from Valve is unknown, not unsupported', async () => {
    mockFetch({ map: {}, live: { resolved_category: 3, frame_resolved_category: null } });
    const out = await loadApi().fetchDeckStatusForApp('1245620');
    expect(out.frame).toBe('unknown');
  });

  test('the sync default before any fetch carries frame fields', () => {
    const d = loadApi().getDeckStatusForApp('1');
    expect(d.frame).toBe('unknown');
    expect(d.frame_criteria).toEqual([]);
  });
});

describe('compatibility modal', () => {
  async function renderFor(appId, live) {
    jest.resetModules();
    mockFetch({ map: {}, live });
    const api = require('../js/app/api/deck-status.js');
    await api.fetchDeckStatusForApp(appId);
    const comp = require('../js/app/components/deck-status.js');
    return { html: comp.renderDeckStatusModalContent(appId), comp };
  }

  test('adds a Steam Frame tab and panel between Machine and SteamOS', async () => {
    const { html } = await renderFor('1091500', CYBERPUNK_LIVE);
    expect(html).toContain('id="dt-frame"');
    expect(html).toContain('for="dt-frame"');
    expect(html).toContain('href="#icon-steam-frame"');
    expect(html).toContain('class="dt-panel dt-panel-frame"');
    const order = ['dt-tab" title="Steam Machine', 'dt-tab" title="Steam Frame', 'dt-tab" title="SteamOS'].map(s => html.indexOf(s));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('Frame panel shows the verdict and Frame-worded criteria', async () => {
    const { html } = await renderFor('1091500', CYBERPUNK_LIVE);
    const panel = html.slice(html.indexOf('dt-panel-frame'), html.indexOf('dt-panel-steamos'));
    expect(panel).toContain('Steam Frame Compatibility:');
    expect(panel).toContain('deck-status-playable');
    expect(panel).toContain('is <strong>Playable</strong> on Steam Frame');
    expect(panel).toContain("default graphics configuration does not perform well on Steam Frame");
    expect(panel).toContain('This game shows Steam Frame controller icons');
    expect(panel).not.toContain('Steam Machine');
  });

  test('the Machine panel keeps Machine wording for the shared tokens', async () => {
    const { comp } = await renderFor('1', CYBERPUNK_LIVE);
    expect(comp._criterionLabel('ControllerGlyphsMatchDevice', 'machine')).toBe('This game shows Steam Machine controller icons');
    expect(comp._criterionLabel('ControllerGlyphsMatchDevice', 'frame')).toBe('This game shows Steam Frame controller icons');
    // Tokens without a Frame override fall through to the shared map.
    expect(comp._criterionLabel('InterfaceTextIsLegible', 'frame')).toBe('In-game interface text is legible');
  });

  test('an unrated Frame title says Valve has not evaluated it for Frame', async () => {
    const { html } = await renderFor('1245620', { resolved_category: 3, frame_resolved_category: null });
    const panel = html.slice(html.indexOf('dt-panel-frame'), html.indexOf('dt-panel-steamos'));
    expect(panel).toContain('deck-status-unknown');
    expect(panel).toContain('Valve has not evaluated this title for Steam Frame yet');
  });
});

describe('library chart', () => {
  function loadChart() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js/app/components/home-library-chart.js'), 'utf8')
      .replace(/^import\s.*$/gm, '')
      .replace(/^export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ');
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const ctx = vm.createContext({ console, esc });
    vm.runInContext(src + '\n;this.DEVICE = DEVICE; this._rowHref = _rowHref; this._renderChipsHtml = _renderChipsHtml;', ctx);
    return ctx;
  }

  test('tallies the frame field with missing entries as unknown', () => {
    const ctx = loadChart();
    const map = { 1: { frame: 'verified' }, 2: { frame: 'playable' }, 3: { status: 'verified' } };
    const c = ctx.computeDeviceStatusCounts(new Set([1, 2, 3]), map, ctx.DEVICE.frame.field, ctx.DEVICE.frame.order);
    expect(c).toEqual({ verified: 1, playable: 1, unsupported: 0, unknown: 1 });
  });

  test('Frame chip sits between Machine and SteamOS and rows deep-link with frame=', () => {
    const ctx = loadChart();
    const chips = ctx._renderChipsHtml('frame');
    const idx = ['data-view="machine"', 'data-view="frame"', 'data-view="steamos"'].map(s => chips.indexOf(s));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(chips).toMatch(/hlc-chip--active" data-view="frame"/);
    expect(ctx._rowHref('frame', 'verified')).toBe('app.html?filter=mine&frame=verified&view=frame');
  });
});

describe('home filter wiring', () => {
  const homeSrc = fs.readFileSync(path.join(__dirname, '..', 'js/app/components/home.js'), 'utf8');

  test('Frame chip group offers the Deck-style scale', () => {
    const start = homeSrc.indexOf('id="home-frame-checks"');
    const group = homeSrc.slice(start, homeSrc.indexOf('</div>', start));
    for (const v of ['all', 'verified', 'playable', 'unsupported', 'unknown']) {
      expect(group).toContain(`data-value="${v}"`);
    }
  });

  test('_filterByFrame filters on the frame field, inside both pipelines', () => {
    expect(homeSrc).toContain("_filterByDeviceField(reports, sel, deckStatusMap, 'frame')");
    expect((homeSrc.match(/_filterByFrame\(_filterBySteamOS\(/g) || []).length).toBe(2);
    expect((homeSrc.match(/, frameSel, deckStatusMap\)/g) || []).length).toBe(2);
  });

  test('frame selection is saved, restored, counted, cleared, and seeded from ?frame=', () => {
    expect(homeSrc).toContain('frame: [...frameSel]');
    expect(homeSrc).toContain('frameSel = new Set(saved.frame || [])');
    expect(homeSrc).toContain('_applyPillSelection(frameGroup, saved.frame)');
    expect(homeSrc).toContain('machineSel.size + frameSel.size');
    expect(homeSrc).toMatch(/machineGroup, frameGroup, steamosGroup/);
    expect(homeSrc).toMatch(/VALID_FRAME\s*=\s*new Set\(\['verified', 'playable', 'unsupported', 'unknown'\]\)/);
    expect(homeSrc).toContain('frameSel = new Set([_urlFrame]);');
    expect(homeSrc).toContain('_active(frameSel)');
  });
});
