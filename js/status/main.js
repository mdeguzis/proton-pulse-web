// Entry module for status.html (#254). Loads edge-status.json (written to
// gh-pages every 15 min by .github/workflows/edge-fn-health.yml) and
// renders a per-service card with a status pill, latency, HTTP code, and
// last-checked timestamp. Auto-refreshes every 60 s so the page stays
// live if the reader leaves it open.

import { dataUrl } from '../lib/data-url.js?v=97f09986';
import { fetchVendorStatuses, VENDOR_REFRESH_MS } from './vendor-status.js?v=f161798f';
import {
  certStateForCert, certStateLabel, certStateDot,
  daysRemaining, totalDays, certBucket, bucketColor, daysBetween,
  CERT_GREEN_MIN_DAYS, CERT_ORANGE_MIN_DAYS,
} from '../lib/cert.js?v=d9dc31b3';

const REFRESH_MS = 60 * 1000;

// Live status endpoint served by the pp-edge-status Cloudflare Worker (#275).
// The worker runs a true 15-min Cron Trigger and serves the same payload shape
// as the old edge-status.json, from one CORS endpoint that both prod and
// staging read. Leave '' until the worker is deployed; until then the page
// falls back to the static edge-status.json on gh-pages. Paste the deployed
// worker URL here (e.g. https://pp-edge-status.<subdomain>.workers.dev).
const EDGE_STATUS_ENDPOINT = 'https://pp-edge-status.mdeguzis.workers.dev';

// Supabase globals exposed by js/lib/supabase-client.js (loaded as a plain
// script before this module). Used to gate the admin-only "Check now" action.
const SUPABASE_URL      = (typeof window !== 'undefined' && window.SUPABASE_URL) || '';
const SUPABASE_ANON_KEY = (typeof window !== 'undefined' && window.SUPABASE_ANON_KEY) || '';
const SupaAuth          = (typeof window !== 'undefined' && window.SupaAuth) || null;

// Super-admin / site-maintenance gate for the per-tile "Check now" button.
// RLS on the admins table is the real gate (and the worker re-verifies the
// token server-side); this flag only decides whether to render the control.
let _isSuperAdmin = false;
let _session = null;

async function detectSuperAdmin() {
  try {
    if (!SupaAuth || !SUPABASE_URL) return;
    _session = await SupaAuth.getSession();
    if (!_session?.user?.id) { _isSuperAdmin = false; return; }
    const url = `${SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${encodeURIComponent(_session.user.id)}&role=eq.super_admin&select=role&limit=1`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${_session.access_token}` },
    });
    if (!res.ok) { _isSuperAdmin = false; return; }
    const rows = await res.json();
    _isSuperAdmin = Array.isArray(rows) && rows.length > 0;
    console.debug('[status] super-admin gate', { uid: _session.user.id, isSuperAdmin: _isSuperAdmin, source: 'admins table role=super_admin' });
  } catch (err) {
    _isSuperAdmin = false;
    console.debug('[status] super-admin gate check failed', { error: String(err && err.message || err) });
  }
}

// Admin-triggered re-check of one function. POSTs the user's Supabase token to
// the worker, which re-verifies super_admin before probing. On success it
// returns the fresh full payload; we re-render the page and the open modal.
async function checkServiceNow(svcName, btn, statusEl) {
  if (!EDGE_STATUS_ENDPOINT) {
    statusEl.textContent = 'Live check endpoint not configured yet.';
    return;
  }
  const session = _session || (SupaAuth ? await SupaAuth.getSession() : null);
  if (!session?.access_token) {
    statusEl.textContent = 'Sign in as a super admin to run a check.';
    return;
  }
  btn.disabled = true;
  statusEl.textContent = 'Checking...';
  try {
    const res = await fetch(EDGE_STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ fn: svcName }),
    });
    if (res.status === 401 || res.status === 403) {
      statusEl.textContent = 'Not authorized (super admin only).';
      console.warn('[status] check-now rejected', { svcName, status: res.status });
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderFromPayload(payload);
    const fresh = (payload.services || []).find((s) => s.name === svcName);
    console.debug('[status] check-now ok', { svcName, status: fresh?.status, http_status: fresh?.http_status });
    if (fresh) openServiceModal(fresh); // re-render modal with the fresh result
  } catch (err) {
    statusEl.textContent = `Check failed: ${err.message || err}`;
    console.warn('[status] check-now failed', { svcName, error: String(err && err.message || err) });
  } finally {
    btn.disabled = false;
  }
}

// Fetch the live payload: try the worker first, fall back to the static file
// written by the (soon-retired) GitHub Actions workflow so the page still
// renders if the worker is unreachable or not yet deployed.
async function fetchStatusPayload() {
  if (EDGE_STATUS_ENDPOINT) {
    try {
      const res = await fetch(EDGE_STATUS_ENDPOINT, { cache: 'no-store' });
      if (res.ok) {
        console.debug('[status] loaded from worker endpoint', { source: 'worker', url: EDGE_STATUS_ENDPOINT });
        return await res.json();
      }
      console.warn('[status] worker endpoint non-ok, falling back to static file', { source: 'worker', status: res.status });
    } catch (err) {
      console.warn('[status] worker endpoint fetch failed, falling back to static file', { source: 'worker', error: String(err && err.message || err) });
    }
  }
  const res = await fetch(await dataUrl('edge-status.json'), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.debug('[status] loaded from static file', { source: 'gh-pages', file: 'edge-status.json' });
  return await res.json();
}

// esc() must escape both quote flavors because vendor cards embed a JSON blob
// in a single-quoted `data-vendor='...'` attribute (#278 review). Cloudflare
// ships a component named "Developer's Site" -- the apostrophe would terminate
// the attribute early and JSON.parse fails silently, so nothing pops up. The
// old escape only handled &, <, >, ".
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function statusLabel(s) {
  if (s === 'operational') return 'Operational';
  if (s === 'degraded')    return 'Degraded';
  if (s === 'down')        return 'Down';
  return 'Unknown';
}

// Explanation shown at the top of the per-service detail modal. The most
// common surprise for a reader is a 401 or 403 on an obvious "up"
// function -- explain that they mean "reachable, auth policy rejected
// the anonymous probe", not "down".
function explainerFor(svc) {
  const code = svc.http_status;
  if (code === 401 || code === 403) {
    return `Steam / Supabase edge functions can return HTTP <strong>${code}</strong>
      to an anonymous OPTIONS probe when the function's auth policy requires
      a signed-in session or a specific header we don't send from this
      health check. That's a policy decision, not an outage -- the function
      is up (it responded fast), it just rejected our unauth request. Real
      users hitting the function with a valid session will get through.`;
  }
  if (code >= 500 && code < 600) {
    return `HTTP <strong>${esc(code)}</strong> is a server-side error and
      usually means the function itself crashed or Supabase is having a
      rough time. Check the function logs in Supabase.`;
  }
  if (code === 0 || code === '000') {
    return `The health check couldn't reach the function at all -- either
      a connection timeout or a DNS/routing failure. Check that the edge
      function is deployed and Supabase status.`;
  }
  if (code >= 200 && code < 300) {
    return `Function responded normally (HTTP <strong>${esc(code)}</strong>).`;
  }
  return `HTTP <strong>${esc(code)}</strong> is not one of the shapes we
    treat as clearly operational, so the check flagged it as degraded.
    Confirm the function behaves as expected before treating this as a
    real regression.`;
}

function renderService(svc) {
  const state = svc.status || 'unknown';
  const httpBadge = svc.http_status ? `HTTP ${esc(svc.http_status)}` : 'no response';
  const svcData = esc(JSON.stringify(svc));
  return `
    <button type="button" class="status-card" data-state="${esc(state)}" data-service='${svcData}' aria-label="Details for ${esc(svc.name)}">
      <div class="status-card-head">
        <span class="status-card-dot"></span>
        <span class="status-card-name">${esc(svc.name)}</span>
        <span class="status-card-state">${statusLabel(state)}</span>
      </div>
      <div class="status-card-meta">
        <span>${httpBadge}</span>
        <span>${esc(svc.latency_ms || 0)} ms</span>
        <span title="${esc(svc.checked_at || '')}">checked ${formatRelative(svc.checked_at)}</span>
      </div>
    </div>
  `;
}

function renderFromPayload(payload) {
  const listEl    = document.getElementById('status-list');
  const overallEl = document.getElementById('status-overall');
  const metaEl    = document.getElementById('status-meta');
  if (!listEl || !overallEl) return;

  const overall = payload.overall || 'unknown';
  overallEl.setAttribute('data-state', overall);
  overallEl.querySelector('.status-overall-text').textContent =
    overall === 'operational' ? 'All systems operational'
    : overall === 'degraded'  ? 'Some services degraded'
    : overall === 'down'      ? 'One or more services down'
    : 'Status unknown';

  if (metaEl) {
    const rel = formatRelative(payload.updated_at);
    const runLink = payload.run_url
      ? ` &middot; <a href="${esc(payload.run_url)}" target="_blank" rel="noopener">latest run</a>`
      : '';
    metaEl.innerHTML = `updated ${esc(rel)}${runLink}`;
  }

  const svcs = Array.isArray(payload.services) ? payload.services : [];
  listEl.innerHTML = svcs.map(renderService).join('') ||
    '<div class="state-box">No services reported.</div>';

  // Site-health cards for prod + staging (added by pp-edge-status worker).
  // Backward compatible: if the payload predates the site probes, the
  // section stays empty rather than erroring.
  const siteListEl = document.getElementById('status-site-list');
  if (siteListEl) {
    const sites = Array.isArray(payload.sites) ? payload.sites : [];
    siteListEl.innerHTML = sites.length
      ? sites.map(renderSiteCard).join('')
      : '<div class="state-box">Site probes have not run yet (first-deploy cache warm-up). Check back in ~15 min.</div>';
  }
}

// Human-readable label for the specific site-probe reason strings the
// worker emits. Keeps operator-facing copy tight and points at the fix
// rather than the mechanic. The wiki page linked from 525/526 covers the
// full recovery walkthrough so operators are not guessing at midnight.
const CERT_RENEWAL_WIKI = 'https://github.com/mdeguzis/proton-pulse-web/wiki/GitHub-Pages-Cert-Renewal';
function siteReasonLabel(reason) {
  if (!reason) return '';
  if (reason === 'origin_ssl_cert_invalid') return 'Origin SSL certificate invalid (Cloudflare 526). See renewal walkthrough.';
  if (reason === 'origin_ssl_handshake_failed') return 'Origin SSL handshake failed (Cloudflare 525). See renewal walkthrough.';
  if (reason === 'unreachable') return 'No response within timeout.';
  const m = reason.match(/^http_(\d+)$/);
  if (m) return `HTTP ${m[1]}`;
  return reason;
}

function renderSiteCard(site) {
  const state = site.status || 'unknown';
  const reasonText = siteReasonLabel(site.reason);
  const primary = state === 'operational'
    ? `${site.http_status || 200} in ${Math.round(site.latency_ms ?? 0)} ms`
    : reasonText || 'unknown';
  const hint = site.origin_hint
    ? `origin: ${site.origin_hint}`
    : '';
  const isCertReason = site.reason === 'origin_ssl_cert_invalid' || site.reason === 'origin_ssl_handshake_failed';
  return `
    <div class="status-card status-card--site" data-state="${esc(state)}">
      <div class="status-card-head">
        <span class="status-card-dot"></span>
        <span class="status-card-name">${esc(site.name)}</span>
        <span class="status-card-state">${statusLabel(state)}</span>
      </div>
      <div class="status-card-meta">
        <span>${esc(primary)}</span>
        <span title="${esc(site.checked_at || '')}">checked ${formatRelative(site.checked_at)}</span>
      </div>
      ${isCertReason ? `<div class="status-card-meta status-card-meta--muted"><span>Renewal steps: <a href="${esc(CERT_RENEWAL_WIKI)}" target="_blank" rel="noopener">wiki</a></span></div>` : ''}
      ${hint ? `<div class="status-card-meta status-card-meta--muted"><span>${esc(hint)}</span></div>` : ''}
    </div>
  `;
}

// Pull a short issuer label out of a full issuer DN string like
// "C=US, O=Let's Encrypt, CN=YE2" -> "Let's Encrypt". Prefers the O
// (organization); falls back to CN, then the raw string.
function issuerShort(issuer) {
  if (!issuer) return '';
  const o = issuer.match(/(?:^|,)\s*O=([^,]+)/);
  if (o) return o[1].trim();
  const cn = issuer.match(/(?:^|,)\s*CN=([^,]+)/);
  if (cn) return cn[1].trim();
  return issuer;
}

function certDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Burndown graph for the public status page: days-remaining (y) over check time
// (x) for the given cert (`field` selects edge_not_after or origin_not_after in
// each history point). Each renewal resets the line up to the full validity
// window, so it reads as a sawtooth descending toward zero. Guide-lines mark the
// 30d (green) and 14d (orange) boundaries. Pure inline SVG, no chart lib.
function renderCertBurndown(history, field) {
  const pts = (Array.isArray(history) ? history : [])
    .map((h) => ({ t: Date.parse(h.checked_at), days: daysBetween(h.checked_at, h[field]) }))
    .filter((p) => Number.isFinite(p.t) && p.days !== null);
  if (pts.length < 2) {
    return '<div class="status-graph-empty">Expiry history is still collecting. The monitor runs every 6 hours, so the burndown line fills in over the first day.</div>';
  }
  const W = 640, H = 180, PADX = 34, PADY = 14;
  const ts = pts.map((p) => p.t), ys = pts.map((p) => p.days);
  const t0 = ts[0], t1 = ts[ts.length - 1], tSpan = (t1 - t0) || 1;
  const maxY = Math.max(...ys, CERT_GREEN_MIN_DAYS + 5), minY = Math.min(...ys, 0), ySpan = (maxY - minY) || 1;
  const x = (t) => PADX + ((t - t0) / tSpan) * (W - PADX - PADY);
  const y = (d) => PADY + (1 - (d - minY) / ySpan) * (H - 2 * PADY);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.days).toFixed(1)}`).join(' ');
  const guide = (d, color, lbl) => (d <= maxY && d >= minY)
    ? `<line x1="${PADX}" y1="${y(d).toFixed(1)}" x2="${W - PADY}" y2="${y(d).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="4 3" opacity="0.55" />
       <text x="${W - PADY}" y="${(y(d) - 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${color}">${esc(lbl)}</text>`
    : '';
  const zeroLine = (0 <= maxY && 0 >= minY)
    ? `<line x1="${PADX}" y1="${y(0).toFixed(1)}" x2="${W - PADY}" y2="${y(0).toFixed(1)}" stroke="currentColor" stroke-width="1" opacity="0.3" />` : '';
  const lastDays = ys[ys.length - 1];
  const lineColor = bucketColor(certBucket(lastDays));
  const startLabel = certDate(new Date(t0).toISOString());
  const endLabel = certDate(new Date(t1).toISOString());
  return `
    <div class="status-graph">
      <div class="status-graph-head">
        <span>Days until expiry (${esc(pts.length)} checks)</span>
        <span>latest: ${esc(lastDays < 0 ? 'expired' : `${lastDays}d`)}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="status-graph-svg" preserveAspectRatio="none" role="img" aria-label="Certificate days remaining over time, latest ${esc(lastDays)} days">
        <text x="3" y="${(y(maxY) + 4).toFixed(1)}" font-size="10" fill="currentColor" opacity="0.55">${esc(Math.round(maxY))}d</text>
        <text x="3" y="${(y(minY) - 1).toFixed(1)}" font-size="10" fill="currentColor" opacity="0.55">${esc(Math.round(minY))}d</text>
        ${zeroLine}
        ${guide(CERT_GREEN_MIN_DAYS, bucketColor('green'), `${CERT_GREEN_MIN_DAYS}d`)}
        ${guide(CERT_ORANGE_MIN_DAYS, bucketColor('orange'), `${CERT_ORANGE_MIN_DAYS}d`)}
        <path d="${path}" fill="none" stroke="${lineColor}" stroke-width="2" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="status-graph-foot"><span>${esc(startLabel)}</span><span>now</span></div>
    </div>`;
}

// One-line summary of a cert: "Issued by Let's Encrypt · 57 days remaining".
function certSummaryLine(cert) {
  const state = certStateForCert(cert);
  if (state === 'unreachable') return 'could not be read';
  const issuer = issuerShort(cert && cert.issuer);
  const days = daysRemaining(cert.not_after);
  const daysText = days === null ? ''
    : days < 0 ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
    : `${days} day${days === 1 ? '' : 's'} remaining`;
  return [issuer ? `Issued by ${issuer}` : 'TLS certificate', daysText].filter(Boolean).join(' · ');
}

// Public cert card, two-cert model (#359). The EDGE cert (what browsers actually
// validate, auto-renewed by Cloudflare) drives the headline state. The ORIGIN
// cert (GitHub Pages backend, behind Cloudflare) is shown as a muted operator
// line -- with GitHub's own ACME state (e.g. bad_authz) when present -- because
// while Cloudflare SSL is non-strict an expired origin cert does not reach
// visitors. Burndown tracks the edge cert. Full-width card (.status-card--cert).
function renderCertCard(status, history) {
  const edge = status && status.edge;
  const origin = status && status.origin;
  const gh = status && status.github_pages;
  const state = certStateForCert(edge);
  const dot = certStateDot(state);
  const label = certStateLabel(state);
  const domain = (status && status.domain) ? status.domain : 'Site certificate';
  const total = edge && edge.not_before && edge.not_after ? totalDays(edge.not_before, edge.not_after) : null;
  const window = (edge && edge.not_before && edge.not_after)
    ? `Valid ${certDate(edge.not_before)} → ${certDate(edge.not_after)}${total !== null ? ` (${total}-day window)` : ''}`
    : '';

  // Origin line: muted context, never the headline. Fold in GitHub's ACME state.
  const originState = certStateForCert(origin);
  const originExpiry = origin && origin.not_after ? certDate(origin.not_after) : '';
  const ghNote = gh && gh.state && gh.state !== 'approved'
    ? ` · GitHub: ${gh.state}` : '';
  const originText = originState === 'unreachable'
    ? 'GitHub Pages origin: not reachable'
    : originState === 'valid'
      ? `GitHub Pages origin: valid → ${originExpiry} (renews via GitHub)`
      : `GitHub Pages origin: ${certStateLabel(originState).toLowerCase()}${originExpiry ? ` ${originExpiry}` : ''}${ghNote} — not visitor-facing while Cloudflare SSL is non-strict`;

  return `
    <div class="status-card status-card--site status-card--cert" data-state="${esc(dot)}">
      <div class="status-card-head">
        <span class="status-card-dot"></span>
        <span class="status-card-name">${esc(domain)}</span>
        <span class="status-card-state">${esc(label)}</span>
      </div>
      <div class="status-card-meta status-card-meta--muted">
        <span>Served to visitors: ${esc(certSummaryLine(edge))}</span>
        ${window ? `<span>${esc(window)}</span>` : ''}
        <span>${esc(originText)}</span>
        <span>How this works: <a href="${esc(CERT_RENEWAL_WIKI)}" target="_blank" rel="noopener">wiki</a></span>
      </div>
      ${renderCertBurndown(history, 'edge_not_after')}
    </div>
  `;
}

async function loadAndRenderCert() {
  const listEl = document.getElementById('status-cert-list');
  if (!listEl) return;
  try {
    const [statusRes, historyRes] = await Promise.all([
      fetch(await dataUrl('cert-status.json'), { cache: 'no-store' }),
      fetch(await dataUrl('cert-history.json'), { cache: 'no-store' }).catch(() => null),
    ]);
    if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
    const status = await statusRes.json();
    const history = historyRes && historyRes.ok ? await historyRes.json().catch(() => []) : [];
    console.debug('[status] cert health loaded', {
      source: 'gh-pages', file: 'cert-status.json',
      edgeState: certStateForCert(status && status.edge),
      originState: certStateForCert(status && status.origin),
      githubPages: status && status.github_pages && status.github_pages.state,
      historyPoints: Array.isArray(history) ? history.length : 0,
    });
    listEl.innerHTML = renderCertCard(status, history);
  } catch (err) {
    console.warn('[status] cert-status.json fetch failed', { source: 'gh-pages', file: 'cert-status.json', error: String(err && err.message || err) });
    listEl.innerHTML = '<div class="state-box">Cert check has not run yet. Check back after the next monitor cycle.</div>';
  }
}

async function loadAndRender() {
  const overallEl = document.getElementById('status-overall');
  const metaEl    = document.getElementById('status-meta');
  if (!overallEl) return;
  let payload;
  try {
    payload = await fetchStatusPayload();
  } catch (err) {
    overallEl.setAttribute('data-state', 'unknown');
    overallEl.querySelector('.status-overall-text').textContent = 'Could not load status data';
    if (metaEl) metaEl.textContent = String(err.message || err);
    return;
  }
  renderFromPayload(payload);
}

// Fetch one function's rolling latency history ([[epochSec, ms], ...]) from
// the worker for the modal sparkline. Null on any failure so the modal simply
// omits the graph rather than erroring.
async function fetchHistory(fn) {
  if (!EDGE_STATUS_ENDPOINT) return null;
  try {
    const res = await fetch(`${EDGE_STATUS_ENDPOINT}?history=${encodeURIComponent(fn)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.[fn]) ? data[fn] : [];
  } catch (err) {
    console.debug('[status] history fetch failed', { fn, error: String(err && err.message || err) });
    return null;
  }
}

// Render a small inline-SVG latency sparkline from a [[t,ms],...] series.
// Time-scaled x so gaps in the history show as gaps in cadence, not evenly
// spaced points. No external chart lib -- one path plus min/avg/max labels.
function renderSparkline(series) {
  const pts = (series || []).filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[1]));
  if (pts.length < 2) {
    return '<div class="status-graph-empty">Latency history is still collecting. Check back after a few 15-minute cycles.</div>';
  }
  const W = 320, H = 64, PAD = 5;
  const ts = pts.map((p) => p[0]);
  const ms = pts.map((p) => p[1]);
  const t0 = ts[0], t1 = ts[ts.length - 1];
  const tSpan = (t1 - t0) || 1;
  const minMs = Math.min(...ms), maxMs = Math.max(...ms);
  const msSpan = (maxMs - minMs) || 1;
  const x = (t) => PAD + ((t - t0) / tSpan) * (W - 2 * PAD);
  const y = (m) => PAD + (1 - (m - minMs) / msSpan) * (H - 2 * PAD);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const last = ms[ms.length - 1];
  const avg = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
  const spanDays = Math.max(1, Math.round(tSpan / 86400));
  const tMid = new Date(((t0 + t1) / 2) * 1000);
  const tStart = new Date(t0 * 1000);
  const midLabel = spanDays > 1
    ? tMid.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : tMid.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startLabel = spanDays > 1
    ? tStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : tStart.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `
    <div class="status-graph">
      <div class="status-graph-head">
        <span>Latency, last ${esc(spanDays)}d (${esc(pts.length)} checks)</span>
        <span>min ${esc(minMs)} / avg ${esc(avg)} / max ${esc(maxMs)} ms</span>
      </div>
      <div class="status-graph-body">
        <div class="status-graph-y" aria-hidden="true">
          <span>${esc(maxMs)} ms</span>
          <span>${esc(minMs)} ms</span>
        </div>
        <svg viewBox="0 0 ${W} ${H}" class="status-graph-svg" preserveAspectRatio="none" role="img" aria-label="Latency over the last ${esc(spanDays)} days, ranging ${esc(minMs)} to ${esc(maxMs)} ms, latest ${esc(last)} ms">
          <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" />
        </svg>
      </div>
      <div class="status-graph-foot">
        <span>${esc(startLabel)}</span>
        <span>${esc(midLabel)}</span>
        <span>now</span>
      </div>
    </div>`;
}

// Render one vendor row (GitHub / Cloudflare). Same visual shape as the
// Supabase cards; clicking opens the vendor modal (openVendorModal) which
// breaks down which Proton-Pulse-critical components are up, and lists other
// degraded services non-critically so a broader outage stays visible without
// falsely flipping our tile.
function renderVendorCard(svc) {
  const state = svc.status || 'unknown';
  const criticalCount = Array.isArray(svc.critical) ? svc.critical.length : 0;
  const degradedCritical = Array.isArray(svc.critical)
    ? svc.critical.filter((c) => c.state !== 'operational').length
    : 0;
  const summary = svc.error
    ? 'feed unreachable'
    : criticalCount === 0
      ? 'no services tracked'
      : degradedCritical === 0
        ? `${criticalCount} tracked services OK`
        : `${degradedCritical} of ${criticalCount} tracked services affected`;
  const svcData = esc(JSON.stringify(svc));
  return `
    <button type="button" class="status-card status-card--vendor" data-state="${esc(state)}" data-vendor='${svcData}' aria-label="Details for ${esc(svc.name)} infrastructure">
      <div class="status-card-head">
        <span class="status-card-dot"></span>
        <span class="status-card-name">${esc(svc.name)}</span>
        <span class="status-card-state">${statusLabel(state)}</span>
      </div>
      <div class="status-card-meta">
        <span>${esc(summary)}</span>
        <span title="${esc(svc.checked_at || '')}">checked ${formatRelative(svc.checked_at)}</span>
      </div>
    </button>
  `;
}

async function loadAndRenderVendor() {
  const listEl = document.getElementById('status-vendor-list');
  if (!listEl) return;
  let cards;
  try {
    cards = await fetchVendorStatuses();
  } catch (err) {
    console.warn('[status] vendor list load failed', { error: String(err && err.message || err) });
    listEl.innerHTML = '<div class="state-box">Vendor status feeds unreachable.</div>';
    return;
  }
  listEl.innerHTML = cards.map(renderVendorCard).join('') ||
    '<div class="state-box">No vendor rows.</div>';
}

// Vendor modal: reuses the shared #status-modal-* backdrop but swaps in a
// components view instead of the per-service dl. The critical section always
// renders first with the pill state for every component we depend on. The
// "other degraded" section only renders when the vendor has issues elsewhere,
// so a wider outage is still discoverable without polluting the primary view.
function openVendorModal(svc) {
  const backdrop = document.getElementById('status-modal-backdrop');
  const body     = document.getElementById('status-modal-body');
  const expl     = document.getElementById('status-modal-explainer');
  if (!backdrop || !body) return;
  const criticalRows = (svc.critical || []).map((c) => `
    <li class="vendor-modal-item vendor-modal-item--critical" data-state="${esc(c.state)}">
      <span class="vendor-modal-dot"></span>
      <span class="vendor-modal-name">${esc(c.name)}</span>
      <span class="vendor-modal-state">${statusLabel(c.state)}</span>
    </li>`).join('');
  const otherRows = (svc.other_degraded || []).map((c) => `
    <li class="vendor-modal-item vendor-modal-item--other" data-state="${esc(c.state)}">
      <span class="vendor-modal-dot"></span>
      <span class="vendor-modal-name">${esc(c.name)}</span>
      <span class="vendor-modal-state">${statusLabel(c.state)}</span>
    </li>`).join('');
  const otherSection = otherRows
    ? `<h4 class="vendor-modal-subhead">Other ${esc(svc.name)} services with issues</h4>
       <p class="vendor-modal-hint">Not tracked as critical for Proton Pulse but shown here so a wider ${esc(svc.name)} incident stays visible.</p>
       <ul class="vendor-modal-list vendor-modal-list--other">${otherRows}</ul>`
    : '';
  expl.innerHTML = svc.error
    ? `The ${esc(svc.name)} status feed did not respond (${esc(svc.error)}). Check the vendor status page directly.`
    : `Overall tile status reflects only the ${esc(svc.name)} components Proton Pulse depends on. A ${esc(svc.name)} incident that does not touch any of these (for example, an admin dashboard outage) stays green here even if the vendor's overall banner is yellow.`;
  body.innerHTML = `
    <h3>${esc(svc.name)}</h3>
    <h4 class="vendor-modal-subhead">Services Proton Pulse depends on</h4>
    <ul class="vendor-modal-list vendor-modal-list--critical">${criticalRows || '<li class="vendor-modal-empty">No critical services configured.</li>'}</ul>
    ${otherSection}
    <p class="vendor-modal-foot">
      <a href="${esc(svc.vendor_status_url || '#')}" target="_blank" rel="noopener">Open the full ${esc(svc.name)} status page &rarr;</a>
    </p>
  `;
  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
}

// Click-to-open modal: shows the full stdout-like blob for one service.
// The card element carries the raw service JSON on a data-service attribute
// (set in renderService); we delegate the click on the list so the handler
// stays wired across re-renders.
function openServiceModal(svc) {
  const backdrop = document.getElementById('status-modal-backdrop');
  const body     = document.getElementById('status-modal-body');
  const expl     = document.getElementById('status-modal-explainer');
  if (!backdrop || !body) return;
  expl.innerHTML = explainerFor(svc);
  const rows = [
    ['Function',      svc.name],
    ['Overall state', statusLabel(svc.status || 'unknown')],
    ['HTTP status',   svc.http_status],
    ['Latency',       `${svc.latency_ms} ms`],
    ['Last checked',  `${svc.checked_at || ''} (${formatRelative(svc.checked_at)})`],
  ];
  // Super admins get a live "Check now" that re-probes this one function on
  // demand instead of waiting for the next 15-min cron. Hidden for everyone
  // else; the worker re-verifies the token server-side regardless.
  const adminControls = _isSuperAdmin
    ? `
    <div class="status-modal-admin">
      <button type="button" id="status-check-now-btn" class="status-check-now-btn" data-fn="${esc(svc.name)}">Check now</button>
      <span id="status-check-now-status" class="status-check-now-status"></span>
    </div>`
    : '';
  body.innerHTML = `
    <h3>${esc(svc.name)}</h3>
    <dl class="status-modal-dl">
      ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl>
    ${adminControls}
    <pre class="status-modal-raw">${esc(JSON.stringify(svc, null, 2))}</pre>
    <div id="status-modal-graph" class="status-graph-wrap"></div>
  `;
  const checkBtn = document.getElementById('status-check-now-btn');
  if (checkBtn) {
    checkBtn.addEventListener('click', () => {
      const statusEl = document.getElementById('status-check-now-status');
      checkServiceNow(svc.name, checkBtn, statusEl);
    });
  }
  // Async-fill the latency sparkline so the modal opens instantly.
  const graphEl = document.getElementById('status-modal-graph');
  if (graphEl && EDGE_STATUS_ENDPOINT) {
    graphEl.innerHTML = '<div class="status-graph-empty">Loading latency history...</div>';
    fetchHistory(svc.name).then((series) => {
      if (!graphEl.isConnected) return;
      graphEl.innerHTML = renderSparkline(series);
    });
  }
  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeServiceModal() {
  const backdrop = document.getElementById('status-modal-backdrop');
  if (!backdrop) return;
  backdrop.hidden = true;
  document.body.style.overflow = '';
}
document.getElementById('status-list')?.addEventListener('click', (e) => {
  const card = e.target.closest('.status-card');
  if (!card) return;
  try {
    const svc = JSON.parse(card.dataset.service || '{}');
    if (svc && svc.name) openServiceModal(svc);
  } catch (err) {
    console.debug('[status] failed to parse service payload', err);
  }
});
document.getElementById('status-vendor-list')?.addEventListener('click', (e) => {
  const card = e.target.closest('.status-card--vendor');
  if (!card) return;
  try {
    const svc = JSON.parse(card.dataset.vendor || '{}');
    if (svc && svc.name) openVendorModal(svc);
  } catch (err) {
    // Warn (not debug) so a silent failure like the "Developer's Site"
    // apostrophe bug (#278 review) surfaces in the console next time.
    console.warn('[status] failed to parse vendor payload', {
      error: String(err && err.message || err),
      preview: String(card.dataset.vendor || '').slice(0, 200),
    });
  }
});
document.getElementById('status-modal-close')?.addEventListener('click', closeServiceModal);
document.getElementById('status-modal-backdrop')?.addEventListener('click', (e) => {
  if (e.target?.id === 'status-modal-backdrop') closeServiceModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeServiceModal();
});

// Resolve the super-admin gate before the first render so a maintainer who
// opens a tile right away already sees the "Check now" control.
detectSuperAdmin().finally(() => loadAndRender());
setInterval(loadAndRender, REFRESH_MS);

// Origin cert health (#359): its own fetch of cert-status.json, refreshed on
// the same cadence as the rest of the page.
loadAndRenderCert();
setInterval(loadAndRenderCert, REFRESH_MS);

// Vendor rows (#278): GitHub Pages + Cloudflare overall. Refreshes on a
// separate cadence because the upstream feeds themselves update on the
// order of minutes and there is no reason to hammer them every 60 s.
loadAndRenderVendor();
setInterval(loadAndRenderVendor, VENDOR_REFRESH_MS);

// Back-to-top pill: reveals once the reader has scrolled past ~one viewport
// so it does not compete with the header. Click smooth-scrolls to top.
const backToTopBtn = document.getElementById('status-back-to-top');
if (backToTopBtn) {
  const toggleVisible = () => {
    if (window.scrollY > window.innerHeight * 0.6) backToTopBtn.classList.add('is-visible');
    else backToTopBtn.classList.remove('is-visible');
  };
  window.addEventListener('scroll', toggleVisible, { passive: true });
  toggleVisible();
  backToTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// Announcements: pulled directly from the public GitHub issues API for the
// proton-pulse-web repo, filtered to the "announcement" label. Any issue with
// that label shows here, so a bug or incident tagged announcement shows too and
// its other labels render as tags. We only surface announcements authored by a
// maintainer (OWNER / MEMBER / COLLABORATOR): the announcement issue template
// applies the label for anyone, so the author check keeps the status page from
// being a public post box. Open ones sort first, resolved follow (muted). The
// issue body is markdown, rendered with markdown-it. If GitHub rate-limits the
// anonymous fetch we fall back to a friendly message so the page never looks
// broken.

const ANNOUNCE_REPO = 'mdeguzis/proton-pulse-web';
const ANNOUNCE_URL  = `https://api.github.com/repos/${ANNOUNCE_REPO}/issues?labels=announcement&state=all&per_page=10&sort=created&direction=desc`;
const ANNOUNCE_TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const _announceMd = (typeof window !== 'undefined' && typeof window.markdownit === 'function')
  ? window.markdownit({ html: false, linkify: true, breaks: true })
  : null;

// Render a GitHub issue body (markdown) to safe HTML. markdown-it runs with
// html:false so raw HTML in the body is escaped, not injected. Falls back to
// escaped plain text if the CDN script did not load.
function renderAnnouncementBody(body) {
  const text = (body || '').trim();
  if (!text) return '';
  const inner = _announceMd ? _announceMd.render(text) : esc(text).replace(/\n/g, '<br>');
  return `<div class="announcement-body">${inner}</div>`;
}

function renderAnnouncement(issue) {
  const isOpen = issue.state === 'open';
  const created = new Date(issue.created_at);
  const rel = formatRelative(issue.created_at);
  const dateAttr = Number.isNaN(created.getTime()) ? '' : created.toISOString();
  const num = issue.number;
  // Other labels (bug, incident, enhancement...) render as tags. The driving
  // "announcement" label is implied by being in this list, so it is dropped.
  const tags = (issue.labels || [])
    .map(l => (typeof l === 'string' ? l : (l && l.name)))
    .filter(name => name && name.toLowerCase() !== 'announcement')
    .map(name => `<span class="announcement-tag">${esc(name)}</span>`)
    .join('');
  return `
    <article class="announcement" data-state="${isOpen ? 'open' : 'closed'}">
      <div class="announcement-head">
        <a class="announcement-pill" href="${esc(issue.html_url)}" target="_blank" rel="noopener">#${esc(num)}</a>
        <a class="announcement-title" href="${esc(issue.html_url)}" target="_blank" rel="noopener">${esc(issue.title)}</a>
        <span class="announcement-state">${isOpen ? 'Open' : 'Resolved'}</span>
      </div>
      <div class="announcement-meta">
        <time datetime="${esc(dateAttr)}">opened ${esc(rel)}</time>
        ${tags}
      </div>
      ${renderAnnouncementBody(issue.body)}
    </article>
  `;
}

async function loadAnnouncements() {
  const listEl = document.getElementById('status-announcements-list');
  if (!listEl) return;
  try {
    const res = await fetch(ANNOUNCE_URL, { headers: { 'Accept': 'application/vnd.github+json' } });
    if (res.status === 403) throw new Error('GitHub API rate limit reached');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const issues = await res.json();
    // Pull requests come back in the same feed -- drop them so the list is
    // only real issues.
    const rows = (Array.isArray(issues) ? issues : [])
      .filter(r => !r.pull_request)
      .filter(r => ANNOUNCE_TRUSTED_AUTHORS.has(r.author_association));
    if (!rows.length) {
      listEl.innerHTML = '<div class="state-box">No announcements. All quiet.</div>';
      return;
    }
    rows.sort((a, b) => {
      if (a.state !== b.state) return a.state === 'open' ? -1 : 1;
      return String(b.created_at).localeCompare(String(a.created_at));
    });
    listEl.innerHTML = rows.map(renderAnnouncement).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="state-box">Could not load announcements (${esc(err.message || err)}). Check the <a href="https://github.com/${esc(ANNOUNCE_REPO)}/issues?q=is%3Aissue+label%3Aannouncement" target="_blank" rel="noopener">announcement issue list</a> directly.</div>`;
  }
}

loadAnnouncements();
setInterval(loadAnnouncements, 5 * 60 * 1000);

// ── Security scanner posture ───────────────────────────────────────────────
// Renders the scanner-status tiles. Deliberately does NOT list every open
// security issue or post an "N open" counter -- that information lives on
// GitHub and stays there so this section reads as a posture summary rather
// than a running bug list. The "Report a vulnerability" button in the
// section header lands researchers on the security advisories page, which
// is the canonical view for the actual issue list.
function renderSecurityScanners() {
  const listEl = document.getElementById('status-security-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="status-security-checks" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">
    <div class="state-box" style="border-left:3px solid #3aaa5b;padding:8px 12px;font-size:0.78rem"><strong style="color:#3aaa5b">CodeQL</strong> - static analysis active</div>
    <div class="state-box" style="border-left:3px solid #3aaa5b;padding:8px 12px;font-size:0.78rem"><strong style="color:#3aaa5b">Dependabot</strong> - dependency scanning</div>
    <div class="state-box" style="border-left:3px solid #3aaa5b;padding:8px 12px;font-size:0.78rem"><strong style="color:#3aaa5b">npm audit</strong> - CVE gating on PRs</div>
    <div class="state-box" style="border-left:3px solid #3aaa5b;padding:8px 12px;font-size:0.78rem"><strong style="color:#3aaa5b">Rate limiting</strong> - all edge functions</div>
    <div class="state-box" style="border-left:3px solid #3aaa5b;padding:8px 12px;font-size:0.78rem"><strong style="color:#3aaa5b">CSP</strong> - Content Security Policy</div>
    <div class="state-box" style="border-left:3px solid #3aaa5b;padding:8px 12px;font-size:0.78rem"><strong style="color:#3aaa5b">RLS</strong> - Row-Level Security</div>
  </div>`;
}

renderSecurityScanners();
