// Edit dialogs for the profile page: the report editor and cloud-config
// editor modals, plus their history panel renderer. Builds DOM and calls the
// api layer; takes no closure state from main.
import {
  escapeHtml, formatSystemUpdated, enabledVarsToText, textToEnabledVars,
} from '../utils.js';
import {
  fetchCloudConfig, patchCloudConfig, fetchFullUserConfig,
  fetchReportHistory, patchUserConfig,
} from '../api/configs.js';

export let _cloudEditModal = null;
export function getCloudEditModal() {
  if (_cloudEditModal) return _cloudEditModal;
  _cloudEditModal = document.createElement('dialog');
  _cloudEditModal.className = 'edit-report-modal';
  _cloudEditModal.innerHTML = `
    <h2 class="edit-report-title">Edit Cloud Config</h2>
    <div class="edit-report-fields">
      <label class="edit-report-label">Proton Version
        <input class="edit-report-input" type="text" name="proton_version" placeholder="e.g. Proton 9.0">
      </label>
      <label class="edit-report-label">Launch Options
        <input class="edit-report-input" type="text" name="launch_options" placeholder="e.g. DXVK_HUD=1 %command%">
      </label>
      <label class="edit-report-label" title="One VAR=value per line">Environment Variables
        <textarea class="edit-report-input" name="enabled_vars" rows="4" placeholder="DXVK_FRAME_RATE=60&#10;PROTON_USE_WINED3D=1"></textarea>
      </label>
    </div>
    <div class="edit-report-status"></div>
    <div class="edit-report-actions">
      <button type="button" class="edit-report-cancel">Cancel</button>
      <button type="button" class="edit-report-save">Save Changes</button>
    </div>
  `;
  document.body.appendChild(_cloudEditModal);
  _cloudEditModal.querySelector('.edit-report-cancel').addEventListener('click', () => _cloudEditModal.close());
  return _cloudEditModal;
}
export async function showEditCloudConfigModal(protonPulseUserId, appId, session, onSaved) {
  const modal = getCloudEditModal();
  const status = modal.querySelector('.edit-report-status');
  const saveBtn = modal.querySelector('.edit-report-save');
  status.textContent = 'Loading config...';
  saveBtn.disabled = true;
  modal.showModal();

  let record;
  try {
    record = await fetchCloudConfig(protonPulseUserId, appId, session);
    console.debug('[profile] showEditCloudConfigModal: fetched', { appId, found: !!record });
  } catch (e) {
    status.textContent = e.message || 'Failed to load config';
    console.warn('[profile] showEditCloudConfigModal: fetch failed', { appId, error: String(e) });
    return;
  }
  if (!record) { status.textContent = 'Config not found.'; return; }

  status.textContent = '';
  saveBtn.disabled = false;
  const cfg = record.config || {};
  modal.querySelector('[name="proton_version"]').value = cfg.protonVersion || '';
  modal.querySelector('[name="launch_options"]').value = cfg.launchOptions || '';
  modal.querySelector('[name="enabled_vars"]').value = enabledVarsToText(cfg.enabledVars);

  saveBtn.onclick = async () => {
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;
    status.textContent = '';
    const newConfig = {
      ...cfg,
      protonVersion:  modal.querySelector('[name="proton_version"]').value.trim(),
      launchOptions:  modal.querySelector('[name="launch_options"]').value.trim(),
      enabledVars:    textToEnabledVars(modal.querySelector('[name="enabled_vars"]').value),
    };
    try {
      await patchCloudConfig(protonPulseUserId, appId, newConfig, session);
      console.debug('[profile] showEditCloudConfigModal: saved', { appId });
      modal.close();
      onSaved?.();
    } catch (e) {
      status.textContent = e.message || 'Save failed';
      console.warn('[profile] showEditCloudConfigModal: save failed', { appId, error: String(e) });
    } finally {
      saveBtn.textContent = 'Save Changes';
      saveBtn.disabled = false;
    }
  };
}
export let _editModal = null;
export function getEditModal() {
  if (_editModal) return _editModal;
  _editModal = document.createElement('dialog');
  _editModal.className = 'edit-report-modal';
  _editModal.innerHTML = `
    <h2 class="edit-report-title">Edit Report</h2>
    <div class="edit-report-fields">
      <label class="edit-report-label">Rating
        <select class="edit-report-input" name="rating">
          <option value="platinum">Platinum</option>
          <option value="gold">Gold</option>
          <option value="silver">Silver</option>
          <option value="bronze">Bronze</option>
          <option value="borked">Borked</option>
        </select>
      </label>
      <label class="edit-report-label">Proton Version
        <input class="edit-report-input" type="text" name="proton_version" placeholder="e.g. Proton 9.0">
      </label>
      <label class="edit-report-label">OS
        <input class="edit-report-input" type="text" name="os" placeholder="e.g. SteamOS 3.6">
      </label>
      <label class="edit-report-label">Notes
        <textarea class="edit-report-input" name="notes" rows="4" placeholder="Optional notes about your experience"></textarea>
      </label>
      <label class="edit-report-label">Launch Options
        <input class="edit-report-input" type="text" name="config_key" placeholder="e.g. DXVK_HUD=1 %command%">
      </label>
    </div>
    <div class="edit-report-status"></div>
    <div class="edit-report-history-section">
      <button type="button" class="edit-report-history-toggle">Show edit history</button>
      <div class="edit-report-history-panel" hidden></div>
    </div>
    <div class="edit-report-actions">
      <button type="button" class="edit-report-cancel">Cancel</button>
      <button type="button" class="edit-report-save">Save Changes</button>
    </div>
  `;
  document.body.appendChild(_editModal);
  _editModal.querySelector('.edit-report-cancel').addEventListener('click', () => _editModal.close());
  return _editModal;
}

export function renderHistoryPanel(entries) {
  if (!entries.length) return '<p class="edit-report-history-empty">No edit history yet.</p>';
  return entries.map(e => {
    const date = formatSystemUpdated(e.recorded_at);
    const parts = [
      e.rating       ? `<span class="hist-field">Rating: <b>${escapeHtml(e.rating)}</b></span>`               : '',
      e.proton_version ? `<span class="hist-field">Proton: <b>${escapeHtml(e.proton_version)}</b></span>`    : '',
      e.os           ? `<span class="hist-field">OS: <b>${escapeHtml(e.os)}</b></span>`                       : '',
      e.config_key   ? `<span class="hist-field">Launch opts: <b>${escapeHtml(e.config_key)}</b></span>`      : '',
      e.notes        ? `<span class="hist-field hist-notes">Notes: ${escapeHtml(e.notes)}</span>`             : '',
    ].filter(Boolean).join('');
    return `<div class="edit-report-history-entry"><span class="hist-date">${escapeHtml(date)}</span>${parts}</div>`;
  }).join('');
}

export async function showEditReportModal(reportId, session, onSaved) {
  const modal = getEditModal();
  const status = modal.querySelector('.edit-report-status');
  const saveBtn = modal.querySelector('.edit-report-save');
  const histToggle = modal.querySelector('.edit-report-history-toggle');
  const histPanel = modal.querySelector('.edit-report-history-panel');
  status.textContent = 'Loading report...';
  saveBtn.disabled = true;
  histPanel.hidden = true;
  histPanel.innerHTML = '';
  histToggle.textContent = 'Show edit history';
  modal.showModal();

  let record;
  try {
    record = await fetchFullUserConfig(reportId, session);
    console.debug('[profile] showEditReportModal: fetched report', { reportId, found: !!record });
  } catch (e) {
    status.textContent = e.message || 'Failed to load report';
    console.warn('[profile] showEditReportModal: fetch failed', { reportId, error: String(e) });
    return;
  }
  if (!record) { status.textContent = 'Report not found.'; return; }

  status.textContent = '';
  saveBtn.disabled = false;
  modal.querySelector('[name="rating"]').value = record.rating || 'gold';
  modal.querySelector('[name="proton_version"]').value = record.proton_version || '';
  modal.querySelector('[name="os"]').value = record.os || '';
  modal.querySelector('[name="notes"]').value = record.notes || '';
  modal.querySelector('[name="config_key"]').value = record.config_key || '';

  let histLoaded = false;
  histToggle.onclick = async () => {
    const open = !histPanel.hidden;
    histPanel.hidden = open;
    histToggle.textContent = open ? 'Show edit history' : 'Hide edit history';
    if (!open && !histLoaded) {
      histPanel.textContent = 'Loading...';
      try {
        const entries = await fetchReportHistory(reportId, session);
        histPanel.innerHTML = renderHistoryPanel(entries);
        histLoaded = true;
        console.debug('[profile] showEditReportModal: history loaded', { reportId, count: entries.length });
      } catch (e) {
        histPanel.textContent = e.message || 'Failed to load history';
        console.warn('[profile] showEditReportModal: history fetch failed', { reportId, error: String(e) });
      }
    }
  };

  saveBtn.onclick = async () => {
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;
    status.textContent = '';
    const fields = {
      rating:         modal.querySelector('[name="rating"]').value,
      proton_version: modal.querySelector('[name="proton_version"]').value.trim() || null,
      os:             modal.querySelector('[name="os"]').value.trim() || null,
      notes:          modal.querySelector('[name="notes"]').value.trim() || null,
      config_key:     modal.querySelector('[name="config_key"]').value.trim() || null,
    };
    try {
      await patchUserConfig(reportId, fields, session);
      console.debug('[profile] showEditReportModal: saved', { reportId, fields });
      modal.close();
      onSaved?.();
    } catch (e) {
      status.textContent = e.message || 'Save failed';
      console.warn('[profile] showEditReportModal: save failed', { reportId, error: String(e) });
    } finally {
      saveBtn.textContent = 'Save Changes';
      saveBtn.disabled = false;
    }
  };
}
