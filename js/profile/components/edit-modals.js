// Edit dialogs for the profile page: the report editor and cloud-config
// editor modals, plus their history panel renderer. Builds DOM and calls the
// api layer; takes no closure state from main.
import {
  escapeHtml, formatSystemUpdated, enabledVarsToText, textToEnabledVars,
  parseUploadedSystem, isGenericSystemLabel, inferSystemLabel,
} from '../utils.js?v=0adb6340';
import {
  fetchCloudConfig, patchCloudConfig, fetchFullUserConfig,
  fetchReportHistory, patchUserConfig,
} from '../api/configs.js?v=a51234ab';
import { updateSystem } from '../api/systems.js?v=8c9eb2f2';

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

export let _systemAddModal = null;
export function getSystemAddModal() {
  if (_systemAddModal) return _systemAddModal;
  _systemAddModal = document.createElement('dialog');
  _systemAddModal.className = 'edit-report-modal';
  _systemAddModal.innerHTML = `
    <h2 class="edit-report-title">Add System</h2>
    <div class="edit-report-fields">
      <label class="edit-report-label">Label
        <input class="edit-report-input" type="text" name="label" placeholder="e.g. Desktop RTX 4070" maxlength="80">
      </label>
      <label class="edit-report-label">CPU
        <input class="edit-report-input" type="text" name="cpu" placeholder="e.g. AMD Ryzen 7 5800X3D" maxlength="120">
      </label>
      <label class="edit-report-label">GPU
        <input class="edit-report-input" type="text" name="gpu" placeholder="e.g. NVIDIA GeForce RTX 4070" maxlength="120">
      </label>
      <label class="edit-report-label">GPU Vendor
        <select class="edit-report-input" name="gpu_vendor">
          <option value="">--</option>
          <option value="nvidia">NVIDIA</option>
          <option value="amd">AMD</option>
          <option value="intel">Intel</option>
        </select>
      </label>
      <label class="edit-report-label">GPU Driver
        <input class="edit-report-input" type="text" name="gpu_driver" placeholder="e.g. Mesa 24.1.0" maxlength="80">
      </label>
      <label class="edit-report-label">RAM
        <input class="edit-report-input" type="text" name="ram" placeholder="e.g. 32 GB" maxlength="20">
      </label>
      <label class="edit-report-label">VRAM (MB)
        <input class="edit-report-input" type="number" name="vram" placeholder="e.g. 8192" min="0" max="262144">
      </label>
      <label class="edit-report-label">OS
        <input class="edit-report-input" type="text" name="os" placeholder="e.g. Arch Linux" maxlength="60">
      </label>
      <label class="edit-report-label">Kernel
        <input class="edit-report-input" type="text" name="kernel" placeholder="e.g. 6.8.0" maxlength="60">
      </label>
    </div>
    <div class="edit-report-status"></div>
    <div class="edit-report-actions">
      <button type="button" class="edit-report-cancel">Cancel</button>
      <button type="button" class="edit-report-save">Save System</button>
    </div>
  `;
  document.body.appendChild(_systemAddModal);
  _systemAddModal.querySelector('.edit-report-cancel').addEventListener('click', () => _systemAddModal.close());
  return _systemAddModal;
}

export async function showAddSystemModal(protonPulseUserId, session, { supabaseUserSystemsUrl, supabaseHeaders, systemsCache }, onSaved) {
  const modal = getSystemAddModal();
  const status = modal.querySelector('.edit-report-status');
  const saveBtn = modal.querySelector('.edit-report-save');
  status.textContent = '';
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save System';
  modal.querySelectorAll('input, select, textarea').forEach(el => { el.value = ''; });
  modal.showModal();

  saveBtn.onclick = async () => {
    const cpu = modal.querySelector('[name="cpu"]').value.trim();
    const gpu = modal.querySelector('[name="gpu"]').value.trim();
    if (!cpu && !gpu) {
      status.textContent = 'At least CPU or GPU is needed';
      status.style.color = 'var(--red)';
      return;
    }
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;
    status.textContent = '';

    const label = modal.querySelector('[name="label"]').value.trim() || 'Manual system';
    const gpuDriver = modal.querySelector('[name="gpu_driver"]').value.trim();
    const ram = modal.querySelector('[name="ram"]').value.trim();
    const vram = modal.querySelector('[name="vram"]').value.trim();
    const os = modal.querySelector('[name="os"]').value.trim();
    const kernel = modal.querySelector('[name="kernel"]').value.trim();

    const lines = [];
    if (cpu) lines.push(`CPU Brand: ${cpu}`);
    if (gpu) lines.push(`Video Card: ${gpu}`);
    if (gpuDriver) lines.push(`Driver Version: ${gpuDriver}`);
    if (ram) {
      const gb = parseInt(ram.replace(/[^0-9]/g, ''), 10);
      if (gb) lines.push(`RAM: ${gb * 1024} Mb`);
    }
    if (vram) lines.push(`VRAM: ${vram} Mb`);
    if (os) lines.push(`OS Version: ${os}`);
    if (kernel) lines.push(`Kernel Version: ${kernel}`);

    const deviceId = 'web-' + crypto.randomUUID().slice(0, 12);
    const isFirst = (systemsCache || []).length === 0;

    try {
      const resp = await fetch(supabaseUserSystemsUrl(), {
        method: 'POST',
        headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          proton_pulse_user_id: protonPulseUserId,
          device_id: deviceId,
          label,
          sysinfo_text: lines.join('\n'),
          is_default: isFirst,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!resp.ok) throw new Error(`Save failed: HTTP ${resp.status}`);
      console.debug('[profile] showAddSystemModal: saved', { deviceId, label });
      modal.close();
      onSaved?.();
    } catch (e) {
      status.textContent = e.message || 'Save failed';
      status.style.color = 'var(--red)';
      console.warn('[profile] showAddSystemModal: save failed', { error: String(e) });
    } finally {
      saveBtn.textContent = 'Save System';
      saveBtn.disabled = false;
    }
  };
}

export let _systemEditModal = null;
export function getSystemEditModal() {
  if (_systemEditModal) return _systemEditModal;
  _systemEditModal = document.createElement('dialog');
  _systemEditModal.className = 'edit-report-modal';
  _systemEditModal.innerHTML = `
    <h2 class="edit-report-title">Edit System</h2>
    <div class="edit-report-fields">
      <label class="edit-report-label">Label
        <input class="edit-report-input" type="text" name="label" placeholder="e.g. Desktop RTX 4070" maxlength="80">
      </label>
      <label class="edit-report-label">CPU
        <input class="edit-report-input" type="text" name="cpu" placeholder="e.g. AMD Ryzen 7 5800X3D" maxlength="120">
      </label>
      <label class="edit-report-label">GPU
        <input class="edit-report-input" type="text" name="gpu" placeholder="e.g. NVIDIA GeForce RTX 4070" maxlength="120">
      </label>
      <label class="edit-report-label">GPU Vendor
        <select class="edit-report-input" name="gpu_vendor">
          <option value="">--</option>
          <option value="nvidia">NVIDIA</option>
          <option value="amd">AMD</option>
          <option value="intel">Intel</option>
        </select>
      </label>
      <label class="edit-report-label">GPU Driver
        <input class="edit-report-input" type="text" name="gpu_driver" placeholder="e.g. Mesa 24.1.0" maxlength="80">
      </label>
      <label class="edit-report-label">RAM
        <input class="edit-report-input" type="text" name="ram" placeholder="e.g. 32 GB" maxlength="20">
      </label>
      <label class="edit-report-label">VRAM (MB)
        <input class="edit-report-input" type="number" name="vram" placeholder="e.g. 8192" min="0" max="262144">
      </label>
      <label class="edit-report-label">OS
        <input class="edit-report-input" type="text" name="os" placeholder="e.g. Arch Linux" maxlength="60">
      </label>
      <label class="edit-report-label">Kernel
        <input class="edit-report-input" type="text" name="kernel" placeholder="e.g. 6.8.0" maxlength="60">
      </label>
    </div>
    <div class="edit-report-status"></div>
    <div class="edit-report-actions">
      <button type="button" class="edit-report-cancel">Cancel</button>
      <button type="button" class="edit-report-save">Save Changes</button>
    </div>
  `;
  document.body.appendChild(_systemEditModal);
  _systemEditModal.querySelector('.edit-report-cancel').addEventListener('click', () => _systemEditModal.close());
  return _systemEditModal;
}

export async function showEditSystemModal(row, protonPulseUserId, session, onSaved) {
  const modal = getSystemEditModal();
  const status = modal.querySelector('.edit-report-status');
  const saveBtn = modal.querySelector('.edit-report-save');
  status.textContent = '';
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save Changes';
  modal.showModal();

  const parsed = parseUploadedSystem(row);
  const displayLabel = isGenericSystemLabel(row.label) ? inferSystemLabel(row) : (row.label || '');
  const ramGb = parsed.ram ? parseInt(parsed.ram.replace(/[^0-9]/g, ''), 10) || '' : '';

  modal.querySelector('[name="label"]').value = displayLabel;
  modal.querySelector('[name="cpu"]').value = parsed.cpu || '';
  modal.querySelector('[name="gpu"]').value = parsed.gpu || '';
  modal.querySelector('[name="gpu_vendor"]').value = parsed.gpuVendor || '';
  modal.querySelector('[name="gpu_driver"]').value = parsed.gpuDriver || '';
  modal.querySelector('[name="ram"]').value = ramGb ? `${ramGb} GB` : '';
  modal.querySelector('[name="vram"]').value = parsed.vramMb || '';
  modal.querySelector('[name="os"]').value = [parsed.os, parsed.osVersion].filter(Boolean).join(' ');
  modal.querySelector('[name="kernel"]').value = parsed.kernel || '';

  saveBtn.onclick = async () => {
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;
    status.textContent = '';

    const label = modal.querySelector('[name="label"]').value.trim() || displayLabel;
    const cpu = modal.querySelector('[name="cpu"]').value.trim();
    const gpu = modal.querySelector('[name="gpu"]').value.trim();
    const gpuDriver = modal.querySelector('[name="gpu_driver"]').value.trim();
    const ram = modal.querySelector('[name="ram"]').value.trim();
    const vram = modal.querySelector('[name="vram"]').value.trim();
    const os = modal.querySelector('[name="os"]').value.trim();
    const kernel = modal.querySelector('[name="kernel"]').value.trim();

    const lines = [];
    if (cpu) lines.push(`CPU Brand: ${cpu}`);
    if (gpu) lines.push(`Video Card: ${gpu}`);
    if (gpuDriver) lines.push(`Driver Version: ${gpuDriver}`);
    if (ram) {
      const gb = parseInt(ram.replace(/[^0-9]/g, ''), 10);
      if (gb) lines.push(`RAM: ${gb * 1024} Mb`);
    }
    if (vram) lines.push(`VRAM: ${vram} Mb`);
    if (os) lines.push(`OS Version: ${os}`);
    if (kernel) lines.push(`Kernel Version: ${kernel}`);

    try {
      await updateSystem(protonPulseUserId, row.device_id, {
        label,
        sysinfo_text: lines.join('\n'),
      }, session);
      console.debug('[profile] showEditSystemModal: saved', { deviceId: row.device_id });
      modal.close();
      onSaved?.();
    } catch (e) {
      status.textContent = e.message || 'Save failed';
      console.warn('[profile] showEditSystemModal: save failed', { deviceId: row.device_id, error: String(e) });
    } finally {
      saveBtn.textContent = 'Save Changes';
      saveBtn.disabled = false;
    }
  };
}
