/**
 * Tests for js/app/utils.js -- pure helper functions.
 *
 * babel-jest transforms the ES module to CommonJS at test time so Jest can
 * require() it and Istanbul instruments the source file directly.
 */

global.window = global;
global.document = {
  createElement: () => {
    let _text = '';
    return {
      set textContent(v) { _text = v; },
      get innerHTML() {
        return _text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      },
    };
  },
};

const utils = require('../js/app/utils.js');

const {
  normalizeOs,
  latestPerApp,
  withTimeout,
  latestPerClient,
  fmtDuration,
  fmtMinutes,
  reportKey,
  daysAgo,
  utcStamp,
  confColor,
  confTextColor,
  truncate,
  esc,
  cfgNa,
  configKey,
  hashReportKey,
  NA_SPAN,
} = utils;

// ---------------------------------------------------------------------------
// normalizeOs
// ---------------------------------------------------------------------------

describe('normalizeOs', () => {
  test('returns empty string for null', () => {
    expect(normalizeOs(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(normalizeOs(undefined)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(normalizeOs('')).toBe('');
  });

  test('returns empty string for numeric-only string (raw build number)', () => {
    expect(normalizeOs('20240407')).toBe('');
    expect(normalizeOs('12345')).toBe('');
  });

  test('strips parenthetical suffix', () => {
    expect(normalizeOs('Ubuntu 22.04 (Jammy)')).toBe('Ubuntu 22.04');
  });

  test('strips LTS edition word', () => {
    expect(normalizeOs('Ubuntu 22.04 LTS')).toBe('Ubuntu 22.04');
  });

  test('strips Holo edition word', () => {
    expect(normalizeOs('SteamOS Holo')).toBe('SteamOS');
  });

  test('strips Core edition word', () => {
    expect(normalizeOs('Arch Linux Core')).toBe('Arch Linux');
  });

  test('strips Silverblue edition word', () => {
    expect(normalizeOs('Fedora Silverblue')).toBe('Fedora');
  });

  test('strips Kinoite edition word', () => {
    expect(normalizeOs('Fedora Kinoite')).toBe('Fedora');
  });

  test('strips Workstation edition word', () => {
    expect(normalizeOs('Fedora Workstation')).toBe('Fedora');
  });

  test('strips Server edition word', () => {
    expect(normalizeOs('Ubuntu Server')).toBe('Ubuntu');
  });

  test('strips Desktop edition word', () => {
    expect(normalizeOs('Manjaro Desktop')).toBe('Manjaro');
  });

  test('collapses long build version segment', () => {
    expect(normalizeOs('Fedora 44.20260407.n.0')).toBe('Fedora 44');
  });

  test('strips trailing patch number (24.04.3 -> 24.04)', () => {
    expect(normalizeOs('Ubuntu 24.04.3')).toBe('Ubuntu 24.04');
  });

  test('passes through normal version string unchanged', () => {
    expect(normalizeOs('Arch Linux')).toBe('Arch Linux');
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeOs('  SteamOS  ')).toBe('SteamOS');
  });
});

// ---------------------------------------------------------------------------
// latestPerApp
// ---------------------------------------------------------------------------

describe('latestPerApp', () => {
  test('returns empty array for empty input', () => {
    expect(latestPerApp([])).toEqual([]);
  });

  test('deduplicates by app_id keeping newest updated_at', () => {
    const rows = [
      { app_id: '730', updated_at: '2024-01-01' },
      { app_id: '730', updated_at: '2024-06-01' },
    ];
    const result = latestPerApp(rows);
    expect(result).toHaveLength(1);
    expect(result[0].updated_at).toBe('2024-06-01');
  });

  test('handles camelCase appId', () => {
    const rows = [
      { appId: '440', updated_at: '2024-01-01' },
      { appId: '440', updated_at: '2024-03-01' },
    ];
    const result = latestPerApp(rows);
    expect(result).toHaveLength(1);
    expect(result[0].updated_at).toBe('2024-03-01');
  });

  test('keeps distinct app_ids separate', () => {
    const rows = [
      { app_id: '730', updated_at: '2024-01-01' },
      { app_id: '440', updated_at: '2024-01-02' },
    ];
    expect(latestPerApp(rows)).toHaveLength(2);
  });

  test('falls back to created_at when updated_at missing', () => {
    const rows = [
      { app_id: '1', created_at: '2024-01-01' },
      { app_id: '1', created_at: '2024-06-01' },
    ];
    const result = latestPerApp(rows);
    expect(result[0].created_at).toBe('2024-06-01');
  });

  test('skips rows with no app id', () => {
    const rows = [
      { app_id: '', updated_at: '2024-01-01' },
      { updated_at: '2024-01-01' },
    ];
    expect(latestPerApp(rows)).toHaveLength(0);
  });

  test('single row returns that row', () => {
    const rows = [{ app_id: '1', updated_at: '2024-01-01', title: 'Game' }];
    expect(latestPerApp(rows)).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// latestPerClient
// ---------------------------------------------------------------------------

describe('latestPerClient', () => {
  test('returns empty array for empty input', () => {
    expect(latestPerClient([])).toEqual([]);
  });

  test('deduplicates by voter_id keeping newest', () => {
    const rows = [
      { voter_id: 'v1', updated_at: '2024-01-01' },
      { voter_id: 'v1', updated_at: '2024-06-01' },
    ];
    const result = latestPerClient(rows);
    expect(result).toHaveLength(1);
    expect(result[0].updated_at).toBe('2024-06-01');
  });

  test('deduplicates by config.clientId', () => {
    const rows = [
      { config: { clientId: 'cid1' }, updated_at: '2024-01-01' },
      { config: { clientId: 'cid1' }, updated_at: '2024-05-01' },
    ];
    const result = latestPerClient(rows);
    expect(result).toHaveLength(1);
    expect(result[0].updated_at).toBe('2024-05-01');
  });

  test('rows without stable id are not collapsed together', () => {
    const rows = [
      { updated_at: '2024-01-01' },
      { updated_at: '2024-02-01' },
    ];
    // Each should be kept separately (random key)
    const result = latestPerClient(rows);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe('withTimeout', () => {
  test('resolves with promise value when promise wins', async () => {
    const p = Promise.resolve(42);
    const result = await withTimeout(p, 1000, 'fallback');
    expect(result).toBe(42);
  });

  test('resolves with fallback when timeout fires first', async () => {
    const neverResolves = new Promise(() => {});
    const result = await withTimeout(neverResolves, 10, 'timed-out');
    expect(result).toBe('timed-out');
  });

  test('handles null fallback', async () => {
    const neverResolves = new Promise(() => {});
    const result = await withTimeout(neverResolves, 10, null);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fmtDuration
// ---------------------------------------------------------------------------

describe('fmtDuration', () => {
  test('underOneHour', () => {
    expect(fmtDuration('underOneHour')).toBe('< 1 hour');
  });

  test('oneToFourHours', () => {
    expect(fmtDuration('oneToFourHours')).toBe('1-4 hours');
  });

  test('fourToTenHours', () => {
    expect(fmtDuration('fourToTenHours')).toBe('4-10 hours');
  });

  test('overTenHours', () => {
    expect(fmtDuration('overTenHours')).toBe('10+ hours');
  });

  test('returns raw string for unknown value', () => {
    expect(fmtDuration('unknownValue')).toBe('unknownValue');
  });

  test('returns null for falsy input', () => {
    expect(fmtDuration(null)).toBeNull();
    expect(fmtDuration('')).toBeNull();
    expect(fmtDuration(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fmtMinutes
// ---------------------------------------------------------------------------

describe('fmtMinutes', () => {
  test('returns < 1 min for zero', () => {
    expect(fmtMinutes(0)).toBe('< 1 min');
  });

  test('returns < 1 min for null', () => {
    expect(fmtMinutes(null)).toBe('< 1 min');
  });

  test('returns minutes for values under 60', () => {
    expect(fmtMinutes(30)).toBe('30 min');
    expect(fmtMinutes(1)).toBe('1 min');
  });

  test('returns hours with 1 decimal for values under 600 minutes (10 hr)', () => {
    expect(fmtMinutes(90)).toBe('1.5 hr');
    expect(fmtMinutes(60)).toBe('1.0 hr');
  });

  test('returns rounded hours for >= 600 minutes', () => {
    expect(fmtMinutes(600)).toBe('10 hr');
    expect(fmtMinutes(660)).toBe('11 hr');
  });
});

// ---------------------------------------------------------------------------
// reportKey
// ---------------------------------------------------------------------------

describe('reportKey', () => {
  test('combines timestamp, gpu, and protonVersion', () => {
    const r = { timestamp: 1000, gpu: 'RX 6800 XT', protonVersion: 'Proton 9.0' };
    expect(reportKey(r)).toBe('1000:RX 6800 XT:Proton 9.0');
  });

  test('truncates gpu to 20 chars', () => {
    const r = { timestamp: 1, gpu: 'A'.repeat(30), protonVersion: '' };
    const key = reportKey(r);
    expect(key.split(':')[1]).toHaveLength(20);
  });

  test('truncates protonVersion to 15 chars', () => {
    const r = { timestamp: 1, gpu: '', protonVersion: 'B'.repeat(20) };
    const key = reportKey(r);
    expect(key.split(':')[2]).toHaveLength(15);
  });

  test('handles missing gpu and protonVersion', () => {
    const r = { timestamp: 999 };
    expect(reportKey(r)).toBe('999::');
  });
});

// ---------------------------------------------------------------------------
// daysAgo
// ---------------------------------------------------------------------------

describe('daysAgo', () => {
  test('returns today for a very recent timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(daysAgo(now)).toBe('today');
  });

  test('returns 1 day ago for ~1 day old', () => {
    const ts = Math.floor(Date.now() / 1000) - 86400;
    expect(daysAgo(ts)).toBe('1 day ago');
  });

  test('returns N days ago for older timestamps', () => {
    const ts = Math.floor(Date.now() / 1000) - 86400 * 5;
    expect(daysAgo(ts)).toBe('5 days ago');
  });
});

// ---------------------------------------------------------------------------
// utcStamp
// ---------------------------------------------------------------------------

describe('utcStamp', () => {
  test('formats a unix timestamp as YYYY-MM-DD HH:MM:SS UTC', () => {
    const result = utcStamp(0);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  });

  test('epoch 0 is 1970-01-01', () => {
    expect(utcStamp(0)).toContain('1970-01-01');
  });
});

// ---------------------------------------------------------------------------
// confColor
// ---------------------------------------------------------------------------

describe('confColor', () => {
  test('returns Steam cyan for score >= 8', () => {
    expect(confColor(8)).toBe('#66c0f4');
    expect(confColor(10)).toBe('#66c0f4');
  });

  test('returns mid cyan for score 6-7', () => {
    expect(confColor(6)).toBe('#4a90b8');
    expect(confColor(7)).toBe('#4a90b8');
  });

  test('returns muted dark cyan for score 4-5', () => {
    expect(confColor(4)).toBe('#3a6680');
    expect(confColor(5)).toBe('#3a6680');
  });

  test('returns slate grey for score < 4', () => {
    expect(confColor(3)).toBe('#4a5a6a');
    expect(confColor(0)).toBe('#4a5a6a');
  });
});

// ---------------------------------------------------------------------------
// confTextColor
// ---------------------------------------------------------------------------

describe('confTextColor', () => {
  test('returns dark text for score >= 7', () => {
    expect(confTextColor(7)).toBe('#0a1a24');
    expect(confTextColor(10)).toBe('#0a1a24');
  });

  test('returns light text for score < 7', () => {
    expect(confTextColor(6)).toBe('#e8f4ff');
    expect(confTextColor(0)).toBe('#e8f4ff');
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  test('returns string unchanged when under limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('truncates and appends ... when over limit', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  test('returns exact string at limit (no truncation)', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  test('handles null/undefined gracefully', () => {
    expect(truncate(null, 5)).toBeFalsy();
    expect(truncate(undefined, 5)).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// esc
// ---------------------------------------------------------------------------

describe('esc', () => {
  test('escapes < and >', () => {
    expect(esc('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
  });

  test('escapes & character', () => {
    expect(esc('a & b')).toBe('a &amp; b');
  });

  test('escapes double quote', () => {
    expect(esc('"quoted"')).toBe('&quot;quoted&quot;');
  });

  test('does not escape single quote (matches browser innerHTML behaviour)', () => {
    expect(esc("it's")).toBe("it's");
  });

  test('handles empty string', () => {
    expect(esc('')).toBe('');
  });

  test('handles null safely (falls back to empty string)', () => {
    expect(esc(null)).toBe('');
  });

  test('handles undefined safely', () => {
    expect(esc(undefined)).toBe('');
  });

  test('passes through safe text unchanged', () => {
    expect(esc('safe text 123')).toBe('safe text 123');
  });
});

// ---------------------------------------------------------------------------
// cfgNa
// ---------------------------------------------------------------------------

describe('cfgNa', () => {
  test('returns NA_SPAN for null', () => {
    expect(cfgNa(null)).toBe(NA_SPAN);
  });

  test('returns NA_SPAN for empty string', () => {
    expect(cfgNa('')).toBe(NA_SPAN);
  });

  test('returns the value when truthy', () => {
    expect(cfgNa('some value')).toBe('some value');
  });

  test('NA_SPAN contains Not available text', () => {
    expect(NA_SPAN).toContain('Not available');
  });
});

// ---------------------------------------------------------------------------
// configKey
// ---------------------------------------------------------------------------

describe('configKey', () => {
  test('prefers configId over clientId', () => {
    expect(configKey({ configId: 42, clientId: 'cid' })).toBe('cfg:42');
  });

  test('falls back to clientId when configId is null', () => {
    expect(configKey({ configId: null, clientId: 'abc' })).toBe('cfg:abc');
  });

  test('falls back to empty string when both are absent', () => {
    expect(configKey({})).toBe('cfg:');
  });

  test('uses configId=0 (falsy but not null/undefined)', () => {
    expect(configKey({ configId: 0 })).toBe('cfg:0');
  });
});

// ---------------------------------------------------------------------------
// hashReportKey
// ---------------------------------------------------------------------------

describe('hashReportKey', () => {
  test('returns a string starting with h', () => {
    expect(hashReportKey('test')).toMatch(/^h[0-9a-f]+$/);
  });

  test('is deterministic (same input -> same output)', () => {
    expect(hashReportKey('foo')).toBe(hashReportKey('foo'));
  });

  test('different inputs produce different hashes', () => {
    expect(hashReportKey('aaa')).not.toBe(hashReportKey('bbb'));
  });

  test('empty string returns a hash', () => {
    expect(hashReportKey('')).toMatch(/^h[0-9a-f]*$/);
  });
});
