/**
 * Field validation for user_systems writes (js/profile/utils.js). Mirrors the DB
 * CHECK constraints in 20260712170000_user_systems_field_validation.sql. These
 * guard the web write paths (system-edit add/edit, add-system modal) so a bad
 * field fails fast with a readable message instead of a raw Postgres error.
 *
 * profile/config.js reads window globals at module-load time, so seed them
 * before the require() below (same pattern as profileUtilsCoverage.test.js).
 */

global.window = global;
global.window.SUPABASE_URL = 'https://test.supabase.co';
global.window.SUPABASE_ANON_KEY = 'test-anon';
global.window.SupaAuth = {};
global.window.location = { host: 'localhost' };

const {
  validateSysinfoText, validateDeviceId, SYSINFO_MAX_LEN, DEVICE_ID_MAX_LEN,
} = require('../js/profile/utils.js');

describe('validateSysinfoText', () => {
  test('accepts a normal Steam system-info dump', () => {
    const s = 'CPU Brand: AMD Ryzen 7 5800X3D\nVideo Card: NVIDIA GeForce RTX 4070\nRAM: 32768 Mb';
    expect(validateSysinfoText(s)).toBeNull();
  });

  test('rejects empty text', () => {
    expect(validateSysinfoText('')).toMatch(/empty/i);
  });

  test('rejects non-string input', () => {
    expect(validateSysinfoText(null)).toMatch(/empty/i);
    expect(validateSysinfoText(undefined)).toMatch(/empty/i);
    expect(validateSysinfoText(12345)).toMatch(/empty/i);
  });

  test('rejects text over the length cap', () => {
    const tooLong = 'a'.repeat(SYSINFO_MAX_LEN + 1);
    expect(validateSysinfoText(tooLong)).toMatch(/too long/i);
  });

  test('accepts text exactly at the length cap', () => {
    expect(validateSysinfoText('a'.repeat(SYSINFO_MAX_LEN))).toBeNull();
  });

  test('allows tabs, newlines, and carriage returns', () => {
    expect(validateSysinfoText('CPU:\tAMD\r\nGPU:\tNVIDIA')).toBeNull();
  });

  test('rejects a NUL byte', () => {
    expect(validateSysinfoText('CPU: AMD\x00malicious')).toMatch(/control character/i);
  });

  test('rejects other control characters (0x1F, DEL)', () => {
    expect(validateSysinfoText('bad\x1Fdata')).toMatch(/control character/i);
    expect(validateSysinfoText('bad\x7Fdata')).toMatch(/control character/i);
  });
});

describe('validateDeviceId', () => {
  test('accepts a web-generated id', () => {
    expect(validateDeviceId('web-abc123def456')).toBeNull();
  });

  test('accepts a UUID-style id and an anon token', () => {
    expect(validateDeviceId('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
    expect(validateDeviceId('anon_0123456789abcdef0123456789abcdef')).toBeNull();
  });

  test('rejects empty and over-long ids', () => {
    expect(validateDeviceId('')).toMatch(/length/i);
    expect(validateDeviceId('x'.repeat(DEVICE_ID_MAX_LEN + 1))).toMatch(/length/i);
  });

  test('rejects ids with disallowed characters', () => {
    expect(validateDeviceId('device id with spaces')).toMatch(/character/i);
    expect(validateDeviceId('drop;table')).toMatch(/character/i);
    expect(validateDeviceId('emoji\u{1F4A5}')).toMatch(/character/i);
  });

  test('rejects non-string input', () => {
    expect(validateDeviceId(null)).toMatch(/length/i);
    expect(validateDeviceId(42)).toMatch(/length/i);
  });
});
