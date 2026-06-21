import { SUPABASE_URL, SUPABASE_ANON_KEY, SupaAuth } from './config.js?v=87cd0f3d';
import {
  getProtonPulseUserIdFromSession, parseSteamSystemInfo, inferGpuVendor, inferCpuVendor,
  parseUploadedSystem, isGenericSystemLabel, inferSystemLabel, escapeHtml,
} from './utils.js?v=db23ba95';
import { supabaseHeaders } from './api/supabase.js?v=bdf4b262';
import { supabaseUserSystemsUrl, listUserSystems, updateSystem } from './api/systems.js?v=8c9eb2f2';

(async function () {
  const params = new URLSearchParams(window.location.search);
  const deviceId = params.get('device');
  const isAdd = !deviceId;

  const titleEl = document.getElementById('page-title');
  const eyebrowEl = document.getElementById('page-eyebrow');
  const formEl = document.getElementById('system-form');
  const authGate = document.getElementById('auth-gate');
  const saveBtn = document.getElementById('save-btn');
  const statusEl = document.getElementById('form-status');

  if (isAdd) {
    eyebrowEl.textContent = 'Add System';
    titleEl.textContent = 'New System';
    document.title = 'Add System — Proton Pulse';
  } else {
    eyebrowEl.textContent = 'Edit System';
    titleEl.textContent = 'Loading...';
  }

  const session = await SupaAuth.getSession();
  const protonPulseUserId = getProtonPulseUserIdFromSession(session);
  if (!protonPulseUserId) {
    titleEl.textContent = 'Sign in required';
    authGate.hidden = false;
    document.getElementById('login-btn')?.addEventListener('click', () => SupaAuth.signIn());
    return;
  }

  formEl.hidden = false;

  // Fill the detail fields from a parsed sysinfo object. Used both when editing
  // an existing system and when the user pastes Steam System Info via the modal.
  // Only sets a field when the parse produced a value, so a paste does not wipe
  // fields the user already typed.
  function applyParsed(parsed) {
    const set = (id, val) => { if (val) document.getElementById(id).value = val; };
    set('sys-cpu', parsed.cpu);
    set('sys-cpu-vendor', parsed.cpuVendor || inferCpuVendor(parsed.cpu));
    set('sys-gpu', parsed.gpu);
    set('sys-gpu-vendor', parsed.gpuVendor || inferGpuVendor(parsed.gpu));
    set('sys-gpu-driver', parsed.gpuDriver);
    const ramGb = parsed.ram ? parseInt(parsed.ram.replace(/[^0-9]/g, ''), 10) || '' : '';
    set('sys-ram', ramGb ? `${ramGb} GB` : '');
    set('sys-vram', parsed.vramMb);
    set('sys-os', [parsed.os, parsed.osVersion].filter(Boolean).join(' '));
    set('sys-kernel', parsed.kernel);
  }

  if (!isAdd) {
    const rows = await listUserSystems(protonPulseUserId, session);
    const row = rows.find(r => r.device_id === deviceId);
    if (!row) {
      titleEl.textContent = 'System not found';
      formEl.hidden = true;
      return;
    }
    const parsed = parseUploadedSystem(row);
    const displayLabel = isGenericSystemLabel(row.label) ? inferSystemLabel(row) : (row.label || '');
    titleEl.textContent = displayLabel;
    document.getElementById('sys-label').value = displayLabel;
    applyParsed(parsed);
  } else {
    titleEl.textContent = 'New System';
    saveBtn.textContent = 'Save System';
  }

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = document.getElementById('sys-label').value.trim();
    const cpu = document.getElementById('sys-cpu').value.trim();
    const cpuVendor = document.getElementById('sys-cpu-vendor').value;
    const gpu = document.getElementById('sys-gpu').value.trim();
    const gpuVendor = document.getElementById('sys-gpu-vendor').value;
    const gpuDriver = document.getElementById('sys-gpu-driver').value.trim();
    const ram = document.getElementById('sys-ram').value.trim();
    const vram = document.getElementById('sys-vram').value.trim();
    const os = document.getElementById('sys-os').value.trim();
    const kernel = document.getElementById('sys-kernel').value.trim();

    // Per-field validation
    let firstError = null;
    const VALIDATED_FIELDS = ['sys-label', 'sys-cpu', 'sys-gpu', 'sys-gpu-vendor', 'sys-ram', 'sys-os'];
    function fieldError(id, msg) {
      const el = document.getElementById(id);
      const labelEl = formEl.querySelector(`label[for="${id}"]`);
      if (el) el.style.outline = '2px solid var(--red)';
      if (labelEl) labelEl.style.color = 'var(--red)';
      if (!firstError) firstError = { el, msg };
    }
    function clearErrors() {
      VALIDATED_FIELDS.forEach(id => {
        const el = document.getElementById(id);
        const labelEl = formEl.querySelector(`label[for="${id}"]`);
        if (el) el.style.outline = '';
        if (labelEl) labelEl.style.color = '';
      });
    }
    clearErrors();

    if (!label) fieldError('sys-label', 'Label is required');
    if (!cpu && !gpu) {
      fieldError('sys-cpu', 'At least CPU or GPU is required');
      fieldError('sys-gpu', 'At least CPU or GPU is required');
    }
    if (!gpuVendor) fieldError('sys-gpu-vendor', 'GPU Vendor is required');
    if (!ram) fieldError('sys-ram', 'RAM is required');
    if (!os) fieldError('sys-os', 'OS is required');

    if (firstError) {
      statusEl.textContent = firstError.msg;
      statusEl.style.color = 'var(--red)';
      firstError.el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const lines = [];
    if (cpu) lines.push(`CPU Brand: ${cpu}`);
    if (cpuVendor) lines.push(`CPU Vendor: ${cpuVendor}`);
    if (gpu) lines.push(`Video Card: ${gpu}`);
    if (gpuVendor) lines.push(`GPU Vendor: ${gpuVendor}`);
    if (gpuDriver) lines.push(`Driver Version: ${gpuDriver}`);
    if (ram) {
      const gb = parseInt(ram.replace(/[^0-9]/g, ''), 10);
      if (gb) lines.push(`RAM: ${gb * 1024} Mb`);
    }
    if (vram) lines.push(`VRAM: ${vram} Mb`);
    if (os) lines.push(`OS Version: ${os}`);
    if (kernel) lines.push(`Kernel Version: ${kernel}`);

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    statusEl.textContent = '';

    try {
      if (isAdd) {
        const newDeviceId = 'web-' + crypto.randomUUID().slice(0, 12);
        const rows = await listUserSystems(protonPulseUserId, session);
        const isFirst = rows.length === 0;
        const resp = await fetch(supabaseUserSystemsUrl(), {
          method: 'POST',
          headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
          body: JSON.stringify({
            proton_pulse_user_id: protonPulseUserId,
            device_id: newDeviceId,
            label,
            sysinfo_text: lines.join('\n'),
            is_default: isFirst,
            updated_at: new Date().toISOString(),
          }),
        });
        if (!resp.ok) throw new Error(`Save failed: HTTP ${resp.status}`);
      } else {
        await updateSystem(protonPulseUserId, deviceId, {
          label,
          sysinfo_text: lines.join('\n'),
        }, session);
      }
      window.location.href = 'profile.html';
    } catch (err) {
      statusEl.textContent = err.message || 'Save failed';
      statusEl.style.color = 'var(--red)';
      saveBtn.disabled = false;
      saveBtn.textContent = isAdd ? 'Save System' : 'Save Changes';
    }
  });

  // Cancel returns to the profile page.
  document.getElementById('cancel-btn')?.addEventListener('click', () => {
    window.location.href = 'profile.html';
  });

  // "Parse from Steam info" modal: paste Steam System Information, parse it, and
  // fill the form fields. Reuses parseSteamSystemInfo (same format the plugin and
  // the My Hardware paste box use).
  const parseModal = document.getElementById('steam-parse-modal');
  const parseText = document.getElementById('steam-parse-text');
  const parseStatus = document.getElementById('steam-parse-status');
  function openParseModal() {
    if (parseStatus) parseStatus.textContent = '';
    parseModal.hidden = false;
    parseText?.focus();
  }
  function closeParseModal() { parseModal.hidden = true; }
  document.getElementById('steam-parse-open')?.addEventListener('click', openParseModal);
  document.getElementById('steam-parse-cancel')?.addEventListener('click', closeParseModal);
  parseModal?.addEventListener('click', (e) => { if (e.target === parseModal) closeParseModal(); });
  document.getElementById('steam-parse-run')?.addEventListener('click', () => {
    const text = parseText?.value || '';
    const parsed = parseSteamSystemInfo(text);
    const filledKeys = Object.keys(parsed).filter(k => parsed[k]);
    if (!filledKeys.length) {
      if (parseStatus) {
        parseStatus.textContent = 'Could not read any fields from that text.';
        parseStatus.style.color = 'var(--red)';
      }
      return;
    }
    applyParsed(parsed);
    closeParseModal();
    const msg = `Filled ${filledKeys.length} field${filledKeys.length === 1 ? '' : 's'} from Steam info`;
    if (window.ppToast) window.ppToast.success(msg);
    else { statusEl.textContent = msg; statusEl.style.color = 'var(--green)'; }
  });
})();
