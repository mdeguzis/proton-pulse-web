/**
 * Client-side gate that stops reports for OSes Proton cannot run on
 * (Windows / macOS / BSD / mobile) from being submitted. Blocklist
 * approach so any current or future Linux distro passes without a
 * schema edit.
 *
 * DB counterpart: supabase/migrations/*_user_configs_os_must_be_linux.sql
 * Both must stay in lockstep — if a pattern is added to one it must
 * land in the other.
 */

const { loadEsm } = require('./_esm-vm.js');

function loadSubmitModule() {
  return loadEsm(['js/shared/submit.js'], {
    console, JSON, Object, Array, Number, String, Boolean, Promise, Set, Map,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    // submit.js reads SUPABASE_URL / SUPABASE_ANON_KEY at module top-level
    // to compute SB_URL. Provide dummy values so the vm doesn't crash.
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    window: {
      SupaAuth: { getSession: async () => null },
      SB_URL: '', SB_KEY: '',
    },
    document: { getElementById: () => null, createElement: () => ({}) },
    localStorage: { getItem: () => null, setItem: () => {} },
    crypto: { randomUUID: () => 'test-uuid' },
  });
}

describe('isLinuxOs()', () => {
  const { isLinuxOs } = loadSubmitModule();

  describe('accepts Linux distros', () => {
    // Every entry in form-schema.json validOs must pass.
    test.each([
      'SteamOS', 'Ubuntu', 'Fedora', 'Arch Linux', 'Linux Mint',
      'Nobara', 'Pop!_OS', 'Manjaro', 'openSUSE Tumbleweed', 'Debian',
      'ChimeraOS', 'Bazzite', 'CachyOS', 'EndeavourOS', 'Garuda Linux',
      'NixOS',
    ])('%s passes', (os) => {
      expect(isLinuxOs(os)).toBe(true);
    });

    test('with version suffix still passes', () => {
      expect(isLinuxOs('Ubuntu 24.04')).toBe(true);
      expect(isLinuxOs('SteamOS 3.5')).toBe(true);
      expect(isLinuxOs('Fedora 41')).toBe(true);
    });

    test('less-common distros not in our dropdown still pass (blocklist not allowlist)', () => {
      // These aren't in validOs but Proton runs fine on them. The gate
      // must be permissive to any Linux distro so users on rolling or
      // niche distros can still submit.
      expect(isLinuxOs('Alpine Linux')).toBe(true);
      expect(isLinuxOs('Void Linux')).toBe(true);
      expect(isLinuxOs('Slackware 15')).toBe(true);
      expect(isLinuxOs('Solus')).toBe(true);
      expect(isLinuxOs('Kali Linux')).toBe(true);
      expect(isLinuxOs('openSUSE Leap 15')).toBe(true);
      expect(isLinuxOs('MyCustomDistro 1.0')).toBe(true);
    });

    test('empty or missing value passes (required-field UI catches it separately)', () => {
      expect(isLinuxOs('')).toBe(true);
      expect(isLinuxOs(null)).toBe(true);
      expect(isLinuxOs(undefined)).toBe(true);
    });
  });

  describe('rejects non-Linux OSes', () => {
    test.each([
      'Windows', 'Windows 10', 'Windows 11', 'Windows 7',
      'Win 10', 'Win10', 'Win11',
    ])('%s rejected (Windows family)', (os) => {
      expect(isLinuxOs(os)).toBe(false);
    });

    test.each([
      'macOS', 'macOS Sonoma', 'Mac OS', 'Mac OS X',
      'OS X', 'OSX', 'OSX 10.15',
      'Darwin', 'Darwin 23',
    ])('%s rejected (Apple family)', (os) => {
      expect(isLinuxOs(os)).toBe(false);
    });

    test.each([
      'FreeBSD', 'FreeBSD 14', 'OpenBSD', 'NetBSD', 'Dragonfly BSD',
    ])('%s rejected (BSD family)', (os) => {
      expect(isLinuxOs(os)).toBe(false);
    });

    test.each([
      'iOS', 'iOS 17', 'Android', 'Android 14',
    ])('%s rejected (mobile)', (os) => {
      expect(isLinuxOs(os)).toBe(false);
    });

    test('case-insensitive match rejects lowercase and uppercase variants', () => {
      expect(isLinuxOs('WINDOWS 11')).toBe(false);
      expect(isLinuxOs('windows')).toBe(false);
      expect(isLinuxOs('MAC OS X')).toBe(false);
      expect(isLinuxOs('android')).toBe(false);
    });
  });
});
