// Your Systems (Block 1): server-side uploaded hardware systems list.
// Renders the systems table, handles default toggle, label rename, delete,
// and auto-fill of Block 2 from the default system.
import { MYHW_KEYS, SupaAuth } from '../config.js?v=87cd0f3d';
import {
  getProtonPulseUserIdFromSession, parseSteamSystemInfo, inferGpuVendor,
  parseUploadedSystem, isGenericSystemLabel, inferSystemLabel,
  summarizeSystem, escapeHtml, formatSystemUpdated,
} from '../utils.js?v=9a539c02';
import {
  listUserSystems, setDefaultSystem, clearDefaultSystem,
  updateSystemLabel, deleteSystem,
} from '../api/systems.js?v=770d14b7';

/**
 * Initialise the Systems pane. Call once after DOM is ready.
 *
 * @param {object} ctx
 * @param {HTMLElement|null} ctx.systemsTable
 * @param {HTMLElement|null} ctx.systemsTbody
 * @param {HTMLElement|null} ctx.systemsEmpty
 * @param {HTMLElement|null} ctx.systemsLoading
 * @param {HTMLElement|null} ctx.systemsStatus
 * @param {HTMLElement|null} ctx.systemsRefresh
 * @param {HTMLElement|null} ctx.addSysBtn
 * @param {object} hw  The myHardware API returned by initMyHardware
 * @param {function} hw.setLocalHardwareFromParsed
 * @param {function} hw.flashStatus
 * @param {function} hw.setMyHardwarePane
 * @returns {{ refreshSystems: function }}
 */
export function initSystems(ctx, hw) {
  const {
    systemsTable, systemsTbody, systemsEmpty,
    systemsLoading, systemsStatus, systemsRefresh, addSysBtn,
  } = ctx;

  let systemsCache = [];

  // ── Internal helpers ─────────────────────────────────────────────────────

  function showSystemsStatus(msg, ok) {
    if (!systemsStatus) return;
    systemsStatus.textContent = msg;
    systemsStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { systemsStatus.textContent = ''; }, 2500);
  }

  function renderSystems(rows) {
    systemsCache = rows || [];
    systemsLoading.hidden = true;
    if (!rows || rows.length === 0) {
      systemsTable.hidden = true;
      systemsEmpty.hidden = false;
      return;
    }
    systemsEmpty.hidden = true;
    systemsTable.hidden = false;

    systemsTbody.innerHTML = rows.map(r => {
      const parsed = parseUploadedSystem(r);
      const displayLabel = isGenericSystemLabel(r.label) ? inferSystemLabel(r) : (r.label || 'Uploaded system');
      const summary = summarizeSystem(parsed);
      const detailRows = [
        ['CPU', parsed.cpu],
        ['GPU', parsed.gpu],
        ['GPU vendor', parsed.gpuVendor ? ({ nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[parsed.gpuVendor] || parsed.gpuVendor) : ''],
        ['GPU driver', parsed.gpuDriver],
        ['RAM', parsed.ram],
        ['VRAM', parsed.vramMb ? `${parsed.vramMb} MB` : ''],
        ['OS', [parsed.os, parsed.osVersion].filter(Boolean).join(' ')],
        ['Kernel', parsed.kernel],
      ].filter(([, value]) => value);
      return `
      <tr data-device-id="${escapeHtml(r.device_id)}">
        <td>
          <div class="profile-systems-label-stack">
            <input type="text" class="profile-systems-label-input"
              data-role="label" value="${escapeHtml(displayLabel)}" maxlength="80">
            <div class="profile-systems-summary">${escapeHtml(summary)}</div>
          </div>
        </td>
        <td>${escapeHtml(formatSystemUpdated(r.updated_at))}</td>
        <td class="col-default">
          <label class="profile-systems-default-toggle" title="Set as default">
            <input type="checkbox" data-role="default" ${r.is_default ? 'checked' : ''}>
            <span class="profile-systems-default-switch" aria-hidden="true"></span>
          </label>
        </td>
        <td class="col-action">
          <div class="profile-configs-actions">
            <button type="button" class="profile-configs-action profile-configs-view-link" data-role="toggle-details" aria-expanded="false">View</button>
            <a href="system-edit.html?device=${encodeURIComponent(r.device_id)}" class="profile-configs-action profile-configs-edit-btn">Edit</a>
            <button type="button" class="profile-configs-action profile-configs-delete-btn" data-role="delete">Delete</button>
          </div>
        </td>
      </tr>
      <tr class="profile-systems-details-row" data-details-for="${escapeHtml(r.device_id)}" hidden>
        <td colspan="4">
          <div class="profile-systems-details-card">
            <div class="profile-systems-details-grid">
              ${detailRows.map(([label, value]) => `
                <div class="profile-systems-detail-item">
                  <span class="profile-systems-detail-label">${escapeHtml(label)}</span>
                  <span class="profile-systems-detail-value">${escapeHtml(value)}</span>
                </div>`).join('')}
            </div>
            <div class="profile-systems-detail-note">
              ${r.is_default
                ? 'This default uploaded system currently seeds the Web prefill tab and submit form until you edit those values locally.'
                : 'Mark this as default to use it as the starting source for the Web prefill tab and submit form.'}
            </div>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  async function refreshSystems() {
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) {
      systemsLoading.hidden = true;
      systemsTable.hidden = true;
      systemsEmpty.hidden = false;
      systemsEmpty.textContent = 'Sign in with Steam to see your uploaded systems.';
      return;
    }
    systemsLoading.hidden = false;
    try {
      let rows = await listUserSystems(protonPulseUserId, s);
      const genericRows = rows.filter((row) => isGenericSystemLabel(row.label));
      if (genericRows.length) {
        await Promise.allSettled(genericRows.map((row) => {
          const nextLabel = inferSystemLabel(row);
          return updateSystemLabel(protonPulseUserId, row.device_id, nextLabel, s);
        }));
        rows = rows.map((row) => isGenericSystemLabel(row.label)
          ? { ...row, label: inferSystemLabel(row) }
          : row);
      }
      renderSystems(rows);
    } catch (e) {
      systemsLoading.hidden = true;
      showSystemsStatus(e.message || 'Failed to load systems', false);
    }
  }

  function askReplaceLocalFrom(row) {
    const parsed = parseSteamSystemInfo(row.sysinfo_text || '');
    if (Object.keys(parsed).length === 0) return;
    const label = isGenericSystemLabel(row.label) ? inferSystemLabel(row) : (row.label || 'this system');
    const ok = window.confirm(`Replace your local pre-fill values with "${label}"?`);
    if (!ok) return;
    if (parsed.gpu && !parsed.gpuVendor) {
      const v = inferGpuVendor(parsed.gpu);
      if (v) parsed.gpuVendor = v;
    }
    hw.setLocalHardwareFromParsed(parsed, {
      type: 'uploaded-default',
      label,
      deviceId: row.device_id,
    });
    hw.flashStatus('Local values updated from default system', true);
  }

  async function handleSystemsClick(ev) {
    const tr  = ev.target.closest('tr[data-device-id]');
    const btn = ev.target.closest('button[data-role]');
    const defToggle = ev.target.closest('input[data-role="default"]');
    if (!tr || (!btn && !defToggle)) return;
    const deviceId = tr.dataset.deviceId;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;

    try {
      if (defToggle) {
        if (defToggle.checked) {
          await setDefaultSystem(protonPulseUserId, deviceId, s);
          await refreshSystems();
          const row = systemsCache.find(r => r.device_id === deviceId);
          if (row) askReplaceLocalFrom(row);
          hw.setMyHardwarePane('local');
        } else {
          await clearDefaultSystem(protonPulseUserId, s);
          await refreshSystems();
          hw.flashStatus('Default cleared', true);
        }
        return;
      }
      if (btn.dataset.role === 'toggle-details') {
        const detailRow = Array.from(systemsTbody?.querySelectorAll('tr[data-details-for]') || [])
          .find((row) => row.getAttribute('data-details-for') === deviceId);
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        btn.textContent = expanded ? 'View' : 'Hide';
        if (detailRow) detailRow.hidden = expanded;
        return;
      }
      if (btn.dataset.role === 'delete') {
        if (!window.confirm('Delete this system? The plugin will re-create it next time you upload.')) return;
        await deleteSystem(protonPulseUserId, deviceId, s);
        await refreshSystems();
      }
    } catch (e) {
      showSystemsStatus(e.message || 'Action failed', false);
    }
  }

  async function handleSystemsLabelBlur(ev) {
    const input = ev.target.closest('input[data-role="label"]');
    if (!input) return;
    const tr = input.closest('tr[data-device-id]');
    const deviceId = tr?.dataset.deviceId;
    if (!deviceId) return;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;
    try {
      const currentRow = systemsCache.find((row) => row.device_id === deviceId);
      const nextLabel = input.value.trim() || inferSystemLabel(currentRow || {});
      input.value = nextLabel;
      await updateSystemLabel(protonPulseUserId, deviceId, nextLabel, s);
      showSystemsStatus('Saved', true);
    } catch (e) {
      showSystemsStatus(e.message || 'Save failed', false);
    }
  }

  async function autoFillFromDefaultIfEmpty() {
    const anyLocal = Object.values(MYHW_KEYS).some(k => localStorage.getItem(k));
    if (anyLocal) return;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;
    try {
      const rows = await listUserSystems(protonPulseUserId, s);
      const def = rows.find(r => r.is_default);
      if (!def) return;
      const parsed = parseUploadedSystem(def);
      const label = isGenericSystemLabel(def.label) ? inferSystemLabel(def) : (def.label || 'your system');
      hw.setLocalHardwareFromParsed(parsed, {
        type: 'uploaded-default',
        label,
        deviceId: def.device_id,
      });
      if (Object.keys(parsed).length > 0) {
        hw.flashStatus(`Loaded hardware from "${label}"`, true);
      }
    } catch {
      // non-fatal, just leave Block 2 empty
    }
  }

  // ── Wire event listeners ─────────────────────────────────────────────────

  systemsTable?.addEventListener('click', handleSystemsClick);
  systemsTable?.addEventListener('focusout', handleSystemsLabelBlur);
  systemsRefresh?.addEventListener('click', () => { void refreshSystems(); });

  if (addSysBtn) {
    addSysBtn.addEventListener('click', () => {
      window.location.href = 'system-edit.html';
    });
  }

  // Initial fetch
  void refreshSystems();
  void autoFillFromDefaultIfEmpty();

  // ── Public API ───────────────────────────────────────────────────────────

  return { refreshSystems };
}
