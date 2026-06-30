/**
 * Require-loaded coverage tests for js/profile/utils.js. The file is large
 * and was previously only exercised via the vm-based profileSystems suite,
 * which Istanbul does not instrument. These tests load the module through
 * babel-jest + the ?v= moduleNameMapper so coverage credit lands on the
 * source lines directly.
 *
 * profile/config.js reads window.SUPABASE_URL and friends at module-load
 * time, so we seed those before the first require. localStorage is also
 * touched by several helpers; a minimal in-memory shim keeps tests
 * deterministic.
 */

// Seed the window globals profile/config.js reads at module-load time.
// MUST happen before the require() below so the import chain resolves.
global.window = global;
global.window.SUPABASE_URL = 'https://test.supabase.co';
global.window.SUPABASE_ANON_KEY = 'test-anon';
global.window.SupaAuth = {};
global.window.location = { host: 'localhost' };

const _store = {};
beforeEach(() => {
  for (const k of Object.keys(_store)) delete _store[k];
  global.localStorage = {
    getItem: (k) => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
  };
  global.crypto = {
    randomUUID: () => 'test-uuid-' + Math.random().toString(16).slice(2, 10),
  };
});

const utils = require('../js/profile/utils.js');

describe('session readers', () => {
  test('getSteamIdFromSession prefers user_metadata.steam_id', () => {
    expect(utils.getSteamIdFromSession({
      user: { user_metadata: { steam_id: 'A', provider_id: 'B', sub: 'C' } },
    })).toBe('A');
  });
  test('getSteamIdFromSession falls back to provider_id then sub', () => {
    expect(utils.getSteamIdFromSession({ user: { user_metadata: { provider_id: 'B', sub: 'C' } } })).toBe('B');
    expect(utils.getSteamIdFromSession({ user: { user_metadata: { sub: 'C' } } })).toBe('C');
  });
  test('getSteamIdFromSession returns null when nothing matches', () => {
    expect(utils.getSteamIdFromSession(null)).toBeNull();
    expect(utils.getSteamIdFromSession({})).toBeNull();
    expect(utils.getSteamIdFromSession({ user: { user_metadata: {} } })).toBeNull();
  });
  test('getProtonPulseUserIdFromSession reads session.user.id', () => {
    expect(utils.getProtonPulseUserIdFromSession({ user: { id: 'pp-1' } })).toBe('pp-1');
    expect(utils.getProtonPulseUserIdFromSession(null)).toBeNull();
    expect(utils.getProtonPulseUserIdFromSession({})).toBeNull();
  });
});

describe('show-username preference', () => {
  test('defaults to true when nothing stored', () => {
    expect(utils.getShowUsername()).toBe(true);
  });
  test('returns true when "true" stored', () => {
    utils.setShowUsername(true);
    expect(utils.getShowUsername()).toBe(true);
  });
  test('returns false when "false" stored', () => {
    utils.setShowUsername(false);
    expect(utils.getShowUsername()).toBe(false);
  });
});

describe('cleanUnknown', () => {
  test('strips literal "unknown" (case-insensitive)', () => {
    expect(utils.cleanUnknown('Unknown')).toBe('');
    expect(utils.cleanUnknown('UNKNOWN')).toBe('');
    expect(utils.cleanUnknown('unknown')).toBe('');
  });
  test('returns trimmed value otherwise', () => {
    expect(utils.cleanUnknown('  Arch Linux  ')).toBe('Arch Linux');
  });
  test('non-string input returns empty', () => {
    expect(utils.cleanUnknown(null)).toBe('');
    expect(utils.cleanUnknown(undefined)).toBe('');
    expect(utils.cleanUnknown(42)).toBe('');
  });
});

describe('inferGpuVendor', () => {
  test('nvidia patterns', () => {
    expect(utils.inferGpuVendor('GeForce RTX 4070')).toBe('nvidia');
    expect(utils.inferGpuVendor('NVIDIA Quadro P2000')).toBe('nvidia');
  });
  test('amd patterns', () => {
    expect(utils.inferGpuVendor('Radeon RX 7800 XT')).toBe('amd');
    expect(utils.inferGpuVendor('AMD Vega 56')).toBe('amd');
  });
  test('intel patterns', () => {
    expect(utils.inferGpuVendor('Intel Arc A770')).toBe('intel');
    expect(utils.inferGpuVendor('Iris Xe Graphics')).toBe('intel');
  });
  test('unknown returns empty string', () => {
    expect(utils.inferGpuVendor('llvmpipe')).toBe('');
    expect(utils.inferGpuVendor('')).toBe('');
    expect(utils.inferGpuVendor(null)).toBe('');
  });
});

describe('inferCpuVendor', () => {
  test('amd patterns', () => {
    expect(utils.inferCpuVendor('AMD Ryzen 9 7950X')).toBe('amd');
    expect(utils.inferCpuVendor('Threadripper 7970X')).toBe('amd');
  });
  test('intel patterns', () => {
    expect(utils.inferCpuVendor('Intel Core i9-13900K')).toBe('intel');
    expect(utils.inferCpuVendor('Core Ultra 7 155H')).toBe('intel');
  });
  test('unknown -> other', () => {
    expect(utils.inferCpuVendor('SiFive HiFive Unmatched')).toBe('other');
  });
  test('empty input -> empty string', () => {
    expect(utils.inferCpuVendor('')).toBe('');
    expect(utils.inferCpuVendor(null)).toBe('');
  });
});

describe('isGenericSystemLabel', () => {
  test('placeholders return true', () => {
    expect(utils.isGenericSystemLabel('')).toBe(true);
    expect(utils.isGenericSystemLabel(' ')).toBe(true);
    expect(utils.isGenericSystemLabel(null)).toBe(true);
    expect(utils.isGenericSystemLabel('Unknown')).toBe(true);
    expect(utils.isGenericSystemLabel('unknown system')).toBe(true);
    expect(utils.isGenericSystemLabel('Unnamed')).toBe(true);
    expect(utils.isGenericSystemLabel('System')).toBe(true);
    expect(utils.isGenericSystemLabel('Uploaded system')).toBe(true);
  });
  test('real labels return false', () => {
    expect(utils.isGenericSystemLabel('My Steam Deck')).toBe(false);
    expect(utils.isGenericSystemLabel('Desktop')).toBe(false);
  });
});

describe('inferSystemLabel', () => {
  test('Steam Deck OLED via Valve/Galileo board match', () => {
    const sysinfo = 'Manufacturer: Valve\nModel: Galileo\nCPU Brand: AMD Custom APU 0932\n';
    expect(utils.inferSystemLabel({ sysinfo_text: sysinfo })).toBe('Steam Deck OLED');
  });
  test('Steam Deck LCD via Valve/Jupiter board match', () => {
    const sysinfo = 'Manufacturer: Valve\nModel: Jupiter\nCPU Brand: AMD Custom APU 0405\n';
    expect(utils.inferSystemLabel({ sysinfo_text: sysinfo })).toBe('Steam Deck LCD');
  });
  test('Steam Deck via VanGogh chipset hint (generic, no LCD/OLED)', () => {
    // Chipset hint alone cannot disambiguate LCD vs OLED -- only the
    // Jupiter/Galileo board model can. So chipset-only -> "Steam Deck".
    const sysinfo = 'CPU Brand: AMD Custom APU 0405\nVideo Card: VanGogh\n';
    expect(utils.inferSystemLabel({ sysinfo_text: sysinfo })).toBe('Steam Deck');
  });
  test('OS-VENDOR-GPU fallback when no Deck hints', () => {
    const parsed = { os: 'Arch', gpu: 'GeForce RTX 4070', gpuVendor: 'nvidia' };
    expect(utils.inferSystemLabel(parsed)).toBe('Arch-NVIDIA-GeForce RTX 4070');
  });
  test('Uploaded system when nothing parseable', () => {
    expect(utils.inferSystemLabel({})).toBe('Uploaded system');
  });
});

describe('summarizeSystem', () => {
  test('joins os + cpu + ram with bullet separators', () => {
    expect(utils.summarizeSystem({ os: 'Arch', cpu: 'Ryzen 9', ram: '32 GB' })).toBe('Arch \u2022 Ryzen 9 \u2022 32 GB');
  });
  test('falls back to gpu when cpu absent', () => {
    expect(utils.summarizeSystem({ os: 'Arch', gpu: 'RTX 4070', ram: '32 GB' })).toBe('Arch \u2022 RTX 4070 \u2022 32 GB');
  });
  test('placeholder when nothing present', () => {
    expect(utils.summarizeSystem({})).toBe('No parsed hardware summary available yet.');
  });
});

describe('hardware metadata localStorage helpers', () => {
  test('getMyHwSourceMeta returns null when unset', () => {
    expect(utils.getMyHwSourceMeta()).toBeNull();
  });
  test('setMyHwSourceMeta then read returns the object', () => {
    utils.setMyHwSourceMeta({ source: 'steam-paste', when: 1 });
    expect(utils.getMyHwSourceMeta()).toEqual({ source: 'steam-paste', when: 1 });
  });
  test('setMyHwSourceMeta(null) removes the key', () => {
    utils.setMyHwSourceMeta({ source: 'x' });
    utils.setMyHwSourceMeta(null);
    expect(utils.getMyHwSourceMeta()).toBeNull();
  });
  test('getMyHwSourceMeta tolerates corrupt JSON', () => {
    _store['proton-pulse:myhw:source-meta'] = '{not valid';
    expect(utils.getMyHwSourceMeta()).toBeNull();
  });
  test('field origins round-trip + per-field set', () => {
    expect(utils.getMyHwFieldOrigins()).toEqual({});
    utils.setMyHwFieldOrigins({ cpu: 'steam-paste' });
    expect(utils.getMyHwFieldOrigins()).toEqual({ cpu: 'steam-paste' });
    utils.setMyHwFieldOrigin('gpu', 'manual');
    expect(utils.getMyHwFieldOrigins()).toEqual({ cpu: 'steam-paste', gpu: 'manual' });
  });
});

describe('escapeHtml', () => {
  test('escapes the five HTML-unsafe chars', () => {
    expect(utils.escapeHtml(`<a href="x">'&y</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;y&lt;/a&gt;');
  });
  test('coerces non-string and handles falsy', () => {
    expect(utils.escapeHtml(null)).toBe('');
    expect(utils.escapeHtml(undefined)).toBe('');
    expect(utils.escapeHtml(42)).toBe('42');
  });
});

describe('formatSystemUpdated', () => {
  test('returns "-" for falsy input', () => {
    expect(utils.formatSystemUpdated('')).toBe('-');
    expect(utils.formatSystemUpdated(null)).toBe('-');
    expect(utils.formatSystemUpdated(undefined)).toBe('-');
  });
  test('valid ISO timestamp parses (any non-empty string)', () => {
    const out = utils.formatSystemUpdated('2026-06-30T12:00:00Z');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('-');
  });
  test('unparseable strings return the raw input', () => {
    expect(utils.formatSystemUpdated('not a date')).toBe('not a date');
  });
});

describe('getWebClientIdProfile', () => {
  test('generates a UUID on first call and persists it', () => {
    const first = utils.getWebClientIdProfile();
    expect(first).toMatch(/^test-uuid-/);
    const second = utils.getWebClientIdProfile();
    expect(second).toBe(first);
  });
});

describe('enabled vars text round-trip', () => {
  test('enabledVarsToText joins KEY=VALUE per line', () => {
    expect(utils.enabledVarsToText({ DXVK: '1', PROTON: 'experimental' })).toBe('DXVK=1\nPROTON=experimental');
  });
  test('null or non-object returns empty string', () => {
    expect(utils.enabledVarsToText(null)).toBe('');
    expect(utils.enabledVarsToText('not an object')).toBe('');
  });
  test('textToEnabledVars parses lines back, skipping malformed', () => {
    expect(utils.textToEnabledVars('A=1\nB=two\n\n=skipme\nbad-no-equals\nC=three')).toEqual({
      A: '1', B: 'two', C: 'three',
    });
  });
});

describe('getMyReportBadges', () => {
  test('cloud-only emits Synced badge with restore tooltip', () => {
    const out = utils.getMyReportBadges({ cloud: true, unpublished: true });
    expect(out[0].label).toBe('Synced');
    expect(out[0].tone).toBe('cloud');
    expect(out[0].title).toMatch(/cloud sync/i);
    expect(out[1].label).toBe('Unpublished');
  });
  test('published+cloud emits Synced + Published', () => {
    const out = utils.getMyReportBadges({ cloud: true, published: true });
    expect(out.map((b) => b.label)).toEqual(['Synced', 'Published']);
  });
  test('pending emits Synced + Pending in that order', () => {
    const out = utils.getMyReportBadges({ pending: true });
    expect(out.map((b) => b.label)).toEqual(['Synced', 'Pending']);
  });
  test('flagged badge always last', () => {
    const out = utils.getMyReportBadges({ published: true, flagged: true });
    expect(out[out.length - 1].label).toBe('Flagged');
  });
});

describe('flaggedMessageHtml', () => {
  test('null reason returns the generic message (no Discord link)', () => {
    const out = utils.flaggedMessageHtml(null);
    expect(out).toMatch(/flagged for review/);
    expect(out).not.toMatch(/discord/i);
  });
  test('wordlist reason names the field and links to Discord', () => {
    const out = utils.flaggedMessageHtml('wordlist:badword in notes');
    expect(out).toMatch(/flagged word/);
    expect(out).toMatch(/your notes/);
    expect(out).toMatch(/discord/i);
  });
  test('openai reason joins categories', () => {
    const out = utils.flaggedMessageHtml('openai:hate,self-harm/intent');
    expect(out).toMatch(/Content was flagged for: hate, self harm \/ intent/);
  });
  test('unknown reason still includes generic message + Discord link', () => {
    const out = utils.flaggedMessageHtml('admin:banned');
    expect(out).toMatch(/flagged for review/);
    expect(out).toMatch(/discord/i);
  });
});

describe('mergeMyReportRows', () => {
  test('collapses published + cloud rows on the same app_id', () => {
    const published = [{ id: 9, app_id: '730', title: 'CS2', rating: 'platinum', created_at: '2026-06-01T00:00:00Z' }];
    const cloud = [{ app_id: 730, app_name: 'CS2', updated_at: '2026-06-02T00:00:00Z', is_published: true }];
    const out = utils.mergeMyReportRows(published, cloud);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(expect.objectContaining({
      app_id: '730', cloud: true, published: true, unpublished: false,
    }));
  });
  test('cloud-only row is unpublished', () => {
    const out = utils.mergeMyReportRows([], [
      { app_id: '570', app_name: 'Dota 2', updated_at: '2026-06-30T00:00:00Z' },
    ]);
    expect(out[0]).toEqual(expect.objectContaining({
      cloud: true, published: false, unpublished: true,
    }));
  });
  test('sorted by updated_at descending', () => {
    const out = utils.mergeMyReportRows([
      { app_id: '1', title: 'A', updated_at: '2026-01-01T00:00:00Z' },
      { app_id: '2', title: 'B', updated_at: '2026-06-01T00:00:00Z' },
    ], []);
    expect(out.map((r) => r.app_id)).toEqual(['2', '1']);
  });
  test('flagged flag propagates from any contributing row', () => {
    const out = utils.mergeMyReportRows([
      { id: 1, app_id: '1', title: 'A', is_flagged: true, flagged_reason: 'wordlist:x in notes' },
    ], []);
    expect(out[0].flagged).toBe(true);
    expect(out[0].flagged_reason).toBe('wordlist:x in notes');
  });
  test('empty inputs return empty array', () => {
    expect(utils.mergeMyReportRows([], [])).toEqual([]);
    expect(utils.mergeMyReportRows(null, null)).toEqual([]);
  });
});

describe('getPluginLinkCodeFromLocation', () => {
  test('reads pluginLinkCode from search string', () => {
    expect(utils.getPluginLinkCodeFromLocation({ search: '?pluginLinkCode=ABC123', hash: '' })).toBe('ABC123');
  });
  test('falls back to query inside hash fragment', () => {
    expect(utils.getPluginLinkCodeFromLocation({ search: '', hash: '#/somewhere?pluginLinkCode=XYZ' })).toBe('XYZ');
  });
  test('returns null when absent', () => {
    expect(utils.getPluginLinkCodeFromLocation({ search: '', hash: '' })).toBeNull();
  });
});
