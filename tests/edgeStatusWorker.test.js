/**
 * Unit tests for the pp-edge-status Cloudflare Worker (#275). Covers the pure
 * classification/aggregation/payload helpers plus the function list staying in
 * sync with the bash probe it replaces. Network handlers (scheduled/fetch) are
 * exercised only for shape, not driven, since they need the Workers runtime.
 */
import fs from 'fs';
import path from 'path';
import {
  FNS,
  STATUS_KEY,
  classifyStatus,
  aggregateOverall,
  buildPayload,
  mergeService,
} from '../workers/edge-status/index.js';

describe('classifyStatus', () => {
  test('2xx/204 are operational', () => {
    expect(classifyStatus(200)).toBe('operational');
    expect(classifyStatus(204)).toBe('operational');
  });

  test('401/403 are operational (reachable, auth-rejected preflight)', () => {
    expect(classifyStatus(401)).toBe('operational');
    expect(classifyStatus(403)).toBe('operational');
  });

  test('5xx is down', () => {
    expect(classifyStatus(500)).toBe('down');
    expect(classifyStatus(503)).toBe('down');
    expect(classifyStatus(599)).toBe('down');
  });

  test('0 / NaN (connection failure or timeout) is down', () => {
    expect(classifyStatus(0)).toBe('down');
    expect(classifyStatus('000')).toBe('down');
    expect(classifyStatus('nonsense')).toBe('down');
  });

  test('other codes are degraded', () => {
    expect(classifyStatus(302)).toBe('degraded');
    expect(classifyStatus(404)).toBe('degraded');
    expect(classifyStatus(418)).toBe('degraded');
  });
});

describe('aggregateOverall', () => {
  test('any down wins over degraded and operational', () => {
    expect(aggregateOverall([
      { status: 'operational' }, { status: 'degraded' }, { status: 'down' },
    ])).toBe('down');
  });

  test('degraded when no down but some degraded', () => {
    expect(aggregateOverall([
      { status: 'operational' }, { status: 'degraded' },
    ])).toBe('degraded');
  });

  test('operational when all operational', () => {
    expect(aggregateOverall([
      { status: 'operational' }, { status: 'operational' },
    ])).toBe('operational');
  });

  test('unknown for empty or non-array input', () => {
    expect(aggregateOverall([])).toBe('unknown');
    expect(aggregateOverall(null)).toBe('unknown');
  });
});

describe('buildPayload', () => {
  test('produces the edge-status.json shape the page reads', () => {
    const services = [
      { name: 'steam-news', status: 'operational', http_status: 204, latency_ms: 42, checked_at: 'x' },
    ];
    const payload = buildPayload(services, { now: 0, run_url: 'https://run' });
    expect(payload).toEqual({
      updated_at: '1970-01-01T00:00:00.000Z',
      overall: 'operational',
      run_url: 'https://run',
      services,
    });
  });

  test('overall reflects the worst service', () => {
    const payload = buildPayload([
      { status: 'operational' }, { status: 'down' },
    ]);
    expect(payload.overall).toBe('down');
  });

  test('run_url defaults to empty string', () => {
    expect(buildPayload([{ status: 'operational' }]).run_url).toBe('');
  });
});

describe('mergeService (admin "Check now" single-fn re-probe)', () => {
  const base = buildPayload([
    { name: 'steam-news', status: 'operational', http_status: 204, latency_ms: 10, checked_at: 'a' },
    { name: 'protondb-summary', status: 'down', http_status: 500, latency_ms: 20, checked_at: 'b' },
  ], { run_url: 'https://run' });

  test('replaces only the named service, leaving the rest untouched', () => {
    const fresh = { name: 'protondb-summary', status: 'operational', http_status: 204, latency_ms: 15, checked_at: 'c' };
    const merged = mergeService(base, fresh);
    const summary = merged.services.find((s) => s.name === 'protondb-summary');
    const news = merged.services.find((s) => s.name === 'steam-news');
    expect(summary).toEqual(fresh);
    expect(news.checked_at).toBe('a');
    expect(merged.services).toHaveLength(2);
  });

  test('recomputes overall from the merged set', () => {
    const fresh = { name: 'protondb-summary', status: 'operational', http_status: 204, latency_ms: 15, checked_at: 'c' };
    expect(mergeService(base, fresh).overall).toBe('operational');
  });

  test('keeps canonical FNS ordering after merge', () => {
    const fresh = { name: 'image-refetch', status: 'operational', http_status: 204, latency_ms: 5, checked_at: 'd' };
    const merged = mergeService(base, fresh);
    // image-refetch is first in FNS, so it should sort ahead of the others.
    expect(merged.services[0].name).toBe('image-refetch');
  });

  test('handles a cold/empty base payload', () => {
    const fresh = { name: 'steam-news', status: 'operational', http_status: 204, latency_ms: 5, checked_at: 'e' };
    const merged = mergeService(buildPayload([]), fresh);
    expect(merged.services).toEqual([fresh]);
    expect(merged.overall).toBe('operational');
  });
});

describe('worker POST path is super-admin gated', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'workers', 'edge-status', 'index.js'),
    'utf8',
  );
  test('POST routes to the manual check handler', () => {
    expect(SRC).toMatch(/request\.method === 'POST'/);
    expect(SRC).toContain('handleManualCheck');
  });
  test('manual check verifies super_admin before probing', () => {
    expect(SRC).toContain('verifySuperAdmin');
    expect(SRC).toContain("role=eq.super_admin");
    // unauthorized callers get 401/403, never a probe
    expect(SRC).toMatch(/token \? 403 : 401/);
  });
});

describe('status page reads the worker endpoint with a static fallback', () => {
  const MAIN = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'status', 'main.js'),
    'utf8',
  );

  test('defines a configurable worker endpoint constant', () => {
    expect(MAIN).toContain('EDGE_STATUS_ENDPOINT');
  });

  test('tries the worker first, then falls back to the static edge-status.json', () => {
    expect(MAIN).toContain('fetchStatusPayload');
    expect(MAIN).toMatch(/if\s*\(EDGE_STATUS_ENDPOINT\)/);
    expect(MAIN).toContain("dataUrl('edge-status.json')");
  });

  test('"Check now" button is gated on super-admin only', () => {
    expect(MAIN).toContain('detectSuperAdmin');
    expect(MAIN).toContain('role=eq.super_admin');
    // the button markup is only built when _isSuperAdmin is true
    expect(MAIN).toMatch(/_isSuperAdmin\s*\n?\s*\?/);
    expect(MAIN).toContain('status-check-now-btn');
  });

  test('check-now POSTs the user token to the worker for one function', () => {
    expect(MAIN).toContain('checkServiceNow');
    expect(MAIN).toMatch(/method:\s*'POST'/);
    expect(MAIN).toContain('Authorization: `Bearer ${session.access_token}`');
    expect(MAIN).toContain("JSON.stringify({ fn: svcName })");
  });
});

describe('function list parity with the bash probe', () => {
  test('STATUS_KEY is stable', () => {
    expect(STATUS_KEY).toBe('edge-status');
  });

  test('worker FNS matches the FNS array in check-edge-fn-health.sh', () => {
    const sh = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'check-edge-fn-health.sh'),
      'utf8',
    );
    // Pull the function names out of the bash FNS=( ... ) block.
    const block = sh.match(/FNS=\(([^)]*)\)/);
    expect(block).not.toBeNull();
    const shFns = block[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect([...FNS].sort()).toEqual([...shFns].sort());
  });
});
