// My Reports section: fetches published + cloud-synced configs, renders the
// table, and handles publish/unpublish/delete/edit actions.
import { SupaAuth, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js?v=87cd0f3d';
import {
  getProtonPulseUserIdFromSession, escapeHtml, formatSystemUpdated,
  getWebClientIdProfile, getMyReportBadges, flaggedMessageHtml,
  mergeMyReportRows,
} from '../utils.js?v=78ac95ab';
import {
  fetchMyUserConfigs, fetchMyCloudConfigs, deleteMyReportsEverywhere,
  unpublishReport,
} from '../api/configs.js?v=0c5650ed';
import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';
import { showEditCloudConfigModal, showEditReportModal } from './edit-modals.js?v=79558c3c';

/**
 * Initialise the My Reports pane. Call once after DOM is ready.
 *
 * @param {object} ctx
 * @param {HTMLElement|null} ctx.myConfigsTable
 * @param {HTMLElement|null} ctx.myConfigsTbody
 * @param {HTMLElement|null} ctx.myConfigsEmpty
 * @param {HTMLElement|null} ctx.myConfigsLoading
 * @param {HTMLElement|null} ctx.myConfigsStatus
 * @param {HTMLElement|null} ctx.myConfigsRefresh
 * @returns {{ refreshMyConfigs: function }}
 */
export function initMyReports(ctx) {
  const {
    myConfigsTable, myConfigsTbody, myConfigsEmpty,
    myConfigsLoading, myConfigsStatus, myConfigsRefresh,
    myConfigsSearch,
  } = ctx;

  let allRows = [];
  // #152: paginate My Reports so a user with hundreds of reports does not
  // dump the whole list into one DOM render. 15 per page; page numbers
  // live in the section title right of the Refresh button.
  const PAGE_SIZE = 15;
  let currentPage = 1;
  const myConfigsPager = document.getElementById('my-configs-pager');

  // ── Internal helpers ─────────────────────────────────────────────────────

  function showMyConfigsStatus(msg, ok) {
    if (ok) window.ppToast?.success(msg); else window.ppToast?.error(msg);
  }

  function renderMyConfigs(rows) {
    myConfigsLoading.hidden = true;
    allRows = rows || [];
    currentPage = 1;
    applySearch();
  }

  function renderPager(totalPages) {
    if (!myConfigsPager) return;
    if (totalPages <= 1) {
      myConfigsPager.hidden = false;
      myConfigsPager.innerHTML = `<span class="profile-pager-num profile-pager-num--active">1</span>`;
      return;
    }
    myConfigsPager.hidden = false;
    const buttons = [];
    for (let p = 1; p <= totalPages; p++) {
      const active = p === currentPage ? ' profile-pager-num--active' : '';
      buttons.push(`<button type="button" class="profile-pager-num${active}" data-page="${p}">${p}</button>`);
    }
    myConfigsPager.innerHTML = buttons.join('');
  }

  function applySearch() {
    const q = (myConfigsSearch?.value || '').trim().toLowerCase();
    const filtered = q ? allRows.filter(r => {
      const hay = [r.title, r.app_id, r.rating, r.os, r.gpu, r.notes].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    }) : allRows;
    if (!filtered.length) {
      myConfigsTable.hidden = true;
      myConfigsEmpty.hidden = false;
      myConfigsEmpty.textContent = q ? 'No reports match your search.' : 'Nothing synced yet.';
      if (myConfigsPager) myConfigsPager.hidden = true;
      return;
    }
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    const rows = filtered.slice(start, start + PAGE_SIZE);
    renderPager(totalPages);
    myConfigsEmpty.hidden = true;
    myConfigsTable.hidden = false;

    myConfigsTbody.innerHTML = rows.map(row => {
      const appLink = `app.html#/app/${encodeURIComponent(row.app_id)}`;
      const reportAnchor = row.published_id ? `${appLink}#report-r${row.published_id}` : null;
      const viewHref = reportAnchor || appLink;
      const name = row.title || `App ${row.app_id}`;
      const badges = getMyReportBadges(row).map((badge) => (
        `<span class="profile-configs-badge profile-configs-badge--${escapeHtml(badge.tone)}"${badge.title ? ` title="${escapeHtml(badge.title)}"` : ''}>${escapeHtml(badge.label)}</span>`
      )).join('');
      const flaggedNote = row.flagged
        ? `<details class="profile-configs-flagged-details">
            <summary>Why was this flagged?</summary>
            <p>${flaggedMessageHtml(row.flagged_reason)}</p>
          </details>`
        : '';
      const isLive = row.published_id && !row.pending;
      const actions = [
        isLive
          ? `<a class="profile-configs-view-link" href="${escapeHtml(viewHref)}">View</a>`
          : `<span class="profile-configs-view-link profile-configs-view-disabled" title="Not published yet">View</span>`,
        row.cloud && row.unpublished
          ? `<a class="profile-configs-action profile-configs-publish-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&fromCloud=1&return=profile.html" target="_blank" rel="noopener">Publish</a>`
          : '',
        row.published_id
          ? `<button type="button" class="profile-configs-action profile-configs-unpublish-btn" data-published-id="${escapeHtml(String(row.published_id))}">${row.pending ? 'Cancel' : 'Unpublish'}</button>`
          : '',
        row.published_id
          ? `<a class="profile-configs-action profile-configs-edit-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&edit=${escapeHtml(String(row.published_id))}&return=profile.html" target="_blank" rel="noopener">Edit</a>`
          : row.cloud
            ? `<a class="profile-configs-action profile-configs-edit-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&fromCloud=1&return=profile.html" target="_blank" rel="noopener">Edit</a>`
            : '',
        `<button type="button" class="profile-configs-action profile-configs-delete-btn" data-app-id="${escapeHtml(String(row.app_id))}">Delete</button>`,
      ].filter(Boolean).join('');
      return `
        <tr data-app-id="${escapeHtml(String(row.app_id))}">
          <td>
            <a href="${escapeHtml(appLink)}" class="profile-configs-game-link">${escapeHtml(name)}</a>
            <div class="profile-configs-appid">App ${escapeHtml(String(row.app_id))}${row.published_id ? ` · Report #${row.published_id}` : ''}</div>
          </td>
          <td>${escapeHtml(row.rating || '—')}</td>
          <td><div class="profile-configs-status">${badges}</div>${flaggedNote}</td>
          <td>${escapeHtml(formatSystemUpdated(row.updated_at))}</td>
          <td class="col-action"><div class="profile-configs-actions">${actions}</div></td>
        </tr>`;
    }).join('');
  }

  async function refreshMyConfigs() {
    const s = await SupaAuth.getSession();
    if (!s?.user) {
      myConfigsLoading.hidden = true;
      myConfigsTable.hidden   = true;
      myConfigsEmpty.hidden   = false;
      myConfigsEmpty.textContent = 'Sign in with Steam to see your reports and cloud-synced configs.';
      return;
    }
    myConfigsLoading.hidden = false;
    myConfigsEmpty.hidden   = true;
    try {
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      const cid  = getWebClientIdProfile();
      const [[publishedRows, cloudRows], searchIndex] = await Promise.all([
        Promise.all([
          fetchMyUserConfigs(protonPulseUserId, cid, s),
          fetchMyCloudConfigs(protonPulseUserId, s),
        ]),
        dataUrl('search-index.json').then(u => fetch(u)).then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      const merged = mergeMyReportRows(publishedRows, cloudRows);
      if (Array.isArray(searchIndex) && searchIndex.length) {
        const titleMap = new Map(searchIndex.map(([id, t]) => [String(id), t]));
        for (const row of merged) {
          if (!row.title || /^App \d+$/.test(row.title)) {
            const resolved = titleMap.get(String(row.app_id));
            if (resolved) row.title = resolved;
          }
        }
      }
      // Check approval status for published reports
      try {
        const approvalsRes = await fetch(
          `${SUPABASE_URL}/rest/v1/report_approvals?select=report_id,approval_hash`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
        );
        if (approvalsRes.ok) {
          const approvals = await approvalsRes.json();
          const approvalMap = new Map(approvals.map(a => [a.report_id, a.approval_hash]));
          for (const row of merged) {
            if (row.published_id && !approvalMap.has(row.published_id)) {
              row.pending = true;
            }
          }
        }
      } catch {}
      renderMyConfigs(merged);
    } catch (e) {
      myConfigsLoading.hidden = true;
      showMyConfigsStatus(e.message || 'Failed to load', false);
    }
  }

  // ── Wire event listeners ─────────────────────────────────────────────────

  myConfigsRefresh?.addEventListener('click', () => { void refreshMyConfigs(); });

  const searchClear = document.getElementById('my-configs-search-clear');
  myConfigsSearch?.addEventListener('input', () => {
    currentPage = 1;
    applySearch();
    if (searchClear) searchClear.hidden = !myConfigsSearch.value;
  });
  searchClear?.addEventListener('click', () => {
    if (myConfigsSearch) { myConfigsSearch.value = ''; myConfigsSearch.focus(); }
    searchClear.hidden = true;
    currentPage = 1;
    applySearch();
  });

  // #152: pager clicks. Delegate so we do not have to rewire on every
  // re-render of the page-number buttons.
  myConfigsPager?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[data-page]') : null;
    if (!btn) return;
    const next = Number(btn.dataset.page);
    if (!Number.isFinite(next) || next === currentPage) return;
    currentPage = next;
    applySearch();
    myConfigsTable?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  myConfigsTbody?.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.closest('.profile-configs-publish-btn, .profile-configs-delete-btn, .profile-configs-edit-btn, .profile-configs-unpublish-btn');
    if (!(action instanceof HTMLElement)) return;

    void (async () => {
      const s = await SupaAuth.getSession();
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      const cid = getWebClientIdProfile();

      if (action.classList.contains('profile-configs-edit-btn')) {
        const reportId    = action.dataset.reportId;
        const cloudAppId  = action.dataset.cloudAppId;
        if (reportId) {
          void showEditReportModal(reportId, s, async () => {
            showMyConfigsStatus('Report updated', true);
            await refreshMyConfigs();
          });
        } else if (cloudAppId) {
          void showEditCloudConfigModal(protonPulseUserId, cloudAppId, s, async () => {
            showMyConfigsStatus('Config updated', true);
            await refreshMyConfigs();
          });
        }
        return;
      }

      if (action.classList.contains('profile-configs-unpublish-btn')) {
        const publishedId = action.dataset.publishedId;
        if (!publishedId) return;
        if (!window.confirm('Remove this report from the public game page? Your cloud config will be kept.')) return;
        action.textContent = 'Unpublishing...';
        await unpublishReport(s, publishedId);
        showMyConfigsStatus('Unpublished', true);
        await refreshMyConfigs();
        return;
      }

      const appId = action.dataset.appId;
      if (!appId) return;

      if (!action.classList.contains('profile-configs-delete-btn')) return;
      if (!window.confirm('Delete this report/config from Proton Pulse?')) return;
      action.textContent = 'Deleting...';
      await deleteMyReportsEverywhere(protonPulseUserId, cid, appId, s);
      showMyConfigsStatus('Deleted', true);
      await refreshMyConfigs();
    })().catch((err) => {
      showMyConfigsStatus(err?.message || 'Action failed', false);
      void refreshMyConfigs();
    });
  });

  // Initial fetch
  void refreshMyConfigs();

  // ── Public API ───────────────────────────────────────────────────────────

  return { refreshMyConfigs };
}
