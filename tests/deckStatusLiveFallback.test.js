/**
 * Deck verdict on-demand fallback.
 *
 * The published deck-status.json only covers what the pipeline has fetched.
 * It shipped 16 entries for a 32k-row Steam catalog after #474 zeroed the
 * report counts the scope keyed off, so Counter-Strike 2 rendered "Valve has
 * not evaluated this title yet" while the store page said Playable. Every
 * catalog stub has a game page, so a page with no map entry now asks upstream
 * instead of asserting a verdict.
 */

const fs = require('fs');
const path = require('path');

// Required directly rather than loaded through vm: js/app/api/deck-status.js is
// in collectCoverageFrom, and a vm-evaluated copy is invisible to Jest's
// instrumentation -- adding code this way silently drops global coverage.
// jest.config.js maps away the ?v= suffix so the ESM import resolves.
function loadModule() {
  jest.resetModules();               // _deckCache / _deckMap are module state
  return require('../js/app/api/deck-status.js');
}

function mockFetch({ map = {}, live = null, mapFails = false, liveFails = false, liveStatus = 200 }) {
  const calls = [];
  global.fetch = jest.fn(async (url) => {
    calls.push(String(url));
    if (String(url).includes('steam-explore')) {
      if (liveFails) throw new Error('network down');
      if (liveStatus !== 200) return { ok: false, status: liveStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { results: live } }) };
    }
    if (mapFails) throw new Error('map 500');
    return { ok: true, json: async () => map };
  });
  return calls;
}

afterEach(() => { delete global.fetch; });

const CS2_RESULTS = {
  appid: 730,
  resolved_category: 2,
  resolved_items: [
    { display_type: 3, loc_token: '#SteamDeckVerified_TestResult_ControllerGlyphsDoNotMatchDeckDevice' },
    { display_type: 3, loc_token: '#SteamDeckVerified_TestResult_InterfaceTextIsNotLegible' },
    { display_type: 4, loc_token: '#SteamDeckVerified_TestResult_DefaultControllerConfigFullyFunctional' },
    { display_type: 4, loc_token: '#SteamDeckVerified_TestResult_DefaultConfigurationIsPerformant' },
  ],
  machine_resolved_category: 2,
  steamos_resolved_category: 3,
  machine_resolved_items: [{ display_type: 4, loc_token: '#SteamMachine_TestResult_Playable' }],
  steamos_resolved_items: [{ display_type: 4, loc_token: '#SteamOS_TestResult_Compatible' }],
};

function fetchFor({ map = {}, live = null, mapFails = false, liveFails = false, liveStatus = 200 }) {
  return async (url, opts) => {
    if (String(url).includes('steam-explore')) {
      if (liveFails) throw new Error('network down');
      if (liveStatus !== 200) return { ok: false, status: liveStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { results: live } }) };
    }
    if (mapFails) throw new Error('map 500');
    return { ok: true, json: async () => map };
  };
}

describe('published map hit', () => {
  test('uses the map and never calls upstream', async () => {
    const calls = mockFetch({ map: { 730: { status: 'verified', criteria: null } } });
    const mod = loadModule();
    const out = await mod.fetchDeckStatusForApp('730');
    expect(out.status).toBe('verified');
    expect(out.hasData).toBe(true);
    expect(calls.some((u) => u.includes('steam-explore'))).toBe(false);
  });
});

describe('map miss falls back to upstream', () => {
  test('parses a real CS2 payload into the same shape as the pipeline', async () => {
    mockFetch({ map: {}, live: CS2_RESULTS });
    const out = await loadModule().fetchDeckStatusForApp('730');
    expect(out.status).toBe('playable');
    expect(out.hasData).toBe(true);
    expect(out.machine).toBe('playable');
    // SteamOS category 3 collapses to 'compatible' -- Valve's modal only ever
    // shows Compatible as the positive verdict.
    expect(out.steamos).toBe('compatible');
    // display_type 3 = caveat (null), 4 = pass (true).
    expect(out.criteria).toEqual([null, null, true, true]);
    // Token prefixes are stripped to match the published map's compact form.
    expect(out.machine_criteria).toEqual([[4, 'Playable']]);
    expect(out.steamos_criteria).toEqual([[4, 'Compatible']]);
  });

  test('a genuine no-verdict from Valve is recorded as data, not a gap', async () => {
    // All categories 0 means Valve really has not rated it. That is an answer.
    mockFetch({ map: {}, live: { resolved_category: 0, machine_resolved_category: 0, steamos_resolved_category: 0 } });
    const out = await loadModule().fetchDeckStatusForApp('999');
    expect(out.status).toBe('unknown');
    expect(out.hasData).toBe(true);
  });

  test('fewer than four items yields null criteria rather than a short array', async () => {
    mockFetch({ map: {}, live: { resolved_category: 2, resolved_items: [{ display_type: 4 }] } });
    const out = await loadModule().fetchDeckStatusForApp('123');
    expect(out.criteria).toBeNull();
  });
});

describe('failures never fabricate a verdict', () => {
  test('upstream error leaves hasData false', async () => {
    mockFetch({ map: {}, liveFails: true });
    const out = await loadModule().fetchDeckStatusForApp('730');
    expect(out.status).toBe('unknown');
    expect(out.hasData).toBe(false);
  });

  test('non-2xx from the proxy leaves hasData false', async () => {
    mockFetch({ map: {}, liveStatus: 429 });
    const out = await loadModule().fetchDeckStatusForApp('730');
    expect(out.hasData).toBe(false);
  });

  test('non-numeric app ids skip the lookup entirely', async () => {
    const calls = mockFetch({ map: {} });
    const out = await loadModule().fetchDeckStatusForApp('gog:123');
    expect(out.hasData).toBe(false);
    expect(calls.some((u) => u.includes('steam-explore'))).toBe(false);
  });
});

describe('caching', () => {
  test('a second call for the same app does not refetch', async () => {
    const calls = mockFetch({ map: {}, live: CS2_RESULTS });
    const mod = loadModule();
    await mod.fetchDeckStatusForApp('730');
    await mod.fetchDeckStatusForApp('730');
    expect(calls.filter((u) => u.includes('steam-explore'))).toHaveLength(1);
  });
});

describe('parity with the pipeline', () => {
  test('the category maps match scripts/pipeline/deck_status.py', () => {
    const py = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pipeline', 'deck_status.py'), 'utf8');
    mockFetch({ map: {} });
    const mod = loadModule();
    // A drift here means the same game reads differently depending on whether
    // the pipeline happened to cover it.
    expect(py).toContain('DECK_CAT_MAP = {0: "unknown", 1: "unsupported", 2: "playable", 3: "verified"}');
    expect(mod.DECK_CAT_MAP).toEqual({ 0: 'unknown', 1: 'unsupported', 2: 'playable', 3: 'verified' });
    expect(py).toContain('STEAMOS_CAT_MAP = {0: "unknown", 1: "unsupported", 2: "compatible", 3: "compatible"}');
    expect(mod.STEAMOS_CAT_MAP).toEqual({ 0: 'unknown', 1: 'unsupported', 2: 'compatible', 3: 'compatible' });
  });
});
