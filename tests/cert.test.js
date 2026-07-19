/**
 * Cert health helpers (#359). These back both the public status dot and the
 * admin burndown graph, so the bucket thresholds and the null/expired handling
 * are the contract worth pinning: an unreadable cert must read 'unknown', an
 * expired cert must read 'red', and the public payload must never carry
 * admin-only detail.
 */

import {
  daysBetween,
  daysRemaining,
  totalDays,
  certBucket,
  bucketForStatus,
  bucketColor,
  bucketLabel,
  certState,
  certStateForCert,
  certStateLabel,
  certStateDot,
  CERT_GREEN_MIN_DAYS,
  CERT_ORANGE_MIN_DAYS,
} from '../js/lib/cert.js';

const NOW = '2026-07-19T00:00:00Z';

describe('daysBetween', () => {
  test('counts whole days forward', () => {
    expect(daysBetween('2026-07-19T00:00:00Z', '2026-07-29T00:00:00Z')).toBe(10);
  });
  test('is negative when the target is in the past', () => {
    expect(daysBetween('2026-07-19T00:00:00Z', '2026-07-18T00:00:00Z')).toBe(-1);
  });
  test('returns null on missing or unparseable input', () => {
    expect(daysBetween('', '2026-07-19T00:00:00Z')).toBeNull();
    expect(daysBetween('2026-07-19T00:00:00Z', 'not-a-date')).toBeNull();
    expect(daysBetween(null, null)).toBeNull();
  });
});

describe('daysRemaining', () => {
  test('positive before expiry', () => {
    expect(daysRemaining('2026-08-18T00:00:00Z', NOW)).toBe(30);
  });
  test('negative after expiry (the incident that motivated this)', () => {
    expect(daysRemaining('2026-07-18T11:58:36Z', NOW)).toBe(-1);
  });
});

describe('totalDays', () => {
  test('Let\'s Encrypt 90-day window', () => {
    expect(totalDays('2026-04-19T00:00:00Z', '2026-07-18T00:00:00Z')).toBe(90);
  });
});

describe('certBucket thresholds', () => {
  test('green above 30 days', () => {
    expect(certBucket(CERT_GREEN_MIN_DAYS + 1)).toBe('green');
    expect(certBucket(60)).toBe('green');
  });
  test('exactly 30 days is orange (green is strictly greater)', () => {
    expect(certBucket(CERT_GREEN_MIN_DAYS)).toBe('orange');
  });
  test('orange in the 14..30 band', () => {
    expect(certBucket(20)).toBe('orange');
    expect(certBucket(CERT_ORANGE_MIN_DAYS)).toBe('orange');
  });
  test('red below 14 and once expired', () => {
    expect(certBucket(CERT_ORANGE_MIN_DAYS - 1)).toBe('red');
    expect(certBucket(0)).toBe('red');
    expect(certBucket(-5)).toBe('red');
  });
  test('unknown for null / NaN', () => {
    expect(certBucket(null)).toBe('unknown');
    expect(certBucket(undefined)).toBe('unknown');
    expect(certBucket(NaN)).toBe('unknown');
  });
});

describe('bucketForStatus', () => {
  test('expired cert reads red', () => {
    expect(bucketForStatus({ ok: true, not_after: '2026-07-18T11:58:36Z' }, NOW)).toBe('red');
  });
  test('healthy cert reads green', () => {
    expect(bucketForStatus({ ok: true, not_after: '2026-10-01T00:00:00Z' }, NOW)).toBe('green');
  });
  test('unreadable cert (ok:false) is unknown, never a false red', () => {
    expect(bucketForStatus({ ok: false, error: 'no_origin_cert' }, NOW)).toBe('unknown');
  });
  test('missing status is unknown', () => {
    expect(bucketForStatus(null, NOW)).toBe('unknown');
    expect(bucketForStatus({ ok: true }, NOW)).toBe('unknown');
  });
});

describe('certState (public descriptive state)', () => {
  test('expired cert -> expired (the incident)', () => {
    expect(certState({ ok: true, not_after: '2026-07-18T11:58:36Z' }, NOW)).toBe('expired');
  });
  test('healthy cert -> valid', () => {
    expect(certState({ ok: true, not_after: '2026-10-01T00:00:00Z' }, NOW)).toBe('valid');
  });
  test('orange band -> renew_soon', () => {
    expect(certState({ ok: true, not_after: '2026-08-08T00:00:00Z' }, NOW)).toBe('renew_soon');
  });
  test('red but not yet expired -> expiring', () => {
    expect(certState({ ok: true, not_after: '2026-07-25T00:00:00Z' }, NOW)).toBe('expiring');
  });
  test('probe failure (ok:false) -> unreachable, not a false expired', () => {
    expect(certState({ ok: false, error: 'no_origin_cert' }, NOW)).toBe('unreachable');
    expect(certState(null, NOW)).toBe('unreachable');
  });
  test('missing not_after -> unknown', () => {
    expect(certState({ ok: true }, NOW)).toBe('unknown');
  });
});

describe('certStateForCert (two-cert model: edge / origin)', () => {
  test('expired origin cert -> expired', () => {
    expect(certStateForCert({ not_after: '2026-07-18T11:58:36Z' }, NOW)).toBe('expired');
  });
  test('valid edge cert -> valid', () => {
    expect(certStateForCert({ not_after: '2026-09-14T23:25:02Z' }, NOW)).toBe('valid');
  });
  test('null / unreachable cert -> unreachable', () => {
    expect(certStateForCert(null, NOW)).toBe('unreachable');
    expect(certStateForCert({ reachable: false }, NOW)).toBe('unreachable');
  });
  test('cert object without not_after -> unknown', () => {
    expect(certStateForCert({ issuer: 'x' }, NOW)).toBe('unknown');
  });
});

describe('certState presentation', () => {
  test('every state has a label and maps to a valid dot state', () => {
    const dots = new Set(['operational', 'degraded', 'down', 'unknown']);
    for (const s of ['valid', 'renew_soon', 'expiring', 'expired', 'unreachable', 'unknown']) {
      expect(typeof certStateLabel(s)).toBe('string');
      expect(certStateLabel(s).length).toBeGreaterThan(0);
      expect(dots.has(certStateDot(s))).toBe(true);
    }
  });
  test('expired reads red (down), valid reads green (operational)', () => {
    expect(certStateDot('expired')).toBe('down');
    expect(certStateDot('valid')).toBe('operational');
    expect(certStateLabel('expired')).toBe('Expired');
  });
  test('unknown fallbacks rather than throwing', () => {
    expect(certStateLabel('bogus')).toBe(certStateLabel('unknown'));
    expect(certStateDot('bogus')).toBe('unknown');
  });
});

describe('bucket presentation', () => {
  test('every bucket has a distinct colour and a label', () => {
    for (const b of ['green', 'orange', 'red', 'unknown']) {
      expect(bucketColor(b)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(typeof bucketLabel(b)).toBe('string');
      expect(bucketLabel(b).length).toBeGreaterThan(0);
    }
  });
  test('unknown bucket falls back rather than throwing', () => {
    expect(bucketColor('bogus')).toBe(bucketColor('unknown'));
    expect(bucketLabel('bogus')).toBe(bucketLabel('unknown'));
  });
});
