/**
 * Behavioral tests for Steam Machine hardware detection (#255 Phase 2, #496).
 *
 * Detection is by CPU/GPU signature, same as the Deck (AMD Custom APU
 * 0405/0932). The Steam Machine fingerprint is still provisional -- the real
 * APU revision string is unknown until devices are in the wild -- so it
 * matches an explicit "Steam Machine" mention or the semi-custom RDNA 3
 * signature.
 *
 * #496: this previously tested a second regex that matched only the literal
 * words "steam machine", over a haystack including `r.webSource`. Nothing
 * ever set webSource (no column, no pipeline write, no submit dropdown), and
 * real APU strings do not contain those words, so the helper could not return
 * true for any real report -- while game-page.js and stats.py were already
 * matching RDNA 3. The old tests passed only because they hand-built an
 * object the production path never produces.
 */
const { loadEsm } = require('./_esm-vm.js');

function loadModule() {
  return loadEsm(['js/app/components/deck-status.js'], {
    dataUrl: () => '',
    console,
  });
}

describe('isSteamMachineHardware', () => {
  const mod = loadModule();

  test('detects the semi-custom RDNA 3 signature', () => {
    // The case that matters: what a real device is expected to report.
    expect(mod.isSteamMachineHardware({ cpu: '', gpu: 'AMD Custom GPU RDNA 3' })).toBe(true);
    expect(mod.isSteamMachineHardware({ cpu: 'AMD Custom APU with RDNA3 graphics', gpu: '' })).toBe(true);
  });

  test('detects an explicit Steam Machine mention in either field', () => {
    expect(mod.isSteamMachineHardware({ cpu: 'AMD Steam Machine APU 0999', gpu: '' })).toBe(true);
    expect(mod.isSteamMachineHardware({ cpu: '', gpu: 'STEAM MACHINE proto rev A' })).toBe(true);
  });

  test('report from a plain PC does not match', () => {
    const r = { cpu: 'AMD Ryzen 7 7700', gpu: 'NVIDIA GeForce RTX 4070' };
    expect(mod.isSteamMachineHardware(r)).toBe(false);
  });

  test('Steam Deck is not miscategorised as Steam Machine', () => {
    const lcd = { cpu: 'AMD Custom APU 0405', gpu: 'AMD Custom GPU 0405' };
    const oled = { cpu: 'AMD Custom APU 0932', gpu: '' };
    expect(mod.isSteamMachineHardware(lcd)).toBe(false);
    expect(mod.isSteamMachineHardware(oled)).toBe(false);
  });

  test('empty / missing fields are safe (no false positive)', () => {
    expect(mod.isSteamMachineHardware({})).toBe(false);
    expect(mod.isSteamMachineHardware({ cpu: '', gpu: '' })).toBe(false);
  });

  test('the existing Steam Deck detection still returns true for Deck signatures', () => {
    expect(mod.isSteamDeckHardware({ cpu: 'AMD Custom APU 0405', gpu: '' })).toBe(true);
    expect(mod.isSteamDeckHardware({ cpu: 'AMD Custom APU 0932', gpu: '' })).toBe(true);
  });

  test('no longer consults webSource, which nothing populates', () => {
    // Guard against re-adding a detection channel with no producer. If a
    // web-source dropdown is ever built (#255 Phase 1), wire the field end to
    // end before this helper reads it.
    expect(mod.isSteamMachineHardware({ webSource: 'web-steammachine' })).toBe(false);
    expect(mod._MACHINE_APU_RE).toBeUndefined();
  });
});

describe('the three surfaces agree (#496)', () => {
  const fs = require('fs');
  const mod = loadModule();

  test('game-page filters on the same regex the helper uses', () => {
    const src = fs.readFileSync(require.resolve('../js/app/components/game-page.js'), 'utf8');
    expect(src).toContain('_STEAM_MACHINE_RE.test(haystack)');
    const dsSrc = fs.readFileSync(require.resolve('../js/app/components/deck-status.js'), 'utf8');
    expect(dsSrc).toMatch(/isSteamMachineHardware[\s\S]{0,160}_STEAM_MACHINE_RE\.test/);
  });

  test('the JS regex still mirrors _STEAM_MACHINE in stats.py', () => {
    // The comment says "keep in sync"; this makes that enforceable rather
    // than aspirational. Compares the pattern source, normalising for the
    // escaping difference between a JS literal and a Python raw string.
    const py = fs.readFileSync(require.resolve('../scripts/pipeline/stats.py'), 'utf8');
    const m = py.match(/_STEAM_MACHINE\s*=\s*re\.compile\(\s*r"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(mod._STEAM_MACHINE_RE.source);
  });

  test('both sides agree on the same sample hardware strings', () => {
    // Behavioural parity, not just textual: these are the strings the pipeline
    // classifies as steam-machine, so the badge must agree.
    for (const s of ['AMD Custom GPU RDNA 3', 'Steam Machine dev kit']) {
      expect(mod.isSteamMachineHardware({ cpu: s, gpu: '' })).toBe(true);
    }
    for (const s of ['AMD Custom APU 0405', 'Intel Core i7-13700K']) {
      expect(mod.isSteamMachineHardware({ cpu: s, gpu: '' })).toBe(false);
    }
  });
});
