// My Hardware (Block 2) logic: local browser hardware spec used to pre-fill
// the web submit form. Handles paste parsing, per-field origin tracking, and
// the systems/local tab pane switch.
import {
  MYHW_KEYS, MYHW_ORIGIN_LABELS, SupaAuth,
} from '../config.js?v=87cd0f3d';
import {
  parseSteamSystemInfo, inferGpuVendor,
  getMyHwSourceMeta, setMyHwSourceMeta, getMyHwFieldOrigins,
  setMyHwFieldOrigins, setMyHwFieldOrigin,
} from '../utils.js?v=c97505eb';

/**
 * Initialise the My Hardware pane. Call once after DOM is ready.
 *
 * @param {object} ctx
 * @param {Record<string, HTMLElement|null>} ctx.myhwInputs
 * @param {HTMLTextAreaElement|null} ctx.myhwPasteArea
 * @param {HTMLElement|null} ctx.myhwParseBtn
 * @param {HTMLElement|null} ctx.myhwClearBtn
 * @param {HTMLElement|null} ctx.myhwStatus
 * @param {HTMLElement|null} ctx.myhwSourceTitle
 * @param {HTMLElement|null} ctx.myhwSourceBody
 * @param {HTMLElement[]} ctx.myhwTabButtons
 * @param {Record<string, HTMLElement|null>} ctx.myhwTabPanels
 * @returns {{ setMyHardwarePane, loadMyHardware, flashStatus, setLocalHardwareFromParsed, markLocalHardwareEdited, renderMyHwSource, renderMyHwFieldOrigins }}
 */
export function initMyHardware(ctx) {
  const {
    myhwInputs, myhwPasteArea, myhwParseBtn, myhwClearBtn,
    myhwStatus, myhwSourceTitle, myhwSourceBody,
    myhwTabButtons, myhwTabPanels,
  } = ctx;

  let suppressMyHwSourceTracking = false;

  // ── Internal helpers ─────────────────────────────────────────────────────

  function setMyHardwarePane(name) {
    myhwTabButtons.forEach((btn) => {
      const active = btn.dataset.pane === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    for (const [pane, el] of Object.entries(myhwTabPanels)) {
      if (!el) continue;
      const active = pane === name;
      el.classList.toggle('active', active);
      el.hidden = !active;
    }
  }

  function loadMyHardware() {
    for (const [field, el] of Object.entries(myhwInputs)) {
      if (!el) continue;
      el.value = localStorage.getItem(MYHW_KEYS[field]) || '';
    }
  }

  function saveMyHwField(field, rawVal) {
    const val = (rawVal ?? '').toString().trim();
    if (val) localStorage.setItem(MYHW_KEYS[field], val);
    else     localStorage.removeItem(MYHW_KEYS[field]);
  }

  function flashStatus(msg, good) {
    if (!myhwStatus) return;
    myhwStatus.textContent = msg;
    myhwStatus.style.color = good ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { myhwStatus.textContent = ''; }, 2500);
  }

  function renderMyHwSource() {
    if (!myhwSourceTitle || !myhwSourceBody) return;
    const meta = getMyHwSourceMeta();
    const anyLocal = Object.values(MYHW_KEYS).some((k) => localStorage.getItem(k));
    if (!meta) {
      myhwSourceTitle.textContent = anyLocal ? 'Manual browser values' : 'No source selected yet';
      myhwSourceBody.textContent = anyLocal
        ? 'These values were entered directly in this browser and will pre-fill the web submit form.'
        : 'Save values here manually, paste Steam System Information, or set a default uploaded system above.';
      return;
    }
    if (meta.type === 'uploaded-default') {
      myhwSourceTitle.textContent = `Default uploaded system: ${meta.label || 'Uploaded system'}`;
      myhwSourceBody.textContent = 'The Web prefill values below were copied from your default uploaded system and are used to pre-fill the submit-a-report form until you edit them.';
      return;
    }
    if (meta.type === 'customized') {
      myhwSourceTitle.textContent = `Customized browser copy${meta.originLabel ? ` of ${meta.originLabel}` : ''}`;
      myhwSourceBody.textContent = 'These values started from another source, then were edited in this browser. The edited values below now control web form prefill.';
      return;
    }
    if (meta.type === 'steam-paste') {
      myhwSourceTitle.textContent = 'Pasted Steam System Information';
      myhwSourceBody.textContent = 'These values were parsed from the Steam System Information text you pasted here and now pre-fill the web submit form.';
      return;
    }
    myhwSourceTitle.textContent = 'Manual browser values';
    myhwSourceBody.textContent = 'These values were entered directly in this browser and will pre-fill the web submit form.';
  }

  function fieldOriginKeyFor(sourceMeta) {
    if (!sourceMeta) return null;
    if (sourceMeta.type === 'uploaded-default') return 'default-system';
    if (sourceMeta.type === 'steam-paste')      return 'steam-paste';
    return null;
  }

  function renderMyHwFieldOrigins() {
    const origins = getMyHwFieldOrigins();
    document.querySelectorAll('[data-myhw-origin]').forEach((el) => {
      const field  = el.dataset.myhwOrigin;
      const origin = origins[field];
      const caption = origin ? MYHW_ORIGIN_LABELS[origin] : '';
      el.textContent = caption || '';
      if (caption) el.setAttribute('data-origin', origin);
      else el.removeAttribute('data-origin');
    });
  }

  function setLocalHardwareFromParsed(parsed, sourceMeta) {
    suppressMyHwSourceTracking = true;
    try {
      const originKey = fieldOriginKeyFor(sourceMeta);
      const nextOrigins = {};
      for (const [field, val] of Object.entries(parsed)) {
        const el = myhwInputs[field];
        if (!el) continue;
        el.value = val;
        saveMyHwField(field, val);
        if (originKey) nextOrigins[field] = originKey;
      }
      setMyHwFieldOrigins(nextOrigins);
      setMyHwSourceMeta(sourceMeta);
      renderMyHwSource();
      renderMyHwFieldOrigins();
    } finally {
      suppressMyHwSourceTracking = false;
    }
  }

  function markLocalHardwareEdited(field) {
    if (suppressMyHwSourceTracking) return;
    if (field) setMyHwFieldOrigin(field, 'manual');
    const prev = getMyHwSourceMeta();
    if (!prev) {
      setMyHwSourceMeta({ type: 'manual' });
    } else if (prev.type === 'uploaded-default' || prev.type === 'steam-paste') {
      setMyHwSourceMeta({
        type: 'customized',
        originType: prev.type,
        originLabel: prev.label || '',
      });
    }
    renderMyHwSource();
    renderMyHwFieldOrigins();
  }

  // ── Wire event listeners ─────────────────────────────────────────────────

  for (const [field, el] of Object.entries(myhwInputs)) {
    el?.addEventListener('change', () => {
      saveMyHwField(field, el.value);
      markLocalHardwareEdited(field);
    });
  }

  myhwTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => setMyHardwarePane(btn.dataset.pane));
  });
  setMyHardwarePane('systems');

  myhwParseBtn?.addEventListener('click', () => {
    const text = myhwPasteArea?.value || '';
    if (!text.trim()) { flashStatus('Paste something first', false); return; }

    const parsed = parseSteamSystemInfo(text);
    let filled = 0;

    if (parsed.gpu && !parsed.gpuVendor) {
      const v = inferGpuVendor(parsed.gpu);
      if (v) parsed.gpuVendor = v;
    }

    for (const [field, val] of Object.entries(parsed)) {
      const el = myhwInputs[field];
      if (!el) continue;
      filled++;
    }

    if (filled > 0) {
      setLocalHardwareFromParsed(parsed, { type: 'steam-paste' });
    }

    if (filled === 0) flashStatus('Nothing recognized, check the format', false);
    else              flashStatus(`Filled ${filled} field${filled === 1 ? '' : 's'}`, true);
  });

  myhwClearBtn?.addEventListener('click', () => {
    suppressMyHwSourceTracking = true;
    for (const [field, el] of Object.entries(myhwInputs)) {
      if (!el) continue;
      el.value = '';
      localStorage.removeItem(MYHW_KEYS[field]);
    }
    if (myhwPasteArea) myhwPasteArea.value = '';
    setMyHwSourceMeta(null);
    renderMyHwSource();
    suppressMyHwSourceTracking = false;
    flashStatus('Cleared', true);
  });

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    setMyHardwarePane,
    loadMyHardware,
    flashStatus,
    setLocalHardwareFromParsed,
    markLocalHardwareEdited,
    renderMyHwSource,
    renderMyHwFieldOrigins,
  };
}
