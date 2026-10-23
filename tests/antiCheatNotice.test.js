/**
 * Behavioural tests for the #556 anti-cheat surfaces: the game-page notice
 * (antiCheatNotice + renderAntiCheatLine), the memoized loader + sync lookup
 * that cards read, and the card AC chip in renderGameCard.
 */
const { loadEsm } = require('./_esm-vm.js');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function loadLib(fetchImpl) {
  const logs = { debug: [], warn: [] };
  const ctx = loadEsm(['js/app/lib/anti-cheat.js'], {
    dataUrl: async (name) => name,
    esc,
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    console: {
      debug: (...a) => logs.debug.push(a),
      warn: (...a) => logs.warn.push(a),
    },
  });
  ctx.logs = logs;
  return ctx;
}

describe('antiCheatNotice', () => {
  const lib = loadLib();

  test.each([
    ['broken', 'broken', 'Blocked on Linux', /whatever the rating says/],
    ['denied', 'broken', 'Denied by the developer', /chose not to allow Linux/],
    ['supported', 'works', 'Supported on Linux', /should work/],
    ['running', 'works', 'Works, unofficially', /update can break it/],
    ['planned', 'unknown', 'Linux support planned', /may not work/],
  ])('%s gets its own wording', (status, tone, label, detail) => {
    const n = lib.antiCheatNotice({ status, vendors: ['Easy Anti-Cheat'] });
    expect(n.tone).toBe(tone);
    expect(n.label).toBe(label);
    expect(n.detail).toMatch(detail);
    expect(n.source).toBe('awacy');
    expect([...n.vendors]).toEqual(['Easy Anti-Cheat']);
  });

  test('vendor-only entry says there is no Linux verdict yet', () => {
    const n = lib.antiCheatNotice({ status: null, vendors: ['BattlEye'] });
    expect(n.tone).toBe('unknown');
    expect(n.label).toBe('Uses anti-cheat');
    expect(n.detail).toMatch(/no Linux verdict/);
    expect(n.source).toBe('steam');
  });

  test('no entry, or an entry with nothing in it, renders nothing', () => {
    expect(lib.antiCheatNotice(null)).toBeNull();
    expect(lib.antiCheatNotice({ status: null, vendors: [] })).toBeNull();
    expect(lib.antiCheatNotice({})).toBeNull();
  });

  test('an unknown upstream status with no vendors renders nothing', () => {
    expect(lib.antiCheatNotice({ status: 'mystery', vendors: null })).toBeNull();
  });
});

describe('renderAntiCheatLine', () => {
  const lib = loadLib();

  test('blocked game: tone class, label, vendors, rating disclaimer, AWACY source', () => {
    const html = lib.renderAntiCheatLine(lib.antiCheatNotice({ status: 'broken', vendors: ['BattlEye', 'EAC'] }));
    expect(html).toContain('grp-ac--broken');
    expect(html).toContain('Anti-cheat: <strong>Blocked on Linux</strong> (BattlEye, EAC)');
    expect(html).toContain('The rating covers how the game runs. Anti-cheat is a separate check.');
    expect(html).toContain('href="https://areweanticheatyet.com/"');
  });

  test('vendor-only cites the Steam store page, not AWACY', () => {
    const html = lib.renderAntiCheatLine(lib.antiCheatNotice({ status: null, vendors: ['nProtect'] }));
    expect(html).toContain('Detected from the Steam store page.');
    expect(html).not.toContain('areweanticheatyet.com');
  });

  test('no vendors leaves out the parenthesis', () => {
    const html = lib.renderAntiCheatLine(lib.antiCheatNotice({ status: 'supported', vendors: [] }));
    expect(html).toContain('<strong>Supported on Linux</strong></div>');
  });

  test('vendor names are escaped', () => {
    const html = lib.renderAntiCheatLine(lib.antiCheatNotice({ status: 'broken', vendors: ['<img onerror=x>'] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img onerror=x&gt;');
  });

  test('null notice renders an empty string so the slot stays hidden', () => {
    expect(lib.renderAntiCheatLine(null)).toBe('');
  });
});

describe('loadAntiCheatMap + antiCheatForAppSync', () => {
  test('sync lookup is null until the map loads, then returns the entry', async () => {
    const lib = loadLib(async () => ({ ok: true, json: async () => ({ 730: { status: 'denied', vendors: ['VAC'] } }) }));
    expect(lib.antiCheatForAppSync(730)).toBeNull();
    await lib.loadAntiCheatMap();
    expect(lib.antiCheatForAppSync(730).status).toBe('denied');
    expect(lib.antiCheatForAppSync('730').status).toBe('denied');
    expect(lib.antiCheatForAppSync(570)).toBeNull();
    expect(lib.antiCheatForAppSync(null)).toBeNull();
  });

  test('fetches once and memoizes', async () => {
    let calls = 0;
    const lib = loadLib(async () => { calls += 1; return { ok: true, json: async () => ({}) }; });
    await Promise.all([lib.loadAntiCheatMap(), lib.loadAntiCheatMap()]);
    await lib.loadAntiCheatMap();
    expect(calls).toBe(1);
  });

  test('non-ok response resolves to {} and logs the status', async () => {
    const lib = loadLib(async () => ({ ok: false, status: 404 }));
    const map = await lib.loadAntiCheatMap();
    expect(Object.keys(map)).toEqual([]);
    expect(lib.logs.debug[0][0]).toBe('[anti-cheat] no data');
    expect(lib.logs.debug[0][1].status).toBe(404);
  });

  test('network failure resolves to {} and warns with the error', async () => {
    const lib = loadLib(async () => { throw new Error('offline'); });
    const map = await lib.loadAntiCheatMap();
    expect(Object.keys(map)).toEqual([]);
    expect(lib.logs.warn[0][0]).toBe('[anti-cheat] load failed');
    expect(lib.logs.warn[0][1].error).toContain('offline');
  });

  test('an array payload is rejected as malformed', async () => {
    const lib = loadLib(async () => ({ ok: true, json: async () => [1, 2] }));
    expect(Object.keys(await lib.loadAntiCheatMap())).toEqual([]);
  });

  test('antiCheatBlocksLinux is true only for broken and denied', () => {
    const lib = loadLib();
    expect(lib.antiCheatBlocksLinux({ status: 'broken' })).toBe(true);
    expect(lib.antiCheatBlocksLinux({ status: 'denied' })).toBe(true);
    for (const status of ['supported', 'running', 'planned', null]) {
      expect(lib.antiCheatBlocksLinux({ status })).toBe(false);
    }
    expect(lib.antiCheatBlocksLinux(null)).toBe(false);
  });
});

describe('renderGameCard AC chip', () => {
  function loadCard(acMap) {
    const lib = loadLib();
    const ctx = loadEsm(['js/app/lib/card.js'], {
      STEAM_IMG: (id) => `https://img/${id}/header.jpg`,
      esc,
      _loadSteamImg: () => {},
      antiCheatForAppSync: (appId) => (acMap[String(appId)] || null),
      antiCheatBlocksLinux: lib.antiCheatBlocksLinux,
    });
    return ctx.renderGameCard;
  }
  const base = { href: '#/app/1', title: 'X', sub: '', tier: 'gold', storePill: 'Steam' };

  test('blocked game gets the chip in every store-badge variant, from the map', () => {
    const render = loadCard({ 578080: { status: 'broken', vendors: ['BattlEye'] } });
    const html = render({ ...base, appId: '578080', vr: 'supported' });
    // Rides next to the VR chip, so it must appear in exactly the same
    // badge variants (CSS shows one per the store-pill position pref).
    const vrCount = html.match(/class="game-card-vr-chip"/g).length;
    expect(html.match(/class="game-card-ac-chip"/g)).toHaveLength(vrCount);
    expect(html).toContain("Anti-cheat blocked on Linux. Online play probably won't work.");
  });

  test('denied game uses the denied tooltip', () => {
    const render = loadCard({ 359550: { status: 'denied', vendors: [] } });
    expect(render({ ...base, appId: '359550' })).toContain('Anti-cheat denied by the developer.');
  });

  test('supported, running and unknown games get no chip', () => {
    const render = loadCard({ 1: { status: 'supported' }, 2: { status: 'running' }, 3: { status: null, vendors: ['EAC'] } });
    for (const appId of ['1', '2', '3', '4']) {
      expect(render({ ...base, appId })).not.toContain('game-card-ac-chip');
    }
  });

  test('an explicit antiCheat entry overrides the map, and null suppresses it', () => {
    const render = loadCard({ 5: { status: 'broken' } });
    expect(render({ ...base, appId: '5', antiCheat: null })).not.toContain('game-card-ac-chip');
    expect(render({ ...base, appId: '6', antiCheat: { status: 'denied' } })).toContain('game-card-ac-chip');
  });

  test('the rating pill is unchanged by anti-cheat', () => {
    const render = loadCard({ 7: { status: 'broken' } });
    expect(render({ ...base, appId: '7' })).toContain('>GOLD<');
  });
});
