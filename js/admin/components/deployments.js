// Admin "Deployments" tab (#367). One-glance table of the last N runs
// across every workflow that can push code to a live surface -- so an
// operator (or the user right after a push) can answer "is my change on
// staging yet?" without cross-referencing gh CLI output.
//
// Data comes straight from GitHub's public workflow-runs API. The repo is
// public so no auth is needed; the 60/hr unauthed rate limit is fine for
// human-scale panel viewing. If we ever move to authed fetches we would
// use a fine-grained PAT scoped to Actions:Read.

const GH_API = 'https://api.github.com/repos/mdeguzis/proton-pulse-web/actions/runs?per_page=40';

// Every workflow that deploys somewhere users can see.
const WORKFLOW_WHITELIST = new Set([
  'Publish Shell to Cloudflare Pages',   // shell push per branch -> CF Pages
  'Deploy Cloudflare Workers',           // pp-edge-status worker
  'Build Site Data',                     // update-data pipeline (finalize deploys)
  'Deploy Cloudflare Functions',         // Supabase edge fns via deploy-functions.yml
]);

// Rows shown after whitelist filter. 15 covers a couple of days of activity
// at typical push cadence without overwhelming the mobile view.
const MAX_ROWS = 15;

// Cache to survive a tab-out/back-in without re-hitting the API on the
// 60/hr limit. sessionStorage-scoped (per tab) with a 45s TTL.
const CACHE_KEY = 'pp:admin:deployments';
const CACHE_TTL_MS = 45 * 1000;

let _refreshTimer = null;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtRelative(iso) {
  if (!iso) return '';
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '';
  const diffSec = Math.floor((Date.now() - d) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
  return `${Math.floor(diffSec / 86400)} d ago`;
}

// Infer where the run deployed. Cannot always tell without inspecting job
// steps (Build Site Data can succeed with the deploy skipped), so mark
// ambiguous entries and let the linked GH run page be the source of truth.
function inferTarget(run) {
  const branch = run.head_branch;
  const name = run.name;
  if (name === 'Publish Shell to Cloudflare Pages') {
    return branch === 'staging' ? 'staging.proton-pulse.com' : 'www.proton-pulse.com';
  }
  if (name === 'Deploy Cloudflare Workers') {
    return 'pp-edge-status worker';
  }
  if (name === 'Deploy Cloudflare Functions') {
    return 'supabase edge fns';
  }
  if (name === 'Build Site Data') {
    // Dispatch inputs decide staging vs prod; not exposed on the run JSON.
    return `pipeline (${branch})`;
  }
  return '?';
}

function conclusionBadge(run) {
  const c = run.conclusion;
  const s = run.status;
  if (s !== 'completed') return `<span class="admin-log-level" style="color:#6a95d1">${esc(s || '?')}</span>`;
  if (c === 'success')   return `<span class="admin-log-level" style="color:#3aaa5b">success</span>`;
  if (c === 'failure')   return `<span class="admin-log-level" style="color:#d0453f">failure</span>`;
  if (c === 'cancelled') return `<span class="admin-log-level" style="color:#8a8f98">cancelled</span>`;
  if (c === 'skipped')   return `<span class="admin-log-level" style="color:#8a8f98">skipped</span>`;
  return `<span class="admin-log-level" style="color:#d98b1f">${esc(c || '?')}</span>`;
}

async function fetchRuns() {
  // Cache read: only trust the cache when fresh AND non-empty. A cached
  // empty result from a failed fetch would stick for 45s and hide new runs.
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached && Array.isArray(cached.runs) && cached.runs.length
        && (Date.now() - (cached.ts || 0)) < CACHE_TTL_MS) {
        return cached.runs;
      }
    }
  } catch { /* ignore */ }

  const res = await fetch(GH_API, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const data = await res.json();
  const runs = (data.workflow_runs || [])
    .filter((r) => WORKFLOW_WHITELIST.has(r.name))
    .slice(0, MAX_ROWS);
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), runs }));
  } catch { /* quota */ }
  return runs;
}

function renderRow(run) {
  const sha = (run.head_sha || '').slice(0, 7);
  const shaLink = run.head_sha
    ? `<a href="https://github.com/mdeguzis/proton-pulse-web/commit/${esc(run.head_sha)}" target="_blank" rel="noopener">${esc(sha)}</a>`
    : esc(sha);
  return `
    <tr class="admin-log-row">
      <td class="admin-log-time" title="${esc(run.created_at || '')}">${fmtRelative(run.created_at)}</td>
      <td>${conclusionBadge(run)}</td>
      <td class="admin-log-module">${esc(run.name)}</td>
      <td class="admin-log-module">${esc(run.head_branch || '')}</td>
      <td class="admin-log-module">${shaLink}</td>
      <td class="admin-log-module">${esc(inferTarget(run))}</td>
      <td><a href="${esc(run.html_url)}" target="_blank" rel="noopener">run &rarr;</a></td>
    </tr>`;
}

function renderTable(runs) {
  if (!runs.length) {
    return '<div class="admin-loading">No recent deploy-related runs found.</div>';
  }
  return `
    <div class="admin-toolbar">
      <button id="admin-deploy-refresh" class="admin-btn" type="button">Refresh</button>
      <label class="admin-checkbox">
        <input type="checkbox" id="admin-deploy-autorefresh" checked />
        Auto-refresh (60s)
      </label>
      <span class="admin-log-meta" style="margin-left:auto">${runs.length} runs</span>
    </div>
    <div class="admin-log-scroller">
      <table class="admin-log-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Status</th>
            <th>Workflow</th>
            <th>Branch</th>
            <th>SHA</th>
            <th>Target</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>${runs.map(renderRow).join('')}</tbody>
      </table>
    </div>
    <div class="admin-log-meta">
      Rate limit: unauthenticated GitHub API (60/hr per IP). Cached 45 s.
      Ambiguous "pipeline" rows can deploy to either staging or prod
      depending on dispatch inputs -- click the run link to see the
      staging_with_* / deploy_target values used.
    </div>
  `;
}

async function reload(host) {
  const contentSel = '.admin-log-scroller';
  const prev = host.querySelector(contentSel);
  if (prev) prev.style.opacity = '0.5';
  try {
    // Bypass the cache for a manual refresh (freshness > rate-limit-friendly).
    try { sessionStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    const runs = await fetchRuns();
    host.innerHTML = renderTable(runs);
    wireHost(host);
  } catch (err) {
    if (prev) prev.style.opacity = '';
    host.innerHTML = `<div class="admin-error">Failed to load: ${esc(err.message || err)}</div>`;
  }
}

function wireHost(host) {
  host.querySelector('#admin-deploy-refresh')?.addEventListener('click', () => reload(host));
  const auto = host.querySelector('#admin-deploy-autorefresh');
  if (auto) {
    auto.addEventListener('change', (e) => {
      if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
      if (e.target.checked) _refreshTimer = setInterval(() => reload(host), 60 * 1000);
    });
    if (auto.checked) {
      if (_refreshTimer) clearInterval(_refreshTimer);
      _refreshTimer = setInterval(() => reload(host), 60 * 1000);
    }
  }
}

export async function renderDeploymentsTab() {
  const host = document.getElementById('tab-deployments');
  if (!host) return;
  host.innerHTML = '<div class="admin-loading">Loading recent deployments...</div>';
  try {
    const runs = await fetchRuns();
    host.innerHTML = renderTable(runs);
    wireHost(host);
  } catch (err) {
    host.innerHTML = `<div class="admin-error">Failed to load deployments: ${esc(err.message || err)}</div>`;
  }
}
