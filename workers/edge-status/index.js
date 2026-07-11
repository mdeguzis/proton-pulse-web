/**
 * workers/edge-status/index.js -- Cloudflare Worker that health-checks every
 * Supabase edge function on a real Cron Trigger and serves the result as JSON.
 *
 * Why this exists:
 *   The old check ran on a GitHub Actions `schedule:` cron, which is
 *   best-effort -- runs drift 15-45+ min under load, get skipped, and get
 *   auto-disabled after 60 days of repo inactivity. It also only wrote
 *   edge-status.json to the prod gh-pages branch, so staging had no live
 *   status data. A Cloudflare Cron Trigger fires on time, every time, and one
 *   CORS endpoint feeds both prod and staging. See #275 (child of #254).
 *
 * How it works:
 *   - scheduled() runs every 15 min (see wrangler.toml [triggers] crons),
 *     pings every function with an OPTIONS preflight (same probe as the old
 *     scripts/check-edge-fn-health.sh), and writes the aggregated payload to
 *     Workers KV under STATUS_KEY.
 *   - fetch() serves that stored payload as JSON with CORS for the prod and
 *     github.io (staging) origins. On a cold KV (first deploy) it runs one
 *     live probe so the page is never blank.
 *
 * Deployment:
 *   1. npm install -g wrangler   (or npx wrangler)
 *   2. wrangler login
 *   3. Create the KV namespace and paste its id into wrangler.toml:
 *        wrangler kv namespace create EDGE_STATUS_KV
 *   4. Set the anon key secret (SUPABASE_URL is a plain var in wrangler.toml):
 *        wrangler secret put SUPABASE_ANON_KEY --name pp-edge-status
 *   5. wrangler deploy   (run from workers/edge-status/)
 *   6. Copy the deployed URL (https://pp-edge-status.<subdomain>.workers.dev)
 *      into EDGE_STATUS_ENDPOINT in js/status/main.js.
 */

// Every Supabase edge function this site depends on. Keep in sync with the
// old scripts/check-edge-fn-health.sh list until that workflow is retired.
export const FNS = [
  'image-refetch',
  'plugin-link-complete',
  'plugin-link-remove',
  'plugin-link-start',
  'plugin-link-status',
  'plugin-link-unlink',
  'plugin-links-list',
  'protondb-summary',
  'steam-appdetails',
  'steam-callback',
  'steam-depot-info',
  'steam-explore',
  'steam-library-lookup',
  'steam-news',
  'sync-steam-library',
  'user-system-upload',
];

export const STATUS_KEY = 'edge-status';
const PROBE_TIMEOUT_MS = 15000;

const ALLOWED_ORIGINS = ['https://www.proton-pulse.com', 'https://mdeguzis.github.io'];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/**
 * Map an HTTP status code to a service state. Mirrors check-edge-fn-health.sh:
 * 401/403 mean "reachable, auth policy rejected the anonymous preflight" -- a
 * policy decision, not an outage -- so they count as operational.
 * @param {number|string} httpCode
 * @returns {'operational'|'down'|'degraded'}
 */
export function classifyStatus(httpCode) {
  const code = Number(httpCode);
  if (code === 200 || code === 204 || code === 401 || code === 403) return 'operational';
  if (code >= 500 && code < 600) return 'down';
  if (code === 0 || Number.isNaN(code)) return 'down';
  return 'degraded';
}

/**
 * Aggregate per-service states: any down -> down; else any degraded ->
 * degraded; else operational.
 * @param {Array<{status:string}>} services
 * @returns {'operational'|'degraded'|'down'|'unknown'}
 */
export function aggregateOverall(services) {
  if (!Array.isArray(services) || services.length === 0) return 'unknown';
  if (services.some((s) => s.status === 'down')) return 'down';
  if (services.some((s) => s.status === 'degraded')) return 'degraded';
  return 'operational';
}

/**
 * Build the full status payload the status page reads. Shape matches the old
 * edge-status.json exactly so js/status/main.js needs no format change.
 * @param {Array} services
 * @param {{updated_at?:string, run_url?:string, now?:number}} [opts]
 */
export function buildPayload(services, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  return {
    updated_at: opts.updated_at || new Date(now).toISOString(),
    overall: aggregateOverall(services),
    run_url: opts.run_url || '',
    services,
  };
}

/**
 * Replace one service in a stored payload with a freshly-probed result,
 * keeping the canonical FNS ordering and recomputing overall + updated_at.
 * Pure so it's unit-testable without the Workers runtime.
 * @param {object} payload - the existing stored payload (may be partial)
 * @param {object} service - a freshly probed service object (has .name)
 */
export function mergeService(payload, service) {
  const prior = payload && Array.isArray(payload.services) ? payload.services : [];
  const services = prior
    .filter((s) => s.name !== service.name)
    .concat([service])
    .sort((a, b) => FNS.indexOf(a.name) - FNS.indexOf(b.name));
  return buildPayload(services, { run_url: (payload && payload.run_url) || '' });
}

// Verify a Supabase access token belongs to a super_admin. Two hops, both
// with the caller's own token so RLS is the real gate: resolve the user id,
// then read their admin row filtered to role=super_admin. Anything less than
// a matching row is a hard no.
async function verifySuperAdmin(env, token) {
  if (!token) return false;
  try {
    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) {
      console.debug('[edge-status] super-admin check: /auth/v1/user non-ok', { status: userRes.status });
      return false;
    }
    const user = await userRes.json();
    const uid = user && user.id;
    if (!uid) return false;
    const adminRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${encodeURIComponent(uid)}&role=eq.super_admin&select=role&limit=1`,
      { headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY } },
    );
    if (!adminRes.ok) {
      console.debug('[edge-status] super-admin check: admins query non-ok', { uid, status: adminRes.status });
      return false;
    }
    const rows = await adminRes.json();
    const ok = Array.isArray(rows) && rows.length > 0;
    console.debug('[edge-status] super-admin check', { uid, isSuperAdmin: ok, source: 'admins role=super_admin' });
    return ok;
  } catch (err) {
    console.warn('[edge-status] super-admin check threw', { error: String(err && err.message || err) });
    return false;
  }
}

// Admin-triggered "Check now": re-probe one function (body {fn}) or the whole
// set, merge into KV, and return the fresh payload. Super-admin only.
async function handleManualCheck(request, env, origin) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const authorized = await verifySuperAdmin(env, token);
  if (!authorized) {
    return jsonResponse({ error: 'forbidden', reason: 'super_admin required' }, token ? 403 : 401, origin);
  }

  let fn = '';
  try {
    const body = await request.json();
    fn = (body && body.fn) || '';
  } catch { /* no body -> full sweep */ }

  let payload;
  if (fn && FNS.includes(fn)) {
    const service = await probeFunction(env, fn);
    const existing = await env.EDGE_STATUS_KV.get(STATUS_KEY);
    const base = existing ? JSON.parse(existing) : buildPayload([]);
    payload = mergeService(base, service);
    await env.EDGE_STATUS_KV.put(STATUS_KEY, JSON.stringify(payload));
    console.info('[edge-status] manual single-fn check', { fn, status: service.status, http_status: service.http_status });
  } else {
    payload = await runProbe(env);
    console.info('[edge-status] manual full sweep', { requested_fn: fn || '(none)' });
  }
  return jsonResponse(payload, 200, origin);
}

// Probe one edge function with a CORS OPTIONS preflight and time it.
async function probeFunction(env, fn) {
  const url = `${env.SUPABASE_URL}/functions/v1/${fn}`;
  const start = Date.now();
  let httpCode = 0;
  try {
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://www.proton-pulse.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
        apikey: env.SUPABASE_ANON_KEY,
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    httpCode = res.status;
  } catch (err) {
    // Timeout / connection failure -> treated as down by classifyStatus(0).
    console.debug('[edge-status] probe failed', { fn, url, error: String(err && err.message || err) });
    httpCode = 0;
  }
  const latencyMs = Date.now() - start;
  const status = classifyStatus(httpCode);
  console.debug('[edge-status] probed', { fn, http_status: httpCode, latency_ms: latencyMs, status });
  return {
    name: fn,
    status,
    http_status: httpCode,
    latency_ms: latencyMs,
    checked_at: new Date().toISOString(),
  };
}

// Run the full probe sweep and persist to KV. Returns the payload written.
export async function runProbe(env) {
  const services = [];
  for (const fn of FNS) {
    services.push(await probeFunction(env, fn));
  }
  const payload = buildPayload(services);
  await env.EDGE_STATUS_KV.put(STATUS_KEY, JSON.stringify(payload));
  console.info('[edge-status] sweep complete', { overall: payload.overall, count: services.length });
  return payload;
}

export default {
  // Cron Trigger entrypoint (wrangler.toml [triggers] crons).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runProbe(env));
  },

  // HTTP entrypoint: serve the last stored payload as JSON.
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    // POST = admin-triggered "Check now" (super-admin only, verified in-worker).
    if (request.method === 'POST') {
      return handleManualCheck(request, env, origin);
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(origin) });
    }

    let body = await env.EDGE_STATUS_KV.get(STATUS_KEY);
    // Cold KV (fresh deploy, before the first cron fires): probe once so the
    // page renders live data instead of an error state.
    if (!body) {
      console.info('[edge-status] cold KV, running one live probe');
      const payload = await runProbe(env);
      body = JSON.stringify(payload);
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
        ...corsHeaders(origin),
      },
    });
  },
};
