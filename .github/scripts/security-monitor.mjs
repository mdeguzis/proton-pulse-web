// Security monitor: queries Supabase project logs for anomalies and opens
// GitHub issues with the 'security' label when thresholds are breached.
//
// Checks:
// 1. Auth anomalies: failed sign-in spike (>50 failures in the last hour)
// 2. Edge function errors: >10% error rate in the last hour
// 3. RLS violations: any 403 responses from PostgREST in the last hour
//
// Runs hourly via GitHub Actions. Opens one issue per alert type, skips if
// an open issue with the same title already exists (no spam).

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const SB_TOKEN = process.env.SUPABASE_TOKEN;
const GH_TOKEN = process.env.GH_TOKEN;
const REPO = process.env.REPO;

if (!PROJECT_REF || !SB_TOKEN || !GH_TOKEN || !REPO) {
  console.error('Missing required env vars');
  process.exit(1);
}

const SB_API = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;
const GH_API = `https://api.github.com/repos/${REPO}`;

const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

async function sbFetch(path) {
  const res = await fetch(`${SB_API}${path}`, {
    headers: { Authorization: `Bearer ${SB_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    console.warn(`Supabase API ${path}: ${res.status} ${res.statusText}`);
    return null;
  }
  return res.json();
}

async function ghIssueExists(title) {
  const q = encodeURIComponent(`repo:${REPO} is:issue is:open in:title "${title}"`);
  const res = await fetch(`https://api.github.com/search/issues?q=${q}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return false;
  const data = await res.json();
  return (data.total_count || 0) > 0;
}

async function createAlert(title, body) {
  if (await ghIssueExists(title)) {
    console.log(`Alert already open: ${title}`);
    return;
  }
  const res = await fetch(`${GH_API}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: ['security'] }),
  });
  if (res.ok) {
    const issue = await res.json();
    console.log(`Created alert: ${issue.html_url}`);
  } else {
    console.error(`Failed to create issue: ${res.status} ${await res.text()}`);
  }
}

// Check 1: Auth failures
async function checkAuthAnomalies() {
  const logs = await sbFetch(`/analytics/endpoints/logs?iso_timestamp_start=${ONE_HOUR_AGO}&path=/auth/v1/token`);
  if (!logs || !Array.isArray(logs)) {
    console.log('Auth logs: no data or unsupported endpoint, skipping');
    return;
  }
  const failures = logs.filter(l => l.status_code >= 400).length;
  console.log(`Auth failures in last hour: ${failures}`);
  if (failures > 50) {
    await createAlert(
      '[Alert] Auth anomaly: high failure rate',
      `The security monitor detected ${failures} failed auth attempts in the last hour (threshold: 50).\n\nThis could indicate a brute-force attempt against the Steam OpenID bridge. Check Supabase auth logs for the source IPs and consider temporary blocking.\n\nTriggered at: ${new Date().toISOString()}`
    );
  }
}

// Check 2: Edge function error rate
async function checkEdgeFunctionErrors() {
  const logs = await sbFetch(`/analytics/endpoints/logs?iso_timestamp_start=${ONE_HOUR_AGO}`);
  if (!logs || !Array.isArray(logs)) {
    console.log('Edge function logs: no data or unsupported endpoint, skipping');
    return;
  }
  const edgeLogs = logs.filter(l => (l.path || '').startsWith('/functions/'));
  const total = edgeLogs.length;
  const errors = edgeLogs.filter(l => l.status_code >= 500).length;
  const rate = total > 0 ? (errors / total) : 0;
  console.log(`Edge functions: ${errors}/${total} errors (${(rate * 100).toFixed(1)}%)`);
  if (total > 20 && rate > 0.1) {
    await createAlert(
      '[Alert] Edge function error spike',
      `${errors} out of ${total} edge function requests returned 5xx in the last hour (${(rate * 100).toFixed(1)}% error rate, threshold: 10%).\n\nCheck the Supabase dashboard for function-level breakdown.\n\nTriggered at: ${new Date().toISOString()}`
    );
  }
}

// Check 3: RLS / permission denials (403s from PostgREST)
async function checkRlsViolations() {
  const logs = await sbFetch(`/analytics/endpoints/logs?iso_timestamp_start=${ONE_HOUR_AGO}&path=/rest/v1`);
  if (!logs || !Array.isArray(logs)) {
    console.log('REST logs: no data or unsupported endpoint, skipping');
    return;
  }
  const denials = logs.filter(l => l.status_code === 403).length;
  console.log(`RLS 403 denials in last hour: ${denials}`);
  if (denials > 20) {
    await createAlert(
      '[Alert] Elevated RLS denials',
      `${denials} requests received 403 (RLS denial) from PostgREST in the last hour (threshold: 20).\n\nThis could indicate someone probing endpoints they do not have access to. Check the request paths and user IDs in the Supabase logs.\n\nTriggered at: ${new Date().toISOString()}`
    );
  }
}

// Check 4: Rate limit hits (429s) -- aggregate across the site.
async function checkRateLimitHits() {
  const logs = await sbFetch(`/analytics/endpoints/logs?iso_timestamp_start=${ONE_HOUR_AGO}`);
  if (!logs || !Array.isArray(logs)) {
    console.log('Rate limit logs: no data, skipping');
    return;
  }
  const hits = logs.filter(l => l.status_code === 429).length;
  console.log(`Rate limit 429s in last hour: ${hits}`);
  if (hits > 100) {
    await createAlert(
      '[Alert] High rate-limit activity',
      `${hits} requests were rate-limited (429) in the last hour (threshold: 100).\n\nSomeone is hitting our endpoints aggressively. The rate limiter is doing its job, but if sustained this could indicate a targeted attack. Check source IPs.\n\nTriggered at: ${new Date().toISOString()}`
    );
  }
}

// Check 5 (#320): Per-IP rate-limit abuse. The aggregate check catches
// site-wide storms but misses one persistent attacker who trips the
// limit repeatedly. Group last-hour 429s by client IP and alert when
// any single IP crosses the abuse threshold. Repeated trips from one
// origin are what warrants a targeted response (add to WAF block list,
// contact hosting provider, etc.).
const RATE_LIMIT_ABUSE_THRESHOLD = 50;

async function checkRateLimitAbusePerIp() {
  const logs = await sbFetch(`/analytics/endpoints/logs?iso_timestamp_start=${ONE_HOUR_AGO}`);
  if (!logs || !Array.isArray(logs)) {
    console.log('Per-IP rate limit logs: no data, skipping');
    return;
  }
  const trips = logs.filter(l => l.status_code === 429);
  const byIp = new Map();
  for (const t of trips) {
    const ip = t.remote_addr || t.client_ip || t.x_forwarded_for || 'unknown';
    byIp.set(ip, (byIp.get(ip) || 0) + 1);
  }
  const offenders = [...byIp.entries()]
    .filter(([, count]) => count >= RATE_LIMIT_ABUSE_THRESHOLD)
    .sort((a, b) => b[1] - a[1]);
  console.log(`Per-IP 429s: ${trips.length} total across ${byIp.size} IPs, ${offenders.length} over threshold ${RATE_LIMIT_ABUSE_THRESHOLD}`);
  if (offenders.length === 0) return;
  const detail = offenders.slice(0, 10)
    .map(([ip, count]) => `- ${ip}: ${count} trips`)
    .join('\n');
  await createAlert(
    '[Alert] Rate-limit abuse from single IP',
    `${offenders.length} IP${offenders.length === 1 ? '' : 's'} tripped the rate limit ≥ ${RATE_LIMIT_ABUSE_THRESHOLD} times in the last hour.\n\nTop offenders:\n${detail}\n\nThis indicates a targeted attacker rather than incidental traffic. Consider blocking at Cloudflare or your DNS provider. The rate limiter itself is doing its job (all requests returned 429).\n\nTriggered at: ${new Date().toISOString()}`
  );
}

async function main() {
  console.log(`Security monitor running at ${new Date().toISOString()}`);
  console.log(`Project: ${PROJECT_REF}, Lookback: ${ONE_HOUR_AGO}`);
  await checkAuthAnomalies();
  await checkEdgeFunctionErrors();
  await checkRlsViolations();
  await checkRateLimitHits();
  await checkRateLimitAbusePerIp();
  console.log('Security monitor complete.');
}

main().catch(err => {
  console.error('Monitor failed:', err);
  process.exit(1);
});
