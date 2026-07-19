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
  SITES,
  STATUS_KEY,
  classifyStatus,
  classifySiteStatus,
  aggregateOverall,
  buildPayload,
  mergeService,
  appendHistory,
  HISTORY_WINDOW_SEC,
  HISTORY_MAX_POINTS,
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

describe('appendHistory (rolling 7-day latency series)', () => {
  const now = 1_800_000_000;

  test('appends a [t,ms] point per service onto the series', () => {
    const h = appendHistory({}, [
      { name: 'steam-news', latency_ms: 42 },
      { name: 'protondb-summary', latency_ms: 88 },
    ], now);
    expect(h['steam-news']).toEqual([[now, 42]]);
    expect(h['protondb-summary']).toEqual([[now, 88]]);
  });

  test('keeps prior points and appends the new one', () => {
    const prior = { 'steam-news': [[now - 900, 30]] };
    const h = appendHistory(prior, [{ name: 'steam-news', latency_ms: 42 }], now);
    expect(h['steam-news']).toEqual([[now - 900, 30], [now, 42]]);
  });

  test('drops points older than the 7-day window', () => {
    const stale = now - HISTORY_WINDOW_SEC - 10;
    const prior = { 'steam-news': [[stale, 999], [now - 900, 30]] };
    const h = appendHistory(prior, [{ name: 'steam-news', latency_ms: 42 }], now);
    expect(h['steam-news'].some(([t]) => t === stale)).toBe(false);
    expect(h['steam-news']).toEqual([[now - 900, 30], [now, 42]]);
  });

  test('caps a series at HISTORY_MAX_POINTS, keeping the newest', () => {
    const prior = { 'steam-news': [] };
    // all within window so trimming is by count, not time
    for (let i = 0; i < HISTORY_MAX_POINTS + 50; i++) prior['steam-news'].push([now - (HISTORY_MAX_POINTS - i), i]);
    const h = appendHistory(prior, [{ name: 'steam-news', latency_ms: 7 }], now);
    expect(h['steam-news'].length).toBe(HISTORY_MAX_POINTS);
    expect(h['steam-news'][h['steam-news'].length - 1]).toEqual([now, 7]);
  });

  test('tolerates missing/garbage history input', () => {
    expect(appendHistory(null, [{ name: 'x', latency_ms: 1 }], now)).toEqual({ x: [[now, 1]] });
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

  test('modal renders a latency sparkline from the worker history endpoint', () => {
    expect(MAIN).toContain('fetchHistory');
    expect(MAIN).toContain('?history=');
    expect(MAIN).toContain('renderSparkline');
    expect(MAIN).toContain('status-modal-graph');
    // svg path built from the [t,ms] series, no external chart lib
    expect(MAIN).toMatch(/<svg[^>]*status-graph-svg/);
  });
});

describe('worker exposes a history endpoint', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'workers', 'edge-status', 'index.js'),
    'utf8',
  );
  test('GET ?history returns the stored series', () => {
    expect(SRC).toContain("searchParams.has('history')");
    expect(SRC).toContain('HISTORY_KEY');
  });
  test('every probe path updates history', () => {
    expect(SRC).toContain('updateHistory');
  });
});

describe('classifySiteStatus', () => {
  test('2xx is operational with no reason', () => {
    expect(classifySiteStatus(200)).toEqual({ status: 'operational', reason: null });
    expect(classifySiteStatus(204)).toEqual({ status: 'operational', reason: null });
  });

  test('Cloudflare 525 -> origin_ssl_handshake_failed', () => {
    // Cloudflare 525 = SSL handshake with origin failed. Called out
    // separately so support can point at the specific fix rather than
    // treat it as a generic 5xx.
    expect(classifySiteStatus(525)).toEqual({ status: 'down', reason: 'origin_ssl_handshake_failed' });
  });

  test('Cloudflare 526 -> origin_ssl_cert_invalid (the outage that motivated this)', () => {
    // The whole reason this classifier exists: GH Pages Let's Encrypt cert
    // expiring silently produced a 526 that the vendor-status page could
    // not attribute. Explicit reason makes it obvious.
    expect(classifySiteStatus(526)).toEqual({ status: 'down', reason: 'origin_ssl_cert_invalid' });
  });

  test('other 5xx are down with the raw http code preserved', () => {
    expect(classifySiteStatus(500)).toEqual({ status: 'down', reason: 'http_500' });
    expect(classifySiteStatus(502)).toEqual({ status: 'down', reason: 'http_502' });
    expect(classifySiteStatus(503)).toEqual({ status: 'down', reason: 'http_503' });
  });

  test('4xx is degraded (site is reachable but wrong response)', () => {
    // Unlike the edge-function classifier, a 401/403 on the SITE probe
    // does not mean healthy -- version.json is public. So 4xx means the
    // site is degraded, not OK.
    expect(classifySiteStatus(404)).toEqual({ status: 'degraded', reason: 'http_404' });
    expect(classifySiteStatus(403)).toEqual({ status: 'degraded', reason: 'http_403' });
  });

  test('0 = timeout / connection failure', () => {
    expect(classifySiteStatus(0)).toEqual({ status: 'down', reason: 'unreachable' });
  });
});

describe('mergeService preserves site probes across a super-admin single-fn check', () => {
  test('the "Check now" path for one fn does not wipe payload.sites', () => {
    // Regression guard for Codex review comment #3 on PR #356. The
    // super-admin "Check now" flow rebuilds the payload via buildPayload
    // which only knows about services. Sites run on the 15-min cron so
    // wiping them here means the frontend shows "first-deploy cache
    // warm-up" until the next cron -- confusing during the same window
    // the admin is trying to observe.
    const base = {
      services: [],
      sites: [
        { name: 'prod (www.proton-pulse.com)', status: 'operational', http_status: 200 },
        { name: 'staging (mdeguzis.github.io)', status: 'operational', http_status: 200 },
      ],
    };
    const svc = { name: FNS[0], status: 'operational', http_status: 204, latency_ms: 42 };
    const out = mergeService(base, svc);
    // Sites carried through unchanged...
    expect(out.sites).toEqual(base.sites);
    // ... AND the freshly probed fn is folded into the services array.
    expect(out.services.find((s) => s.name === FNS[0])).toEqual(svc);
  });

  test('a base payload with no sites does not add an empty array (backward compat)', () => {
    // Older KV payloads written by the pre-site-probe worker have no
    // sites field at all. Do not fabricate an empty array -- the
    // frontend already handles undefined and shows the warm-up message.
    const base = { services: [] };
    const svc = { name: FNS[0], status: 'operational', http_status: 204, latency_ms: 42 };
    const out = mergeService(base, svc);
    expect('sites' in out).toBe(false);
  });
});

describe('SITES list covers prod and staging', () => {
  test('SITES contains both prod and staging entries', () => {
    const names = SITES.map((s) => s.name);
    expect(names.some((n) => n.includes('prod'))).toBe(true);
    expect(names.some((n) => n.includes('staging'))).toBe(true);
  });

  test('each site has a real https URL + origin_hint for the status card', () => {
    for (const site of SITES) {
      expect(site.url).toMatch(/^https:\/\//);
      expect(typeof site.origin_hint).toBe('string');
      expect(site.origin_hint.length).toBeGreaterThan(0);
    }
  });

  test('the URL each site probes is small + known-deployed (version.json)', () => {
    // version.json is written on every deploy so probing it exercises the
    // full origin-to-CDN path without hitting a heavy asset.
    for (const site of SITES) {
      expect(site.url).toContain('/version.json');
    }
  });

  test('site entries deliberately carry no gh_pages_repo (no GH API auth path)', () => {
    // Regression guard: an earlier version reached into the GitHub Pages
    // REST API for cert expiry / ACME state. That needed a PAT on the
    // worker, which is one more secret to rotate and one more blast
    // radius on leak. The current design relies on the fetch probe alone:
    // Cloudflare 525/526 or an http_status=0 already flags a broken TLS
    // path, and the wiki renewal walkthrough covers the fix. If a future
    // edit re-adds this field, this test forces a discussion.
    for (const site of SITES) {
      expect(site).not.toHaveProperty('gh_pages_repo');
    }
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
