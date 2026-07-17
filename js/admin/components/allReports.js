import { escapeHtml, fmtDateTime } from '../utils.js?v=2668b2f0';
import { fetchAllReports, fetchStatusCounts } from '../api/allReports.js?v=0f587828';
import { formatReportSourceLabel } from '../lib/reportSource.js?v=c366fc24';

// Summary strip of exact per-status counts above the table. Each tile is a
// button that filters the table to that status. Runs its own count queries so
// it reflects the whole table, not just the current filtered page.
async function _renderStatusCounts(session) {
  const el = document.getElementById('all-reports-status-counts');
  if (!el) return;
  let c;
  try { c = await fetchStatusCounts(session); } catch { return; }
  const tile = (n, label, cls, filterVal, meaning) =>
    `<button class="admin-stat ${cls}" data-status="${filterVal}" type="button" title="${escapeHtml(meaning)} Click to filter.">
       <span class="admin-stat-num">${(n || 0).toLocaleString()}</span>
       <span class="admin-stat-label">${label}</span>
     </button>`;
  el.innerHTML =
    tile(c.pending, 'Pending', 'admin-stat--info', 'pending', 'Waiting on the daily approval pipeline.') +
    tile(c.flagged, 'Flagged', 'admin-stat--warn', 'flagged', 'Queued for moderator review.') +
    tile(c.hidden, 'Hidden', 'admin-stat--muted', 'hidden', 'Shadow-banned, not visible to users.') +
    tile(c.approved, 'Approved', 'admin-stat--ok', 'clean', 'Visible to the public.') +
    tile(c.total, 'Total', 'admin-stat--total', '', 'All reports.');
  el.hidden = false;
}

function statusBadges(isF, isH, isP, flaggedReason) {
  // Flagged and hidden take precedence (moderator action). Pending is shown
  // only when the row is neither -- a fresh or edited report still waiting
  // for the daily approval pipeline.
  // #48: flagged_reason surfaces in the badge title attribute so admins can
  // hover the badge in the table without opening report detail.
  if (isF || isH) {
    const titleAttr = flaggedReason ? ` title="${escapeHtml(String(flaggedReason))}"` : '';
    return [
      isF ? `<span class="admin-badge admin-badge--warn"${titleAttr}>flagged</span>` : '',
      isH ? `<span class="admin-badge admin-badge--muted"${titleAttr}>hidden</span>`  : '',
    ].filter(Boolean).join(' ');
  }
  if (isP) return '<span class="admin-badge admin-badge--info">pending</span>';
  return '<span class="admin-badge admin-badge--ok">approved</span>';
}

export async function renderAllReports(session) {
  const loading     = document.getElementById('all-reports-loading');
  const empty       = document.getElementById('all-reports-empty');
  const table       = document.getElementById('all-reports-table');
  const tbody       = document.getElementById('all-reports-tbody');
  const countEl     = document.getElementById('all-reports-count');
  const searchEl    = document.getElementById('all-reports-search');
  const statusEl    = document.getElementById('all-reports-status-filter');
  const appTypeEl   = document.getElementById('all-reports-apptype-filter');
  const dateFromEl  = document.getElementById('all-reports-date-from');
  const dateToEl    = document.getElementById('all-reports-date-to');

  loading.hidden = false;
  empty.hidden   = true;
  table.hidden   = true;
  if (countEl) countEl.hidden = true;

  // Count strip runs in parallel and clicking a tile filters the table.
  _renderStatusCounts(session);
  const stripEl = document.getElementById('all-reports-status-counts');
  if (stripEl && !stripEl.dataset.wired) {
    stripEl.dataset.wired = '1';
    stripEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.admin-stat');
      if (!btn || !statusEl) return;
      statusEl.value = btn.dataset.status;
      renderAllReports(session);
    });
  }

  try {
    const q        = searchEl ? searchEl.value.trim() : '';
    const status   = statusEl ? statusEl.value : 'pending';
    const appType  = appTypeEl ? appTypeEl.value : '';
    const dateFrom = dateFromEl ? dateFromEl.value : '';
    const dateTo   = dateToEl ? dateToEl.value : '';
    const reports = await fetchAllReports(session, { search: q, status, appType, dateFrom, dateTo });

    loading.hidden = true;

    if (!reports.length) {
      empty.hidden = false;
      return;
    }

    if (countEl) {
      countEl.textContent = `${reports.length} report${reports.length !== 1 ? 's' : ''}`;
      countEl.hidden = false;
    }

    tbody.innerHTML = reports.map(r => {
      const appId   = r.app_id ? escapeHtml(String(r.app_id)) : null;
      // Public-app permalink only resolves when the report is actually
      // visible there: approved, not flagged, not hidden. For pending,
      // flagged, or hidden rows fall back to the game's report list.
      const isPublic = appId && !r.is_pending && !r.is_flagged && !r.is_hidden;
      const appLink = appId
        ? (isPublic
            ? `<a class="admin-link" href="app.html#/app/${appId}#report-r${escapeHtml(String(r.id))}" target="_blank" title="Open this report on the public page">App ${appId}</a>`
            : `<a class="admin-link" href="app.html#/app/${appId}" target="_blank" title="Open the game's report list">App ${appId}</a>`)
        : 'Unknown';
      const rid    = escapeHtml(String(r.id));
      const title  = escapeHtml(r.title || '');
      // Structural signature detection: a row is only labelled 'plugin' if
      // installation_id is set (the Deck-plugin submit path populates it;
      // the web submit path never does). Rows with source='user' but no
      // installation_id -- e.g. imported ProtonDB mirror rows -- keep
      // their raw source string so admins can spot the actual origin.
      const source  = escapeHtml(formatReportSourceLabel(r));
      const appType = escapeHtml(r.app_type || 'steam');
      const date    = escapeHtml(fmtDateTime(r.created_at));
      const uid    = r.proton_pulse_user_id || null;
      const cid    = r.client_id || null;
      const userObj = escapeHtml(JSON.stringify({ proton_pulse_user_id: uid, client_id: cid, username: uid || cid || 'anon' }));
      const userBtn = `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="view-user-detail" data-userobj='${userObj}'>Details</button>`;

      // Stash flagged_reason on the row dataset so updateAllReportsRow can
      // restore the tooltip without re-fetching the row from Supabase.
      const flaggedReasonAttr = r.flagged_reason
        ? ` data-flagged-reason="${escapeHtml(String(r.flagged_reason))}"`
        : '';
      return `<tr data-rid="${rid}" data-pending="${r.is_pending ? '1' : '0'}"${flaggedReasonAttr}>
        <td><button class="admin-link-btn" data-action="ar-view-detail" data-rid="${rid}">#${rid}</button></td>
        <td>${appLink}</td>
        <td>${title}</td>
        <td>${source}</td>
        <td>${appType}</td>
        <td>${userBtn}</td>
        <td>${date}</td>
        <td class="ar-status">${statusBadges(r.is_flagged, r.is_hidden, r.is_pending, r.flagged_reason)}</td>
      </tr>`;
    }).join('');

    table.hidden = false;
  } catch (e) {
    loading.hidden = true;
    empty.textContent = `Error: ${e.message}`;
    empty.hidden = false;
  }
}

export function updateAllReportsRow(id, isF, isH, flaggedReason, isPending) {
  const row = document.querySelector(`#all-reports-tbody tr[data-rid="${CSS.escape(String(id))}"]`);
  if (!row) return;
  // #146: callers can override the pending state when they know it
  // changed (e.g. approve). Fall back to the dataset flag otherwise.
  const isP = isPending !== undefined
    ? Boolean(isPending)
    : row.dataset.pending === '1';
  if (isPending !== undefined) row.dataset.pending = isPending ? '1' : '0';
  const statusCell  = row.querySelector('.ar-status');
  // Use the caller-provided reason if any, otherwise fall back to whatever
  // is already on the row dataset (set by the initial render). On release
  // both are cleared so the badge ends up tooltip-less.
  const reason = flaggedReason !== undefined
    ? flaggedReason
    : (row.dataset.flaggedReason || null);
  if (reason) row.dataset.flaggedReason = String(reason);
  else delete row.dataset.flaggedReason;
  if (statusCell) statusCell.innerHTML = statusBadges(isF, isH, isP, reason);
}

export function renderAllReportsDetail(report, { onAction, onBack } = {}) {
  const detail = document.getElementById('report-detail-content');
  if (!detail) return;

  const val = v => (v != null && v !== '') ? escapeHtml(String(v)) : '(not set)';
  const fields = [
    ['Report ID',       `#${report.id}`],
    // Reporter identity, admin-only, right under the Report ID. Public report
    // views anonymize the author; moderators need the real Steam username + ids
    // to review and act on a report.
    ['Steam Username',  report.steam_username ? escapeHtml(report.steam_username) : '(anonymous / no linked Steam profile)'],
    ['Steam ID',        report.steam_id ? `<a href="https://steamcommunity.com/profiles/${encodeURIComponent(report.steam_id)}" target="_blank" rel="noopener">${escapeHtml(String(report.steam_id))}</a>` : '(none)'],
    ['Client ID',       val(report.client_id)],
    ['User ID',         val(report.proton_pulse_user_id)],
    ['App ID',          val(report.app_id)],
    ['Title',           val(report.title)],
    ['Source',          report.source || report.installation_id ? escapeHtml(formatReportSourceLabel(report)) : val(report.source)],
    ['App Type',        val(report.app_type)],
    ['Rating',          val(report.rating)],
    ['Proton Version',  val(report.proton_version)],
    ['CPU',             val(report.cpu)],
    ['GPU',             val(report.gpu)],
    ['GPU Driver',      val(report.gpu_driver)],
    ['GPU Vendor',      val(report.gpu_vendor)],
    ['GPU Architecture',val(report.gpu_architecture)],
    ['RAM',             val(report.ram)],
    ['VRAM (MB)',       val(report.vram_mb)],
    ['OS',              val(report.os)],
    ['Kernel',          val(report.kernel)],
    ['Duration',        val(report.duration)],
    ['Duration (min)',  val(report.duration_minutes)],
    ['Game Owned',      val(report.game_owned)],
    ['Config Key',      val(report.config_key)],
    ['Notes',           val(report.notes)],
    ['Flagged Reason',  val(report.flagged_reason)],
    ['Flagged At',      report.flagged_at ? new Date(report.flagged_at).toLocaleString() : '(not flagged)'],
    ['Submitted',       report.created_at ? new Date(report.created_at).toLocaleString() : '?'],
    ['Updated',         report.updated_at ? new Date(report.updated_at).toLocaleString() : '(not set)'],
  ];

  const formResponsesHtml = report.form_responses
    ? `<tr><td style="font-weight:600;color:var(--muted);width:160px;vertical-align:top">Form Responses</td>
        <td><pre style="margin:0;font-size:0.78rem;white-space:pre-wrap;word-break:break-all">${escapeHtml(JSON.stringify(report.form_responses, null, 2))}</pre></td></tr>`
    : `<tr><td style="font-weight:600;color:var(--muted);width:160px">Form Responses</td><td>(none)</td></tr>`;

  const isF = report.is_flagged;
  const isH = report.is_hidden;
  const isP = report.is_pending === true;
  const rid = escapeHtml(String(report.id));
  // #148: render the full moderation toolbar at the top-right of the
  // panel and disable the buttons that do not apply to the current
  // state. Approve/Deny only make sense while pending. Flag/Hide are
  // disabled once that state is already set. Release is the inverse:
  // only valid when the row is flagged or hidden. The title attribute
  // explains the disabled reason on hover.
  const btn = (action, label, kind, disabled, disabledTitle) => {
    const d = disabled ? ' disabled' : '';
    const t = disabled && disabledTitle ? ` title="${escapeHtml(disabledTitle)}"` : '';
    return `<button class="admin-btn admin-btn--sm admin-btn--${kind}" data-action="${action}" data-rid="${rid}"${d}${t}>${label}</button>`;
  };
  const actionHtml = [
    btn('ar-approve', 'Approve', 'ok',     !isP || isF || isH, !isP ? 'Already approved' : 'Flagged or hidden -- release first'),
    btn('ar-deny',    'Deny',    'danger', !isP || isF || isH, !isP ? 'Already approved' : 'Flagged or hidden -- release first'),
    btn('ar-flag',    'Flag',    'warn',   isF,                'Already flagged'),
    btn('ar-hide',    'Hide',    'danger', isH,                'Already hidden'),
    btn('ar-release', 'Release', 'ok',    !(isF || isH),       'Nothing to release'),
  ].join(' ');

  detail.innerHTML = `
    <button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="ar-back" style="margin-bottom:12px">&#8592; Back to list</button>
    <div class="admin-card">
      <div class="ar-detail-header">
        <div class="admin-subhead" style="margin:0">Report Detail</div>
        <div id="ar-detail-actions" class="ar-detail-actions">${actionHtml}</div>
      </div>
      <div id="ar-detail-status" style="margin:10px 0">${statusBadges(isF, isH, isP, report.flagged_reason)}</div>
      <table class="admin-table" style="margin-bottom:16px">
        <tbody>
          ${fields.map(([label, value]) => {
            // Group break: put a small spacer row above Duration so the
            // hardware block and the playtime block are visually distinct
            // instead of a solid wall of rows.
            const spacer = label === 'Duration'
              ? `<tr aria-hidden="true"><td colspan="2" style="height:14px;border:none;padding:0"></td></tr>`
              : '';
            return spacer + `
            <tr>
              <td style="font-weight:600;color:var(--muted);width:160px">${escapeHtml(label)}</td>
              <td>${value}</td>
            </tr>`;
          }).join('')}
          ${formResponsesHtml}
        </tbody>
      </table>
      <div id="ar-detail-msg" style="font-size:0.8rem;margin-top:8px"></div>
    </div>`;

  detail.querySelector('[data-action="ar-back"]')?.addEventListener('click', () => {
    onBack?.();
  });

  detail.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.dataset.action === 'ar-back') return;
    // Disabled buttons should never trigger a fetch. The browser blocks the
    // click event for `disabled` <button>, but a closest() walk could land
    // here for a click on an inner element, so guard explicitly.
    if (btn.disabled) return;
    const action = btn.dataset.action;
    const id     = btn.dataset.rid;
    if (!['ar-flag','ar-hide','ar-release','ar-approve','ar-deny'].includes(action) || !id) return;
    btn.disabled = true;
    onAction?.(action, id, btn);
  });
}
