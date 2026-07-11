// Entry module for status.html (#254). Loads edge-status.json (written to
// gh-pages every 15 min by .github/workflows/edge-fn-health.yml) and
// renders a per-service card with a status pill, latency, HTTP code, and
// last-checked timestamp. Auto-refreshes every 60 s so the page stays
// live if the reader leaves it open.

import { dataUrl } from '../lib/data-url.js?v=3c2e7ac9';

const REFRESH_MS = 60 * 1000;

// Live status endpoint served by the pp-edge-status Cloudflare Worker (#275).
// The worker runs a true 15-min Cron Trigger and serves the same payload shape
// as the old edge-status.json, from one CORS endpoint that both prod and
// staging read. Leave '' until the worker is deployed; until then the page
// falls back to the static edge-status.json on gh-pages. Paste the deployed
// worker URL here (e.g. https://pp-edge-status.<subdomain>.workers.dev).
const EDGE_STATUS_ENDPOINT = '';

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

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  `;
  const checkBtn = document.getElementById('status-check-now-btn');
  if (checkBtn) {
    checkBtn.addEventListener('click', () => {
      const statusEl = document.getElementById('status-check-now-status');
      checkServiceNow(svc.name, checkBtn, statusEl);
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

// Announcements: pulled directly from the public GitHub issues API for the
// proton-pulse-web repo, filtered to the "incident" label. Open incidents
// sort first, resolved ones follow (muted). If GitHub rate-limits the
// anonymous fetch we fall back to a friendly message so the page never
// looks broken. The Report an issue link in the section head deep-links
// to a pre-labeled new issue so users skip the label picker.

const ANNOUNCE_REPO = 'mdeguzis/proton-pulse-web';
const ANNOUNCE_URL  = `https://api.github.com/repos/${ANNOUNCE_REPO}/issues?labels=incident&state=all&per_page=10&sort=created&direction=desc`;

function renderAnnouncement(issue) {
  const isOpen = issue.state === 'open';
  const created = new Date(issue.created_at);
  const rel = formatRelative(issue.created_at);
  const dateAttr = Number.isNaN(created.getTime()) ? '' : created.toISOString();
  const num = issue.number;
  return `
    <article class="announcement" data-state="${isOpen ? 'open' : 'closed'}">
      <div class="announcement-head">
        <a class="announcement-pill" href="${esc(issue.html_url)}" target="_blank" rel="noopener">#${esc(num)}</a>
        <a class="announcement-title" href="${esc(issue.html_url)}" target="_blank" rel="noopener">${esc(issue.title)}</a>
        <span class="announcement-state">${isOpen ? 'Open' : 'Resolved'}</span>
      </div>
      <div class="announcement-meta">
        <time datetime="${esc(dateAttr)}">opened ${esc(rel)}</time>
      </div>
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
    const rows = (Array.isArray(issues) ? issues : []).filter(r => !r.pull_request);
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
    listEl.innerHTML = `<div class="state-box">Could not load announcements (${esc(err.message || err)}). Check the <a href="https://github.com/${esc(ANNOUNCE_REPO)}/issues?q=is%3Aissue+label%3Aincident" target="_blank" rel="noopener">incident issue list</a> directly.</div>`;
  }
}

loadAnnouncements();
setInterval(loadAnnouncements, 5 * 60 * 1000);
