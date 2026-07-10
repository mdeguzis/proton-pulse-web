/**
 * Behavioral tests for the Steam Machine hardware detection helper (#255).
 *
 * Deck detection is done by CPU/GPU signature (AMD Custom APU 0405/0932).
 * Steam Machine hardware signatures are not confirmed until reviewers get
 * devices in the wild, so Phase 1 falls back to the web-source hint from
 * the submit dropdown (`web-steammachine`). Phase 2 will fill in the real
 * APU regex once the launch hardware is out.
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

  test('report tagged with web-steammachine web source is detected', () => {
    const r = { webSource: 'web-steammachine' };
    expect(mod.isSteamMachineHardware(r)).toBe(true);
  });

  test('CPU field carrying "Steam Machine" text (from a future APU string) is detected', () => {
    const r = { cpu: 'AMD Steam Machine APU 0999', gpu: '' };
    expect(mod.isSteamMachineHardware(r)).toBe(true);
  });

  test('report from a plain PC does not match', () => {
    const r = { cpu: 'AMD Ryzen 7 7700', gpu: 'NVIDIA GeForce RTX 4070' };
    expect(mod.isSteamMachineHardware(r)).toBe(false);
  });

  test('Steam Deck LCD is not miscategorised as Steam Machine', () => {
    const r = { cpu: 'AMD Custom APU 0405', gpu: 'AMD Custom GPU 0405' };
    expect(mod.isSteamMachineHardware(r)).toBe(false);
  });

  test('empty / missing fields are safe (no false positive)', () => {
    expect(mod.isSteamMachineHardware({})).toBe(false);
    expect(mod.isSteamMachineHardware({ cpu: '', gpu: '' })).toBe(false);
  });

  test('detection is case-insensitive on either side of the token', () => {
    expect(mod.isSteamMachineHardware({ webSource: 'WEB-STEAMMACHINE' })).toBe(true);
    expect(mod.isSteamMachineHardware({ cpu: 'STEAM MACHINE proto rev A' })).toBe(true);
  });

  test('the existing Steam Deck detection still returns true for Deck signatures', () => {
    const lcd = { cpu: 'AMD Custom APU 0405', gpu: '' };
    const oled = { cpu: 'AMD Custom APU 0932', gpu: '' };
    expect(mod.isSteamDeckHardware(lcd)).toBe(true);
    expect(mod.isSteamDeckHardware(oled)).toBe(true);
    expect(mod.isSteamMachineHardware(lcd)).toBe(false);
  });
});
