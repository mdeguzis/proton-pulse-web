/**
 * Unit tests for .github/scripts/backup.mjs pure helpers.
 * These run without network access or env vars -- all I/O stays in main().
 */
const {
  TABLE_ORDER_KEY,
  buildFetchUrl,
  hmac,
  sanitizeNotes,
  redactPaths,
  sanitizeUserConfig,
  sanitizeAuthorAvatar,
} = require('../.github/scripts/backup.mjs');

const SECRET = 'test-secret-key';

// ---------------------------------------------------------------------------
// TABLE_ORDER_KEY / buildFetchUrl
// ---------------------------------------------------------------------------

describe('buildFetchUrl', () => {
  test('uses id order key for tables with a normal PK', () => {
    const url = buildFetchUrl('https://example.supabase.co', 'user_configs', '*', '', 0, 1000);
    expect(url).toContain('order=id.asc');
  });

  test('uses proton_pulse_user_id order key for author_avatars', () => {
    const url = buildFetchUrl('https://example.supabase.co', 'author_avatars', '*', '', 0, 1000);
    expect(url).toContain('order=proton_pulse_user_id.asc');
    expect(url).not.toContain('order=id.asc');
  });

  test('encodes the select param', () => {
    const url = buildFetchUrl('https://example.supabase.co', 'user_configs', 'id,app_id', '', 0, 1000);
    expect(url).toContain('select=id%2Capp_id');
  });

  test('applies offset and limit', () => {
    const url = buildFetchUrl('https://example.supabase.co', 'user_configs', '*', '', 2000, 1000);
    expect(url).toContain('offset=2000');
    expect(url).toContain('limit=1000');
  });

  test('TABLE_ORDER_KEY covers all known tables that lack an id column', () => {
    expect(TABLE_ORDER_KEY).toHaveProperty('author_avatars', 'proton_pulse_user_id');
  });
});

// ---------------------------------------------------------------------------
// hmac
// ---------------------------------------------------------------------------

describe('hmac', () => {
  test('returns null for falsy values', () => {
    expect(hmac(null, SECRET)).toBeNull();
    expect(hmac('', SECRET)).toBeNull();
    expect(hmac(undefined, SECRET)).toBeNull();
  });

  test('returns a hex string for a real value', () => {
    const result = hmac('76561198000000001', SECRET);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test('same input + same secret = same hash (deterministic)', () => {
    expect(hmac('abc', SECRET)).toBe(hmac('abc', SECRET));
  });

  test('different secrets produce different hashes', () => {
    expect(hmac('abc', 'secret-a')).not.toBe(hmac('abc', 'secret-b'));
  });
});

// ---------------------------------------------------------------------------
// sanitizeNotes
// ---------------------------------------------------------------------------

describe('sanitizeNotes', () => {
  test('redacts email addresses', () => {
    expect(sanitizeNotes('contact me at user@example.com please')).toContain('[email redacted]');
    expect(sanitizeNotes('contact me at user@example.com please')).not.toContain('user@example.com');
  });

  test('redacts http and https URLs', () => {
    expect(sanitizeNotes('see https://evil.com/steal')).toContain('[url redacted]');
    expect(sanitizeNotes('see http://leak.io/path')).toContain('[url redacted]');
  });

  test('redacts Steam IDs (17-digit format starting with 7656119)', () => {
    expect(sanitizeNotes('steam id is 76561198123456789')).toContain('[steamid redacted]');
    expect(sanitizeNotes('steam id is 76561198123456789')).not.toContain('76561198123456789');
  });

  test('redacts Linux home paths', () => {
    expect(sanitizeNotes('/home/mike/games/game.exe')).toContain('/home/[redacted]');
  });

  test('redacts macOS Users paths', () => {
    expect(sanitizeNotes('/Users/mike/Library/stuff')).toContain('/Users/[redacted]');
  });

  test('redacts Windows user paths', () => {
    expect(sanitizeNotes('C:\\Users\\mike\\AppData')).toContain('C:\\Users\\[redacted]');
  });

  test('returns null/undefined unchanged', () => {
    expect(sanitizeNotes(null)).toBeNull();
    expect(sanitizeNotes(undefined)).toBeUndefined();
  });

  test('leaves clean text untouched', () => {
    const clean = 'Works great at high settings, no issues';
    expect(sanitizeNotes(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// redactPaths
// ---------------------------------------------------------------------------

describe('redactPaths', () => {
  test('redacts Linux /home paths', () => {
    expect(redactPaths('PROTON_LOG=/home/mike/proton.log')).toBe('PROTON_LOG=/home/[redacted]/proton.log');
  });

  test('redacts /Users paths', () => {
    expect(redactPaths('/Users/mike/game')).toBe('/Users/[redacted]/game');
  });

  test('does not redact /home/[redacted] (already clean)', () => {
    const already = '/home/[redacted]/game';
    expect(redactPaths(already)).toBe(already);
  });

  test('returns null/undefined unchanged', () => {
    expect(redactPaths(null)).toBeNull();
    expect(redactPaths(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sanitizeUserConfig
// ---------------------------------------------------------------------------

describe('sanitizeUserConfig', () => {
  const row = {
    id: 'uuid-1',
    app_id: 12345,
    title: 'Some Game',
    rating: 'gold',
    proton_version: 'Proton 9.0',
    launch_options: 'MANGOHUD=1 %command% /home/mike/script.sh',
    cpu: 'AMD Ryzen 7',
    gpu: 'RX 7900 XTX',
    gpu_driver: 'Mesa 24.1',
    gpu_vendor: 'amd',
    ram: '32 GB',
    vram_mb: 24576,
    os: 'Arch Linux',
    kernel: '6.9.0',
    notes: 'email me at test@example.com',
    form_responses: {},
    duration: '1-10h',
    duration_minutes: null,
    game_owned: true,
    config_key: 'key-abc',
    source: 'pulse',
    is_flagged: false,
    is_hidden: false,
    flagged_reason: 'wordlist:badword',
    flagged_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    proton_pulse_user_id: 'user-uuid-real',
    client_id: 'client-uuid-real',
  };

  let out;
  beforeAll(() => { out = sanitizeUserConfig(row, SECRET); });

  test('pseudonymizes proton_pulse_user_id', () => {
    expect(out.proton_pulse_user_id).not.toBe('user-uuid-real');
    expect(out.proton_pulse_user_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test('pseudonymizes client_id', () => {
    expect(out.client_id).not.toBe('client-uuid-real');
    expect(out.client_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test('redacts paths in launch_options', () => {
    expect(out.launch_options).toContain('/home/[redacted]');
    expect(out.launch_options).not.toContain('/home/mike');
  });

  test('redacts PII in notes', () => {
    expect(out.notes).toContain('[email redacted]');
    expect(out.notes).not.toContain('test@example.com');
  });

  test('strips matched term from flagged_reason, keeps category', () => {
    expect(out.flagged_reason).toBe('wordlist:redacted');
  });

  test('preserves safe fields unchanged', () => {
    expect(out.id).toBe('uuid-1');
    expect(out.app_id).toBe(12345);
    expect(out.rating).toBe('gold');
    expect(out.gpu_vendor).toBe('amd');
  });
});

// ---------------------------------------------------------------------------
// sanitizeAuthorAvatar
// ---------------------------------------------------------------------------

describe('sanitizeAuthorAvatar', () => {
  const row = {
    proton_pulse_user_id: 'user-uuid-real',
    display_name: 'CoolGamer42',
    avatar_url: 'https://cdn.steam.com/avatar/abc.jpg',
    cached_at: '2026-01-01T00:00:00Z',
    steam_id: '76561198123456789',
  };

  let out;
  beforeAll(() => { out = sanitizeAuthorAvatar(row, SECRET); });

  test('pseudonymizes proton_pulse_user_id', () => {
    expect(out.proton_pulse_user_id).not.toBe('user-uuid-real');
    expect(out.proton_pulse_user_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test('excludes steam_id (directly linkable PII)', () => {
    expect(out).not.toHaveProperty('steam_id');
  });

  test('preserves display_name, avatar_url, cached_at', () => {
    expect(out.display_name).toBe('CoolGamer42');
    expect(out.avatar_url).toBe('https://cdn.steam.com/avatar/abc.jpg');
    expect(out.cached_at).toBe('2026-01-01T00:00:00Z');
  });
});
