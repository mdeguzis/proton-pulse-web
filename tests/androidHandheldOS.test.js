/**
 * Behavioral tests for Android-origin handheld detection (#544).
 *
 * Retroid Pocket / AYN Odin / AyaNeo Pocket DS running Armada or Pocknix
 * (SteamOS-style Linux distros) instead of stock Android. Detection is
 * keyed on the os field rather than cpu/gpu like the Deck/Machine
 * detectors -- these devices use ordinary Qualcomm Snapdragon SoCs that
 * are not unique to gaming handhelds, so a hardware fingerprint would
 * false-positive on any ARM laptop or phone.
 */
const { loadEsm } = require('./_esm-vm.js');

function loadModule() {
  return loadEsm(['js/app/components/deck-status.js'], {
    dataUrl: () => '',
    console,
  });
}

describe('isAndroidHandheldOS', () => {
  const mod = loadModule();

  test('detects Armada', () => {
    expect(mod.isAndroidHandheldOS({ os: 'Armada' })).toBe(true);
  });

  test('detects Pocknix', () => {
    expect(mod.isAndroidHandheldOS({ os: 'Pocknix' })).toBe(true);
  });

  test('matches regardless of an appended version string', () => {
    expect(mod.isAndroidHandheldOS({ os: 'Armada 0.1.0' })).toBe(true);
    expect(mod.isAndroidHandheldOS({ os: 'Pocknix 0.2.0' })).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(mod.isAndroidHandheldOS({ os: 'ARMADA' })).toBe(true);
    expect(mod.isAndroidHandheldOS({ os: 'pocknix' })).toBe(true);
  });

  test('a desktop Linux distro does not match', () => {
    expect(mod.isAndroidHandheldOS({ os: 'Arch Linux' })).toBe(false);
    expect(mod.isAndroidHandheldOS({ os: 'Bazzite' })).toBe(false);
    expect(mod.isAndroidHandheldOS({ os: 'SteamOS 3.6' })).toBe(false);
  });

  test('empty / missing os is safe (no false positive)', () => {
    expect(mod.isAndroidHandheldOS({})).toBe(false);
    expect(mod.isAndroidHandheldOS({ os: '' })).toBe(false);
  });

  test('does not match a substring in the middle of another word', () => {
    // Anchored at the start -- "armada" appearing later in a free-text
    // os string (should never happen given the fixed dropdown, but the
    // regex itself should not be loose) must not match.
    expect(mod.isAndroidHandheldOS({ os: 'NotArmada Linux' })).toBe(false);
  });
});

describe('the two surfaces agree (#544)', () => {
  const fs = require('fs');
  const mod = loadModule();

  test('game-page filters on the same regex the helper uses', () => {
    const src = fs.readFileSync(require.resolve('../js/app/components/game-page.js'), 'utf8');
    expect(src).toContain('_ANDROID_HANDHELD_OS_RE.test(r.os');
    const dsSrc = fs.readFileSync(require.resolve('../js/app/components/deck-status.js'), 'utf8');
    expect(dsSrc).toMatch(/isAndroidHandheldOS[\s\S]{0,120}_ANDROID_HANDHELD_OS_RE\.test/);
  });

  test('desktop excludes Android handhelds, not just Deck/Machine', () => {
    const src = fs.readFileSync(require.resolve('../js/app/components/game-page.js'), 'utf8');
    expect(src).toMatch(/filterDevice === 'desktop'\)\s*return !isLcd && !isOled && !isMachine && !isAndroidHandheld/);
  });

  test('the JS regex still mirrors _ANDROID_HANDHELD_OS in stats.py', () => {
    const py = fs.readFileSync(require.resolve('../scripts/pipeline/stats.py'), 'utf8');
    const m = py.match(/_ANDROID_HANDHELD_OS\s*=\s*re\.compile\(\s*r"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(mod._ANDROID_HANDHELD_OS_RE.source);
  });
});
