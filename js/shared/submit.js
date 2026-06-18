// submit (shared) module. Used across multiple pages. Relocated from app-submit.js.

import { SupaAuth } from './config.js?v=f6f2c00a';
import { FAULT_KEYS_WEB, deriveRatingFromState, inferProtonType } from './scoring.js?v=0dae1257';
import { detectGpuArch } from '../lib/gpu-arch-detector.js?v=1f02f4a6';

// Form submission + populate-submit-form -- factored out of app.js.
// Loaded as a classic script BEFORE app.js so its globals
// (submitReport, populateSubmitForm, prefillSubmitFormFromMyHardware,
// loadFormSchema, formSchema, MYHW_FORM_MAP, getWebClientId,
// getProtonPulseUserIdFromSession, getWebSource, normalizeRam) are
// available when app.js runs. Depends on FAULT_KEYS_WEB +
// deriveRatingFromState + inferProtonType from app-scoring.js.

// globals that app.js normally defines but submit.html loads without app.js.
// can't use var here because app.js uses const for SB_URL/SB_KEY/esc and
// a var hoisted from this file would collide with the const declaration
if (typeof window._ppSubmitGlobalsReady === 'undefined') {
  window._ppSubmitGlobalsReady = true;
  if (typeof window.esc !== 'function') {
    window.esc = function(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };
  }
  if (typeof window.SB_URL === 'undefined') {
    window.SB_URL = SUPABASE_URL + '/rest/v1';
    window.SB_KEY = SUPABASE_ANON_KEY;
  }
}

// lightweight sysinfo parser for the system picker. profile.js has the
// full version, but that file only loads on profile.html. keep this
// self-contained so the submit form works on app.html without it
/**
 * Parse a Steam system info text block into structured hardware fields.
 * Extracts cpu, gpu, gpuDriver, ram (GB string), vramMb (number), os, kernel, gpuVendor, and gpuArch.
 * Infers gpuVendor from GPU name patterns and gpuArch via `detectGpuArch`.
 * @param {string} text - Raw text from Steam's "Help > System Information" dialog.
 * @returns {{cpu?: string, gpu?: string, gpuDriver?: string, ram?: string, vramMb?: number, os?: string, kernel?: string, gpuVendor?: string, gpuArch?: string}}
 */
export function parseSteamSystemInfo(text) {
  const out = {};
  if (!text) return out;
  const m = (pat) => { const r = text.match(pat); return r ? r[1].trim() : ''; };
  const cpu = m(/CPU Brand:\s*(.+)/i);
  if (cpu) out.cpu = cpu;
  // Steam puts GPU info under "Video Card:" header, actual card is on the
  // "Driver:" line below it. match both patterns
  const gpu = m(/Video Card:\s*\n\s*Driver:\s*(.+)/i) || m(/Video Card:\s*(.+)/i) || m(/(?:^|\n)\s*Driver:\s*(.+)/i);
  if (gpu && !/^unknown$/i.test(gpu)) out.gpu = gpu.replace(/^(NVIDIA Corporation|Advanced Micro Devices.*?Inc\.\s*\[AMD\/ATI\]|AMD|Intel Corporation)\s*/i, '').replace(/^NVIDIA\s+/i, '').trim();
  const drv = m(/Driver Version:\s*(.+)/i);
  if (drv && !/^unknown$/i.test(drv)) out.gpuDriver = drv;
  const ram = text.match(/RAM:\s*(\d+)\s*Mb/i);
  if (ram) { const gb = Math.round(Number(ram[1]) / 1024); if (gb > 0) out.ram = `${gb} GB`; }
  const vram = text.match(/VRAM:\s*(\d+)\s*Mb/i);
  if (vram) out.vramMb = Number(vram[1]);
  const os = m(/OS Version:\s*(.+)/i) || m(/Operating System Version:\s*\n\s*(.+)/i);
  if (os) out.os = os.replace(/\s*\(.*?\)/g, '').replace(/^"(.*)"$/, '$1');
  const kern = m(/Kernel Version:\s*(.+)/i);
  if (kern) out.kernel = kern;
  // infer vendor from GPU name
  if (out.gpu) {
    const gl = out.gpu.toLowerCase();
    if (gl.includes('nvidia') || gl.includes('geforce') || gl.includes('rtx') || gl.includes('gtx')) out.gpuVendor = 'nvidia';
    else if (gl.includes('amd') || gl.includes('radeon') || gl.includes('vangogh') || gl.includes('0405')) out.gpuVendor = 'amd';
    else if (gl.includes('intel') || gl.includes('iris') || gl.includes('uhd')) out.gpuVendor = 'intel';
    const arch = detectGpuArch(out.gpu);
    if (arch) out.gpuArch = arch;
  }
  return out;
}

/**
 * Get or create a persistent anonymous client ID stored in localStorage.
 * Used to deduplicate reports from the same browser when no user account exists.
 * @returns {string} UUID string from localStorage key `proton-pulse:web-client-id`.
 */
export function getWebClientId() {
  const key = 'proton-pulse:web-client-id';
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
}

/**
 * Extract the Supabase user ID from a Supabase auth session object.
 * @param {object|null} session - Supabase session returned by `SupaAuth.getSession()`.
 * @returns {string|null} The user's UUID, or null if not authenticated.
 */
export function getProtonPulseUserIdFromSession(session) {
  return session?.user?.id || null;
}

/**
 * Detect the platform the user is submitting from based on the browser user agent.
 * @returns {'web-steamdeck'|'web-linux'|'web-windows'|'web-macos'|'web'} Platform identifier string.
 */
export function getWebSource() {
  const ua = navigator.userAgent || '';
  if (/SteamGamepad|SteamDeck/.test(ua) || (/Linux/.test(ua) && /Valve/.test(ua))) return 'web-steamdeck';
  if (/Linux/.test(ua)) return 'web-linux';
  if (/Windows/.test(ua)) return 'web-windows';
  if (/Mac/.test(ua)) return 'web-macos';
  return 'web';
}

export let formSchema      = null;   // loaded from form-schema.json

/**
 * Load and cache the form schema from `form-schema.json`.
 * Subsequent calls return the cached value without a network request.
 * @returns {Promise<object|null>} Parsed schema object, or null if the fetch fails.
 */
export async function loadFormSchema() {
  if (formSchema) return formSchema;
  try {
    const r = await fetch('form-schema.json');
    formSchema = r.ok ? await r.json() : null;
  } catch { formSchema = null; }
  return formSchema;
}

/**
 * Normalize a RAM string to a canonical `"N GB"` format.
 * Strips non-digit characters, parses the number, and appends " GB".
 * Returns the trimmed raw string unchanged if parsing fails.
 * @param {string} raw - Raw RAM value (e.g. "16 GB", "16384 MB", "32").
 * @returns {string} Normalized string like `"16 GB"`, or the original trimmed string on parse failure.
 */
export function normalizeRam(raw) {
  const n = parseInt((raw || '').replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? raw.trim() : `${n} GB`;
}




/**
 * Validate and submit (or update) a Pulse compatibility report to the `user_configs` Supabase table.
 * Requires an active Supabase session; returns an error object if the user is not signed in.
 * Uses `PATCH` for edits (`editReportId` set) or `POST` with `on_conflict=client_id,app_id` for new reports.
 * Derives the rating from form state via `deriveRatingFromState`; rejects if a rating cannot be inferred.
 * Hits Supabase REST: `user_configs`.
 * @param {number|string} appId - Steam app ID.
 * @param {string} title - Game title fallback (used if the form's gameTitle field is empty).
 * @param {HTMLFormElement & {_formState?: object}} form - The submit form element with `_formState` attached.
 * @param {string|null} [editReportId=null] - Existing report ID to update, or null for a new submission.
 * @returns {Promise<{ok: true}|{ok: false, error: string}>}
 */
export async function submitReport(appId, title, form, editReportId = null) {
  const session = await SupaAuth.getSession();
  if (!session) return { ok: false, error: 'Sign in with Steam to submit a report.' };
  const protonPulseUserId = getProtonPulseUserIdFromSession(session);
  const state = form._formState || {};

  // validate required compatibility questions before submitting
  const missing = [];
  if (!state.canInstall) missing.push('Can you install the game?');
  if (state.canInstall === 'yes' && !state.canStart) missing.push('Can you start the game?');
  if (state.canInstall === 'yes' && state.canStart === 'yes' && !state.canPlay) missing.push('Can you play the game?');
  const allInstallYes = state.canInstall === 'yes' && state.canStart === 'yes' && state.canPlay === 'yes';
  if (allInstallYes) {
    if (!state.verdict) missing.push('Overall, did the game work?');
    const unansweredFaults = FAULT_KEYS_WEB.filter(k => !state.faults?.[k]);
    if (unansweredFaults.length > 0) missing.push(`${unansweredFaults.length} fault question(s)`);
  }
  if (missing.length > 0) {
    return { ok: false, error: `Answer required questions: ${missing.join(', ')}` };
  }

  const installFailed = state.canInstall === 'no' || state.canStart === 'no' || state.canPlay === 'no';
  const derivedRating = deriveRatingFromState(state);
  // If the deriver returns null we don't have enough info to score the
  // submission. Refusing here is much better than the previous behavior of
  // silently shipping `rating: 'borked'` -- that's how a legit "all yes"
  // submission ended up showing as Borked when validation slipped through.
  if (!derivedRating) {
    return { ok: false, error: 'Cannot derive a rating from the answers. Please review the compatibility questions.' };
  }
  const formResponses = {
    canInstall: state.canInstall || null,
    canStart:   state.canStart   || null,
    canPlay:    state.canPlay    || null,
    protonType: inferProtonType(form.protonVersion.value),
    tinkeringMethods: state.tinkeringMethods ? [...state.tinkeringMethods] : [],
    isTinker: !!(state.tinkeringMethods && state.tinkeringMethods.size > 0),
    ...Object.fromEntries(FAULT_KEYS_WEB.map(k => [k, state.faults?.[k] || null])),
    // optional notes per fault section, only captured when user answered Yes
    ...Object.fromEntries(FAULT_KEYS_WEB.map(k => [k + 'Notes', (form[k + 'Notes']?.value || '').trim() || null])),
    onlineMultiplayer: state.onlineMultiplayer || null,
    onlineMultiplayerNotes: state.onlineMultiplayer === 'yes'
      ? (form.onlineMultiplayerNotes?.value || '').trim() || null
      : null,
    localMultiplayer:  state.localMultiplayer  || null,
    localMultiplayerNotes: state.localMultiplayer === 'yes'
      ? (form.localMultiplayerNotes?.value || '').trim() || null
      : null,
    // Optional: does the game work without an internet connection at all?
    // Not used by scoring -- captured for future stats on always-online titles
    offlineCompat: installFailed ? null : (state.offlineCompat || null),
    verdict:    installFailed ? 'no' : (state.verdict || null),
    // verdictOob is now inferred from whether any tinkering methods were
    // checked: empty = "yes, works out of box". Old reports still carry an
    // explicit value, so legacy viewing code can read either. Stored here
    // for cross-version compatibility with the plugin's submission shape.
    verdictOob: installFailed ? null : (state.verdict === 'yes'
      ? (state.tinkeringMethods && state.tinkeringMethods.size > 0 ? 'no' : 'yes')
      : null),
    // framegen is informational only, never read by scoring (app-scoring.js).
    // When the user answered Yes we also capture which framegen tech they
    // used + free-form notes; stats can break down by type (task #31).
    requiresFramegen: installFailed ? null : (state.requiresFramegen || null),
    framegenType: state.requiresFramegen === 'yes'
      ? (form.framegenType?.value || '').trim() || null
      : null,
    framegenNotes: state.requiresFramegen === 'yes'
      ? (form.framegenNotes?.value || '').trim() || null
      : null,
    summary:    null,
  };
  const body = {
    client_id: getWebClientId(),
    proton_pulse_user_id: protonPulseUserId,
    app_id: appId,
    // Prefer the user-edited title from the form; fall back to the resolved
    // page title if the field is somehow empty. `required` on the input
    // means an empty submit will be blocked by the browser before this runs
    title: (form.gameTitle?.value || title || '').trim(),
    cpu: form.cpu.value,
    gpu: form.gpu.value,
    gpu_driver: form.gpuDriver.value,
    gpu_vendor: form.gpuVendor.value,
    gpu_architecture: detectGpuArch(form.gpu.value) || null,
    ram: normalizeRam(form.ram.value),
    os: (form.os.value + (form.osVersion.value ? ' ' + form.osVersion.value.trim() : '')),
    kernel: form.kernel.value,
    proton_version: form.protonVersion.value,
    duration: form.duration.value || 'unreported',
    rating: derivedRating,
    notes: form.notes.value,
    launch_options: form.launchOptions.value,
    enabled_vars: {},
    confidence_score: null,
    source: form.reportSource?.value || getWebSource(),
    vram_mb: form.vramMb.value ? Number(form.vramMb.value) : null,
    game_owned: true,  // authenticated web users own the game by definition
    form_responses: formResponses,
  };
  const isEdit = !!editReportId;
  const fetchUrl = isEdit
    ? `${SB_URL}/user_configs?id=eq.${encodeURIComponent(editReportId)}`
    : `${SB_URL}/user_configs?on_conflict=client_id,app_id`;
  const r = await fetch(fetchUrl, {
    method: isEdit ? 'PATCH' : 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      'x-client-id': body.client_id,
      Prefer: isEdit ? 'return=minimal' : 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true };
  try {
    const err = await r.json();
    const msg = err.message || err.hint || err.details || JSON.stringify(err);
    console.error('[submitReport] DB error', r.status, msg, err);
    return { ok: false, error: `${r.status}: ${msg}` };
  } catch {
    console.error('[submitReport] HTTP error', r.status);
    return { ok: false, error: `HTTP ${r.status}` };
  }
}

// Map of submit-form input name -> localStorage key (set on the profile page).
// Kept here so the submit form can stay self-contained without importing profile.js
export const MYHW_FORM_MAP = {
  cpu:        'proton-pulse:myhw:cpu',
  gpu:        'proton-pulse:myhw:gpu',
  gpuVendor:  'proton-pulse:myhw:gpu-vendor',
  gpuDriver:  'proton-pulse:myhw:gpu-driver',
  ram:        'proton-pulse:myhw:ram',
  vramMb:     'proton-pulse:myhw:vram-mb',
  os:         'proton-pulse:myhw:os',
  osVersion:  'proton-pulse:myhw:os-version',
  kernel:     'proton-pulse:myhw:kernel',
};

// Pre-fill the submit-a-report form with the user's saved My-hardware values.
// Only fills empty fields, so a half-written draft isn't clobbered.
//
// TODO(you): implement this. ~8 lines.
// Steps:
//   1. Grab the <form id="submit-report-form"> inside el
//   2. For each [name, storageKey] in MYHW_FORM_MAP:
//       - find the matching form element by name
//       - if it exists and its current value is empty, set it from localStorage
//   3. Watch out: the gpuVendor <select> will ignore values that aren't one of
//      its options, so that'll fail gracefully on its own.
//
// You may want to think about whether to dispatch an 'input' event after
// setting — right now no listeners care, but it's a cheap habit that avoids
// surprises later.
/**
 * Pre-fill hardware fields in the submit form from the user's saved My Hardware localStorage values.
 * Only fills fields that are currently empty, so in-progress drafts are not overwritten.
 * Reads from localStorage keys defined in `MYHW_FORM_MAP`.
 * @param {Element} el - Container element that holds `#submit-report-form`.
 * @returns {void}
 */
export function prefillSubmitFormFromMyHardware(el) {
  const form = el.querySelector('#submit-report-form');
  if (!form) return;
  for (const [name, key] of Object.entries(MYHW_FORM_MAP)) {
    const input = form.elements[name];
    if (!input || input.value) continue;
    const val = localStorage.getItem(key);
    if (val) input.value = val;
  }
}

/**
 * Render and wire the full "Submit a Pulse Report" form into a container element.
 * Loads `form-schema.json` for OS list, GPU vendors, and known Proton versions,
 * then fetches recent GE-Proton and official Proton releases from GitHub to extend the datalist.
 * Populates the system picker from `user_systems` (Supabase) if the user is signed in.
 * Attaches all progressive-reveal radio/checkbox listeners and the live rating badge.
 * No-ops if the container already has `data-loaded="1"`.
 * @param {Element} el - Wrapper element containing `#submit-form-content`.
 * @returns {Promise<void>}
 */
export async function populateSubmitForm(el) {
  const container = el.querySelector('#submit-form-content');
  if (!container || container.dataset.loaded) return;
  const schema = await loadFormSchema();
  if (!schema) { container.textContent = 'Could not load form-schema.json'; return; }
  const osList = schema.validOs || [];
  const gpuVendors = schema.validGpuVendors || [];
  const opts = (arr, cap) => arr.map(v => `<option value="${esc(v)}">${cap ? v[0].toUpperCase()+v.slice(1) : esc(v)}</option>`).join('');
  const durationOpts = [
    ['unreported','Not sure'],['underOneHour','Under 1 hour'],['oneToFourHours','1-4 hours'],
    ['fourToTenHours','4-10 hours'],['overTenHours','10+ hours'],
  ].map(([v,l]) => `<option value="${v}">${l}</option>`).join('');
  const ynBtns = (name) => `
    <div class="sf-yn">
      <label class="sf-yn-btn"><input type="radio" name="${name}" value="yes"> Yes</label>
      <label class="sf-yn-btn"><input type="radio" name="${name}" value="no"> No</label>
    </div>`;
  const faultRows = [
    ['performanceFaults', 'Unexpected slowdowns or stutters?'],
    ['graphicalFaults',   'Graphical glitches or artifacts?'],
    ['windowingFaults',   'Windowing or display issues?'],
    ['audioFaults',       'Audio issues?'],
    ['inputFaults',       'Input or controller issues?'],
    ['stabilityFaults',   'Crashes or instability?'],
    ['saveGameFaults',    'Save game issues?'],
    ['significantBugs',   'Any other significant bugs?'],
  ].map(([k,q]) => `
    <div class="sf-question" id="q-${k}">
      <div class="sf-q-label">${q} *</div>
      ${ynBtns(k)}
      <div class="sf-fault-notes sf-hidden" id="q-${k}-notes">
        <textarea name="${k}Notes" rows="2" placeholder="Notes (optional)"></textarea>
      </div>
    </div>`).join('');
  const tinkerMethods = [
    'Changed game config files','winetricks','protontricks','protonfixes',
    'Media Foundation DLL (mf-install)','Lutris install script','Launch options / env vars',
  ].map(m => `<label class="sf-tink-label"><input type="checkbox" name="tinkeringMethod" value="${esc(m)}"> ${esc(m)}</label>`).join('');

  container.innerHTML = `
    <h3 style="margin:0 0 12px">Submit a Pulse Report</h3>
    <details class="scoring-guide">
      <summary>How Scoring Works</summary>
      <div class="scoring-guide-body">
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#b4c7dc;color:#111">Platinum</span><span class="scoring-guide-rule">Can install, start, and play. No faults. Works out of the box without tinkering.</span></div>
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#c8a050;color:#111">Gold</span><span class="scoring-guide-rule">Can install, start, and play. No faults. Works but required tinkering.</span></div>
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#8fa0b0;color:#111">Silver</span><span class="scoring-guide-rule">Can install, start, and play. Exactly 2 faults.</span></div>
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#b07040;color:#fff">Bronze</span><span class="scoring-guide-rule">Can install, start, and play. 3+ faults.</span></div>
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#c85050;color:#fff">Borked</span><span class="scoring-guide-rule">Cannot install, start, or play - or overall verdict is No.</span></div>
      </div>
    </details>
    <form id="submit-report-form" autocomplete="on">
      <div class="sf-section-label">Game</div>
      <div class="sf-row"><label>Game title</label><input name="gameTitle" readonly style="cursor:default;color:var(--muted);border-color:var(--border2);background:var(--s1);" placeholder="Loading..."></div>

      <div class="sf-section-label">Hardware &amp; Setup</div>
      <div class="sf-row"><label>System</label>
        <select name="systemPicker" id="sf-system-picker">
          <option value="">Manual entry</option>
        </select>
        <span style="font-size:0.72rem;color:var(--muted)">Pick a saved system to prefill hardware fields</span>
      </div>
      <div class="sf-row"><label>Proton Version *</label>
        <div class="sf-autocomplete" style="position:relative;flex:1;">
          <input name="protonVersion" required placeholder="e.g. Proton 9.0-4 or GE-Proton9-27" autocomplete="off" style="width:100%">
          <ul class="sf-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;background:var(--s2);border:1px solid var(--border);border-top:none;max-height:200px;overflow-y:auto;list-style:none;margin:0;padding:0;"></ul>
        </div>
      </div>
      <div class="sf-row"><label>GPU *</label><input name="gpu" required placeholder="e.g. NVIDIA GeForce RTX 4070"></div>
      <div class="sf-row"><label>GPU Vendor *</label><select name="gpuVendor" required><option value="" disabled selected>-- choose one --</option>${opts(gpuVendors,true)}</select></div>
      <div class="sf-row"><label>GPU Driver</label><input name="gpuDriver" placeholder="e.g. Mesa 24.1.0 or 555.42.02"></div>
      <div class="sf-row"><label>CPU *</label><input name="cpu" required placeholder="e.g. AMD Ryzen 7 5800X3D"></div>
      <div class="sf-row"><label>RAM *</label><input name="ram" required placeholder="e.g. 16 GB or 64"></div>
      <div class="sf-row"><label>VRAM (MB)</label><input name="vramMb" type="number" placeholder="e.g. 8192"></div>
      <div class="sf-row"><label>OS *</label><select name="os" required><option value="" disabled selected>-- choose one --</option>${opts(osList,false)}</select><input name="osVersion" placeholder="Version (e.g. 24.04)" style="max-width:120px"></div>
      <div class="sf-row"><label>Kernel</label><input name="kernel" placeholder="e.g. 6.8.0"></div>
      <div class="sf-row"><label>Steam Playtime</label><select name="duration">${durationOpts}</select></div>
      <div class="sf-row"><label>Launch Options</label><input name="launchOptions" placeholder="e.g. PROTON_USE_WINED3D=1 %command%"></div>

      <div class="sf-section-label" style="margin-top:16px">Compatibility Questions</div>

      <div class="sf-question" id="q-canInstall">
        <div class="sf-q-label">Can you install the game? *</div>
        ${ynBtns('canInstall')}
      </div>
      <div class="sf-question sf-hidden" id="q-canStart">
        <div class="sf-q-label">Can you start the game? *</div>
        ${ynBtns('canStart')}
      </div>
      <div class="sf-question sf-hidden" id="q-canPlay">
        <div class="sf-q-label">Can you play the game? *</div>
        ${ynBtns('canPlay')}
      </div>

      <div class="sf-question sf-hidden" id="q-tinkering">
        <div class="sf-q-label">Did you need to tinker? <span style="font-weight:400;color:var(--muted)">(select all that apply)</span></div>
        <div class="sf-tink-grid">${tinkerMethods}</div>
      </div>

      <div class="sf-hidden" id="q-faults">
        <div class="sf-q-label" style="margin-bottom:6px">Fault Questions * <span style="font-weight:400;color:var(--muted);font-size:0.75rem">Each Yes = 1 fault</span></div>
        ${faultRows}
      </div>

      <div class="sf-question sf-hidden" id="q-multiplayer-online">
        <div class="sf-q-label">Did you test online multiplayer? <span style="font-weight:400;color:var(--muted)">(optional)</span></div>
        <div class="sf-q-hint">Only answer if the game has online multiplayer and you tried it.</div>
        ${ynBtns('onlineMultiplayer')}
        <div class="sf-fault-notes sf-hidden" id="q-onlineMultiplayer-notes">
          <textarea name="onlineMultiplayerNotes" rows="2" placeholder="How did online multiplayer work? Any issues with matchmaking, voice chat, anti-cheat? (optional)"></textarea>
        </div>
      </div>

      <div class="sf-question sf-hidden" id="q-multiplayer-local">
        <div class="sf-q-label">Did you test local / couch multiplayer? <span style="font-weight:400;color:var(--muted)">(optional)</span></div>
        <div class="sf-q-hint">Only answer if the game has local multiplayer and you tried it.</div>
        ${ynBtns('localMultiplayer')}
        <div class="sf-fault-notes sf-hidden" id="q-localMultiplayer-notes">
          <textarea name="localMultiplayerNotes" rows="2" placeholder="How did local multiplayer work? Any issues with controllers, splitscreen, second player input? (optional)"></textarea>
        </div>
      </div>

      <div class="sf-question sf-hidden" id="q-offline-compat">
        <div class="sf-q-label">Did the game work offline? <span style="font-weight:400;color:var(--muted)">(optional)</span></div>
        <div class="sf-q-hint">Only relevant if the game is supposed to play offline. Some titles require an always-on internet connection even for single-player.</div>
        ${ynBtns('offlineCompat')}
        <div class="sf-fault-notes sf-hidden" id="q-offlineCompat-notes">
          <textarea name="offlineCompatNotes" rows="2" placeholder="Which parts worked offline? e.g. main campaign yes, multiplayer no, save sync requires login... (optional)"></textarea>
        </div>
      </div>

      <div class="sf-question sf-hidden" id="q-verdict">
        <div class="sf-q-label">Overall, did the game work? *</div>
        <div class="sf-q-hint">"Yes" with no tinkering checked above = platinum. "Yes" + at least one tinkering method = gold.</div>
        ${ynBtns('verdict')}
      </div>

      <div class="sf-question sf-hidden" id="q-framegen">
        <div class="sf-q-label">Did this game require framegen to hit smooth gameplay / 60 FPS?</div>
        <div class="sf-q-hint">Optional. Helps separate games that work natively from those leaning on upscalers.</div>
        ${ynBtns('requiresFramegen')}
        <div class="sf-fault-notes sf-hidden" id="q-framegen-followup">
          <div class="sf-row" style="margin-top:8px">
            <label>Framegen type</label>
            <select name="framegenType">
              <option value="">-- choose one --</option>
              <option value="fsr">FSR (AMD)</option>
              <option value="lsfg">LSFG (Lossless Scaling)</option>
              <option value="dlss-g">DLSS-G (NVIDIA)</option>
              <option value="afmf">AFMF (AMD driver)</option>
              <option value="xess-fg">XeSS Frame Gen (Intel)</option>
              <option value="other">Other</option>
            </select>
          </div>
          <textarea name="framegenNotes" rows="2" placeholder="Which framegen settings worked? Any quality / latency tradeoffs? (optional)" style="margin-top:6px"></textarea>
        </div>
      </div>

      <div class="sf-row sf-hidden" id="derived-rating-row">
        <label>Rating (auto-derived)</label>
        <span id="derived-rating-badge" style="font-weight:700;padding:2px 10px;border-radius:3px">--</span>
      </div>

      <div class="sf-section-label" style="margin-top:16px">Notes</div>
      <div class="sf-row"><textarea name="notes" rows="3" required placeholder="How did it run? Any issues or tweaks?"></textarea></div>

      <div class="sf-row">
        <label>Submitted from</label>
        <select name="reportSource">
          <option value="web-linux"${getWebSource()==='web-linux'?' selected':''}>Linux</option>
          <option value="web-windows"${getWebSource()==='web-windows'?' selected':''}>Windows</option>
          <option value="web-macos"${getWebSource()==='web-macos'?' selected':''}>macOS</option>
          <option value="web-steamdeck"${getWebSource()==='web-steamdeck'?' selected':''}>Steam Deck</option>
          <option value="web"${getWebSource()==='web'?' selected':''}>Other / Unknown</option>
        </select>
      </div>
      <div class="sf-row" style="justify-content:flex-end;gap:8px">
        <span id="submit-status" style="font-size:0.76rem;color:var(--muted)"></span>
        <button type="submit" class="submit-report-btn">Submit</button>
      </div>
    </form>`;
  container.dataset.loaded = '1';

  // - Form state & progressive question wiring --
  const form = container.querySelector('#submit-report-form');
  const state = {
    canInstall: null, canStart: null, canPlay: null,
    verdict: null, verdictOob: null,
    requiresFramegen: null,
    faults: Object.fromEntries(FAULT_KEYS_WEB.map(k => [k, null])),
    tinkeringMethods: new Set(),
    onlineMultiplayer: null, localMultiplayer: null,
    offlineCompat: null,
  };
  form._formState = state;

  const show = id => { const el = container.querySelector('#'+id); if (el) el.classList.remove('sf-hidden'); };
  const hide = id => { const el = container.querySelector('#'+id); if (el) el.classList.add('sf-hidden'); };
  const clearRadios = (name) => { form.querySelectorAll(`input[name="${name}"]`).forEach(r => r.checked = false); };

  function updateFormUI() {
    const installFailed = state.canInstall === 'no' || state.canStart === 'no' || state.canPlay === 'no';
    const allInstallYes = state.canInstall === 'yes' && state.canStart === 'yes' && state.canPlay === 'yes';
    const faultCount = FAULT_KEYS_WEB.reduce((n, k) => (state.faults[k] === 'yes' ? n + 1 : n), 0);
    const showOob = allInstallYes && state.verdict === 'yes' && faultCount === 0;

    // Progressive reveal of install questions
    if (state.canInstall !== null) show('q-canStart'); else hide('q-canStart');
    if (state.canInstall === 'yes' && state.canStart !== null) show('q-canPlay'); else hide('q-canPlay');

    // Tinkering + faults + multiplayer + offline + verdict only when all
    // install steps pass
    if (allInstallYes) {
      show('q-tinkering'); show('q-faults');
      show('q-multiplayer-online'); show('q-multiplayer-local');
      show('q-offline-compat');
      show('q-verdict');
    } else {
      hide('q-tinkering'); hide('q-faults');
      hide('q-multiplayer-online'); hide('q-multiplayer-local');
      hide('q-offline-compat');
      hide('q-verdict');
    }

    // Multiplayer / framegen notes follow-ups reveal only when the parent
    // question is answered Yes. Same UX as fault notes
    if (state.onlineMultiplayer === 'yes') show('q-onlineMultiplayer-notes');
    else hide('q-onlineMultiplayer-notes');
    if (state.localMultiplayer === 'yes') show('q-localMultiplayer-notes');
    else hide('q-localMultiplayer-notes');
    if (state.offlineCompat === 'yes') show('q-offlineCompat-notes');
    else hide('q-offlineCompat-notes');

    // Framegen reveals whenever the game is reported as playable (verdict=yes
    // means it works, just maybe with help). Optional, so we don't reset on
    // verdict=no -- but we DO clear it on install failure since the question
    // would be meaningless
    const showFramegen = allInstallYes && state.verdict === 'yes';
    if (showFramegen) show('q-framegen');
    else { hide('q-framegen'); state.requiresFramegen = null; clearRadios('requiresFramegen'); }
    // Follow-up panel (framegen type + notes) only when framegen=Yes
    if (state.requiresFramegen === 'yes') show('q-framegen-followup');
    else hide('q-framegen-followup');

    // Reset downstream state when install fails
    if (installFailed) {
      state.verdict = null; state.verdictOob = null; state.requiresFramegen = null;
      clearRadios('verdict'); clearRadios('verdictOob'); clearRadios('requiresFramegen');
    }

    // Derived rating badge
    const rating = deriveRatingFromState(state);
    const ratingRow = container.querySelector('#derived-rating-row');
    const badge = container.querySelector('#derived-rating-badge');
    if (rating) {
      ratingRow.classList.remove('sf-hidden');
      badge.textContent = rating.charAt(0).toUpperCase() + rating.slice(1);
      badge.style.background = RATING_COLORS[rating] || '#3a4a5a';
      badge.style.color = RATING_TEXT[rating] || '#c8d4e0';
    } else {
      ratingRow.classList.add('sf-hidden');
    }
  }

  // Wire yes/no radio buttons. Multiplayer + framegen + offline are optional
  // but the state still needs to update on change so the submitted
  // form_responses captures the answer. updateFormUI() also re-runs which
  // reveals the matching follow-up notes / type panels on Yes.
  ['canInstall','canStart','canPlay','verdict',
   'onlineMultiplayer','localMultiplayer','requiresFramegen','offlineCompat'].forEach(name => {
    form.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
      radio.addEventListener('change', () => {
        state[name] = radio.value;
        updateFormUI();
      });
    });
  });

  // Wire fault radios + show/hide optional notes
  FAULT_KEYS_WEB.forEach(k => {
    form.querySelectorAll(`input[name="${k}"]`).forEach(radio => {
      radio.addEventListener('change', () => {
        state.faults[k] = radio.value;
        // show notes field when user selects Yes
        const notesEl = container.querySelector(`#q-${k}-notes`);
        if (notesEl) {
          if (radio.value === 'yes') notesEl.classList.remove('sf-hidden');
          else notesEl.classList.add('sf-hidden');
        }
        updateFormUI();
      });
    });
  });

  // Wire tinkering checkboxes
  form.querySelectorAll('input[name="tinkeringMethod"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.tinkeringMethods.add(cb.value);
      else state.tinkeringMethods.delete(cb.value);
    });
  });

  // - Proton Version custom autocomplete (replaces <datalist> which is unreliable on mobile)
  const protonInput = container.querySelector('input[name="protonVersion"]');
  const suggList   = container.querySelector('.sf-suggestions');
  if (protonInput && suggList) {
    const CACHE_KEY = 'pp_proton_versions_v1';
    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
    const PROTON_FALLBACK = ['Proton Experimental','Proton 10.0-4','Proton 9.0-4','Proton 8.0-5','GE-Proton9-27','GE-Proton9-20','GE-Proton8-32'];
    const tagToLabel = tag => { const m = tag.match(/^proton-(\d+\.\d+-\d+)$/i); return m ? `Proton ${m[1]}` : null; };

    // Seed from fallback + schema immediately so suggestions work before network
    let protonVersions = [...new Set([...PROTON_FALLBACK, ...(schema.knownProtonVersions || [])])];

    // Load cached list from localStorage if fresh
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached?.ts && Date.now() - cached.ts < CACHE_TTL && Array.isArray(cached.versions)) {
        protonVersions = [...new Set([...protonVersions, ...cached.versions])];
      }
    } catch {}

    // Async: fetch live releases, extend, and persist to cache
    Promise.allSettled([
      fetch('https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=20')
        .then(r => r.ok ? r.json() : [])
        .then(rels => { for (const rel of rels) protonVersions.push(rel.tag_name); }),
      fetch('https://api.github.com/repos/ValveSoftware/Proton/releases?per_page=20')
        .then(r => r.ok ? r.json() : [])
        .then(rels => { for (const rel of rels) { const l = tagToLabel(rel.tag_name); if (l) protonVersions.push(l); } }),
    ]).then(() => {
      protonVersions = [...new Set(protonVersions)];
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), versions: protonVersions })); } catch {}
    });

    const showSuggestions = (q) => {
      const lq = q.toLowerCase();
      const matches = lq ? protonVersions.filter(v => v.toLowerCase().includes(lq)).slice(0, 10) : protonVersions.slice(0, 10);
      if (!matches.length) { suggList.style.display = 'none'; return; }
      suggList.innerHTML = matches.map(v => `<li style="padding:8px 12px;cursor:pointer;font-size:0.82rem;color:var(--text);border-bottom:1px solid var(--border);">${esc(v)}</li>`).join('');
      suggList.style.display = 'block';
    };
    const hideSuggestions = () => { suggList.style.display = 'none'; };

    protonInput.addEventListener('focus', () => showSuggestions(protonInput.value));
    protonInput.addEventListener('input', () => showSuggestions(protonInput.value));
    suggList.addEventListener('mousedown', e => {
      const li = e.target.closest('li');
      if (li) { protonInput.value = li.textContent; hideSuggestions(); protonInput.dispatchEvent(new Event('change')); }
    });
    suggList.addEventListener('touchstart', e => {
      const li = e.target.closest('li');
      if (li) { e.preventDefault(); protonInput.value = li.textContent; hideSuggestions(); protonInput.dispatchEvent(new Event('change')); }
    }, { passive: false });
    document.addEventListener('click', e => { if (!protonInput.contains(e.target) && !suggList.contains(e.target)) hideSuggestions(); });
  }

  // populate system picker from user's saved systems
  const sysPicker = container.querySelector('#sf-system-picker');
  if (sysPicker) {
    void (async () => {
      try {
        const s = await SupaAuth.getSession();
        if (!s?.user) return;
        const uid = s.user.id;
        const url = `${SUPABASE_URL}/rest/v1/user_systems?proton_pulse_user_id=eq.${uid}&order=updated_at.desc`;
        const resp = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
        if (!resp.ok) return;
        const systems = await resp.json();
        if (!systems.length) return;
        // stash the full system data for prefilling on select
        sysPicker._systems = systems;
        for (const sys of systems) {
          const parsed = parseSteamSystemInfo(sys.sysinfo_text || '');
          const label = sys.label || [parsed.os, parsed.gpu].filter(Boolean).join(' / ') || sys.device_id;
          const opt = document.createElement('option');
          opt.value = sys.device_id;
          opt.textContent = label + (sys.is_default ? ' (default)' : '');
          sysPicker.appendChild(opt);
        }
        // auto-select the default system
        const def = systems.find(s => s.is_default);
        if (def) {
          sysPicker.value = def.device_id;
          sysPicker.dispatchEvent(new Event('change'));
        }
      } catch { /* non-fatal */ }
    })();

    sysPicker.addEventListener('change', () => {
      const systems = sysPicker._systems || [];
      const sys = systems.find(s => s.device_id === sysPicker.value);
      if (!sys) return; // "Manual entry" selected, leave fields as-is
      const parsed = parseSteamSystemInfo(sys.sysinfo_text || '');
      const f = form;
      if (parsed.cpu) f.cpu.value = parsed.cpu;
      if (parsed.gpu) f.gpu.value = parsed.gpu;
      if (parsed.gpuVendor) f.gpuVendor.value = parsed.gpuVendor;
      if (parsed.gpuDriver) f.gpuDriver.value = parsed.gpuDriver;
      if (parsed.ram) f.ram.value = parsed.ram;
      if (parsed.vramMb) f.vramMb.value = parsed.vramMb;
      if (parsed.os) {
        // try matching the OS select, fall back to first word
        const osBase = parsed.os.split(/\s+/)[0];
        const osOpts = [...f.os.options].map(o => o.value);
        const match = osOpts.find(v => parsed.os.startsWith(v)) || osOpts.find(v => v.startsWith(osBase));
        if (match) f.os.value = match;
        // os version after the base distro name
        const ver = parsed.osVersion || parsed.os.replace(osBase, '').trim();
        if (ver && f.osVersion) f.osVersion.value = ver;
      }
      if (parsed.kernel && f.kernel) f.kernel.value = parsed.kernel;
    });
  }
}
