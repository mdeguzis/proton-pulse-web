// submit (shared) module. Used across multiple pages. Relocated from app-submit.js.

import { SupaAuth } from './config.js?v=f6f2c00a';
import { FAULT_KEYS_WEB, deriveRatingFromState, inferProtonType } from './scoring.js?v=1b8ae722';
import { RUN_TYPES, normalizeRunType, validateRuntimeVersion } from './run-type.js?v=01ec5b4d';
import { detectGpuArch } from '../lib/gpu-arch-detector.js?v=b4fbb7ef';

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
  // #152: anchor on start-of-line so "VRAM:" earlier in the buffer cannot
  // steal the match.
  const ram = text.match(/^\s*RAM:\s*(\d+)\s*Mb/im);
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
// Proton runs on Linux only (SteamOS + desktop Linux distros). Reports
// with a Windows / macOS / BSD / mobile OS are nonsense for this site.
// Blocklist rather than allowlist so any current or future Linux distro
// (Alpine, Void, Slackware, Solus, custom rolling releases) passes
// through. Kept in lockstep with the user_configs.os_must_be_linux DB
// check constraint (supabase/migrations/*_user_configs_os_must_be_linux.sql).
const _NON_LINUX_OS_PATTERNS = [
  /^windows/i, /^win\s/i, /^win\d/i,
  /^mac\s?os/i, /^os\s?x/i, /^darwin/i,
  /^freebsd/i, /^openbsd/i, /^netbsd/i, /^dragonfly/i,
  /^ios(\s|$)/i, /^android/i,
];
export function isLinuxOs(os) {
  const s = String(os || '').trim();
  if (!s) return true;   // empty/unknown gets through; required-field UI catches it
  return !_NON_LINUX_OS_PATTERNS.some(re => re.test(s));
}

/**
 * Look up the signed-in user's cached Steam library (public.user_steam_library)
 * and return true iff appId is in their appids list. Used at report submit time
 * to set owner_verified so a "Verified owner" badge can render on the report
 * card (#199). Silently returns false on any error so submission still works.
 */
export async function isAppIdInMyLibrary(appId, session) {
  if (!appId || !session?.access_token) return false;
  try {
    const r = await fetch(
      `${window.SB_URL}/user_steam_library?select=appids&limit=1`,
      {
        headers: {
          apikey: window.SB_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
      },
    );
    if (!r.ok) {
      console.debug('[submit] isAppIdInMyLibrary: query failed', { appId, status: r.status, source: 'user_steam_library' });
      return false;
    }
    const rows = await r.json();
    const appids = Array.isArray(rows) && rows.length ? rows[0].appids : null;
    const owned = Array.isArray(appids) && appids.map(Number).includes(Number(appId));
    console.debug('[submit] isAppIdInMyLibrary', { appId, owned, cachedCount: Array.isArray(appids) ? appids.length : 0, source: 'user_steam_library' });
    return owned;
  } catch (e) {
    console.debug('[submit] isAppIdInMyLibrary threw', { appId, error: e?.message });
    return false;
  }
}

/**
 * Show a "Verified owner" indicator on the submit form when the current appId
 * is in the signed-in user's cached Steam library. Mirrors the report-card
 * badge so the user knows their submission will land with owner_verified=true
 * before they press submit (#199).
 */
/**
 * Restore form values + progressive-question state from a saved draft
 * snapshot produced by snapshotFormData (drafts.js). Every field is optional
 * so partial drafts still populate what they can (#199 follow-up).
 */
export function applyDraftSnapshot(form, snapshot) {
  if (!form || !snapshot) return;
  const values = snapshot.values || {};
  for (const [name, val] of Object.entries(values)) {
    const fields = form.elements[name];
    if (!fields) continue;
    if (fields instanceof RadioNodeList) {
      for (const f of fields) {
        if (f.type === 'radio') f.checked = f.value === val;
        else if (f.type === 'checkbox') f.checked = Array.isArray(val) && val.includes(f.value);
      }
    } else if (fields.type === 'radio' || fields.type === 'checkbox') {
      fields.checked = Array.isArray(val) ? val.includes(fields.value) : fields.value === val;
    } else {
      fields.value = val;
    }
    fields.dispatchEvent?.(new Event('change', { bubbles: true }));
  }
  const state = snapshot.state || {};
  const s = form._formState || (form._formState = {});
  s.canInstall = state.canInstall || null;
  s.canStart = state.canStart || null;
  s.canPlay = state.canPlay || null;
  s.verdict = state.verdict || null;
  s.requiresFramegen = state.requiresFramegen || null;
  s.onlineMultiplayer = state.onlineMultiplayer || null;
  s.localMultiplayer = state.localMultiplayer || null;
  s.offlineCompat = state.offlineCompat || null;
  s.faults = state.faults || {};
  s.tinkeringMethods = new Set(state.tinkeringMethods || []);
}

export async function renderVerifiedOwnerStatus(el, appId) {
  const mount = el?.querySelector?.('#sf-verified-owner');
  if (!mount || !appId) return;
  const session = await SupaAuth.getSession();
  if (!session?.user) { mount.hidden = true; return; }
  const owned = await isAppIdInMyLibrary(appId, session);
  if (!owned) { mount.hidden = true; return; }
  mount.hidden = false;
  mount.innerHTML = `
    <div class="sf-verified-owner-pill" title="Your Steam library confirms you own this game. This report will be marked as Verified owner.">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.7 6.3l-4.5 4.5a.75.75 0 01-1.06 0L4.3 8.94a.75.75 0 111.06-1.06l1.31 1.31 3.97-3.97a.75.75 0 111.06 1.06z"/></svg>
      Verified owner - this report will be flagged as owner-verified
    </div>`;
}

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

  // Proton is Linux-only — reject reports flagged as Windows / macOS / BSD /
  // mobile before the insert. Matches the DB check constraint of the same
  // name so a crafted request bypassing this frontend check still fails.
  const composedOs = (form.os?.value || '') + (form.osVersion?.value ? ' ' + form.osVersion.value.trim() : '');
  if (!isLinuxOs(composedOs)) {
    return { ok: false, error: `Proton only runs on Linux. Reports for "${composedOs.trim()}" are not accepted.` };
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
  const runTypeVal = normalizeRunType(form.runType?.value) || 'proton';
  const isNative = runTypeVal === 'native';
  const formResponses = {
    canInstall: state.canInstall || null,
    canStart:   state.canStart   || null,
    canPlay:    state.canPlay    || null,
    // Proton type is only meaningful for Proton-family runs. Native reports
    // carry a null so scoring can distinguish "no Proton fields required"
    // from "Proton was blank due to user error".
    protonType: isNative ? null : inferProtonType(form.protonVersion.value),
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
    // "Also tested the native Linux build?" follow-up (only when reporting
    // a non-native run against a game that has a native build available).
    alsoTestedLinux: isNative ? null : (form.alsoTestedLinux?.value || null),
    alsoTestedLinuxNotes: (!isNative && form.alsoTestedLinux?.value === 'yes')
      ? (form.alsoTestedLinuxNotes?.value || '').trim() || null
      : null,
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
    // Native runs do not use Proton, so store null rather than an empty
    // string that would break "distinct Proton versions" queries later.
    proton_version: isNative ? null : form.protonVersion.value,
    duration: form.duration.value || 'unreported',
    rating: derivedRating,
    notes: form.notes.value,
    launch_options: form.launchOptions.value,
    enabled_vars: {},
    confidence_score: null,
    source: form.reportSource?.value || getWebSource(),
    vram_mb: form.vramMb.value ? Number(form.vramMb.value) : null,
    // Optional FPS metrics. Plugin will populate these automatically from
    // MangoHud samples in a follow-up; web submissions capture manual entry.
    fps_min: form.fpsMin?.value ? Number(form.fpsMin.value) : null,
    fps_avg: form.fpsAvg?.value ? Number(form.fpsAvg.value) : null,
    fps_max: form.fpsMax?.value ? Number(form.fpsMax.value) : null,
    // Normalize whatever the toggle carries into the canonical taxonomy so
    // a rogue pipeline value or a stale draft cannot land unclassified.
    run_type: normalizeRunType(form.runType?.value) || null,
    game_owned: true,  // authenticated web users own the game by definition
    owner_verified: await isAppIdInMyLibrary(appId, session),
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
  if (r.ok) {
    // #141: edits invalidate the prior approval row. Best-effort delete so
    // the next pipeline pass treats the edited content as a fresh approval
    // pending re-review. Hash-mismatch detection on the frontend already
    // surfaces edits as pending; this keeps the stored row consistent too.
    if (isEdit) {
      await invalidateReportApproval(editReportId, session);
    }
    return { ok: true };
  }
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

// #141: drop the existing report_approvals row for an edited report so the
// next pipeline run computes a fresh hash against the new content. Best-effort
// -- a network failure here still leaves the report visibly pending via the
// frontend's live computeHash mismatch check, so we log and move on.
export async function invalidateReportApproval(reportId, session) {
  if (!reportId || !session?.access_token) return { ok: false, skipped: true };
  try {
    const r = await fetch(`${SB_URL}/report_approvals?report_id=eq.${encodeURIComponent(reportId)}`, {
      method: 'DELETE',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${session.access_token}`,
        Prefer: 'return=minimal',
      },
    });
    if (!r.ok) {
      console.warn('[invalidateReportApproval] DELETE non-ok', { reportId, status: r.status });
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[invalidateReportApproval] network error', { reportId, error: String(err) });
    return { ok: false, error: String(err) };
  }
}

// #22 follow-up: small expander that documents the formatting macros
// recognised in notes. Rendered as a native <details>/<summary> so it
// works without JS. Used on every UI that lets a user edit a notes field
// (submit form + profile edit modal).
export function notesFormattingHelpHtml() {
  return `<details class="formatting-help">
    <summary>Formatting help</summary>
    <p>Wrap a spoiler in <code>{spoiler}your text{/spoiler}</code> to hide it behind a tap. Readers see a blurred span until they tap or focus + Enter on it.</p>
  </details>`;
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
      <div id="sf-verified-owner" hidden></div>
      <div id="sf-draft-restore" class="sf-draft-restore" hidden></div>
      <div class="sf-section-label">Game</div>
      <div class="sf-row"><label>Game title</label><input name="gameTitle" readonly style="cursor:default;color:var(--muted);border-color:var(--border2);background:var(--s1);" placeholder="Loading..."></div>
      <div class="sf-row sf-row--run-type">
        <label>Runtime Type *</label>
        <select name="runType" id="sf-run-type-select">
          <option value="native">Native Linux -- Linux build, no Proton</option>
          <option value="proton" selected>Proton -- Valve's official (stable/hotfix)</option>
          <option value="proton-experimental">Proton Experimental -- Valve's bleeding-edge branch</option>
          <option value="proton-ge">Proton GE -- GloriousEggroll community fork</option>
          <option value="proton-cachyos">CachyOS Proton -- CachyOS-tuned</option>
          <option value="proton-tkg">Proton-TKG -- TKG custom build</option>
          <option value="proton-lsfg">Proton + LSFG -- with Lossless Scaling FrameGen wrapper</option>
        </select>
      </div>
      <div class="sf-row-hint sf-run-type-hint" id="sf-run-type-hint" hidden></div>
      <div class="sf-row" id="sf-runtime-version-row"><label id="sf-runtime-version-label">Runtime Version *</label>
        <div class="sf-autocomplete" style="position:relative;flex:1;">
          <input name="protonVersion" placeholder="e.g. Proton 9.0-4 or GE-Proton9-27" autocomplete="off" style="width:100%">
          <ul class="sf-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;background:var(--s2);border:1px solid var(--border);border-top:none;max-height:200px;overflow-y:auto;list-style:none;margin:0;padding:0;"></ul>
        </div>
      </div>
      <div class="sf-row-hint sf-runtime-version-warn" id="sf-runtime-version-warn" hidden></div>
      <div class="sf-row sf-row--also-linux" id="sf-also-linux-row" hidden>
        <label>Also tested Linux?</label>
        <div class="sf-also-linux-body">
          <div class="sf-inline-yn" id="sf-also-linux-yn">
            <button type="button" data-value="yes" aria-pressed="false">Yes</button>
            <button type="button" data-value="no" aria-pressed="false">No</button>
          </div>
          <input type="hidden" name="alsoTestedLinux" value="">
          <textarea name="alsoTestedLinuxNotes" placeholder="Optional: how did the native Linux build compare (perf, stability)?" rows="2" style="display:none"></textarea>
          <div class="sf-also-linux-hint">
            Steam offers a native Linux build for this game. You can also
            <a href="#" id="sf-submit-native-shortcut">file a separate Native report</a>
            for a side-by-side comparison.
          </div>
        </div>
      </div>

      <div class="sf-section-label">Hardware &amp; Setup</div>
      <div class="sf-row"><label>System</label>
        <select name="systemPicker" id="sf-system-picker">
          <option value="">Manual entry</option>
        </select>
        <span class="sf-row-hint">Pick a saved system to prefill hardware fields</span>
      </div>
      <div class="sf-row"><label>GPU *</label><input name="gpu" placeholder="e.g. NVIDIA GeForce RTX 4070"></div>
      <div class="sf-row"><label>GPU Vendor *</label><select name="gpuVendor"><option value="" disabled selected>-- choose one --</option>${opts(gpuVendors,true)}</select></div>
      <div class="sf-row"><label>GPU Driver</label><input name="gpuDriver" placeholder="e.g. Mesa 24.1.0 or 555.42.02"></div>
      <div class="sf-row"><label>CPU *</label><input name="cpu" placeholder="e.g. AMD Ryzen 7 5800X3D"></div>
      <div class="sf-row"><label>RAM *</label><input name="ram" placeholder="e.g. 16 GB or 64"></div>
      <div class="sf-row"><label>VRAM (MB)</label><input name="vramMb" type="number" placeholder="e.g. 8192"></div>
      <div class="sf-row"><label>OS *</label><select name="os"><option value="" disabled selected>-- choose one --</option>${opts(osList,false)}</select></div>
      <div class="sf-row"><label>OS Version</label><input name="osVersion" placeholder="e.g. 24.04"></div>
      <div class="sf-row"><label>Kernel</label><input name="kernel" placeholder="e.g. 6.8.0"></div>
      <div class="sf-row"><label>Steam Playtime</label><select name="duration">${durationOpts}</select></div>
      <div class="sf-row sf-row--fps">
        <label>FPS (optional)</label>
        <div class="sf-fps-group">
          <div class="sf-fps-cell">
            <input name="fpsMin" type="number" inputmode="decimal" min="0" max="1000" step="0.1" placeholder="min">
            <button type="button" class="sf-fps-info" data-fps-info="min" aria-label="How to measure minimum FPS">i</button>
          </div>
          <div class="sf-fps-cell">
            <input name="fpsAvg" type="number" inputmode="decimal" min="0" max="1000" step="0.1" placeholder="avg">
            <button type="button" class="sf-fps-info" data-fps-info="avg" aria-label="How to measure average FPS">i</button>
          </div>
          <div class="sf-fps-cell">
            <input name="fpsMax" type="number" inputmode="decimal" min="0" max="1000" step="0.1" placeholder="max">
            <button type="button" class="sf-fps-info" data-fps-info="max" aria-label="How to measure maximum FPS">i</button>
          </div>
        </div>
      </div>
      <div class="sf-row sf-row--fps-upload">
        <label></label>
        <div class="sf-fps-upload">
          <label class="sf-fps-upload-btn" for="fpsCsvInput">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zm-14 9v2h14v-2H5z" style="transform:rotate(180deg);transform-origin:center"/></svg>
            Upload MangoHud CSV
          </label>
          <input id="fpsCsvInput" name="fpsCsv" type="file" accept=".csv,text/csv" hidden>
          <span class="sf-fps-upload-status" id="fpsCsvStatus"></span>
        </div>
      </div>
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

      <div class="sf-section-label" style="margin-top:16px">Notes ${notesFormattingHelpHtml()}</div>
      <div class="sf-row"><textarea name="notes" rows="3" placeholder="How did it run? Any issues or tweaks?"></textarea></div>

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
      <div class="sf-row" style="justify-content:flex-end;gap:8px;flex-wrap:wrap">
        <span id="submit-status" style="font-size:0.76rem;color:var(--muted)"></span>
        <button type="button" id="save-draft-btn" class="submit-report-btn submit-report-btn--secondary" title="Save the current form so you can finish it later on any signed-in device">Save Draft</button>
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

    // Async: fetch live releases + pipeline-harvested versions, extend, and persist to cache
    const pvUrl = /^localhost/.test(location.host) ? 'https://www.proton-pulse.com/proton-versions.json' : 'proton-versions.json';
    Promise.allSettled([
      fetch('https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=20')
        .then(r => r.ok ? r.json() : [])
        .then(rels => { for (const rel of rels) protonVersions.push(rel.tag_name); }),
      fetch('https://api.github.com/repos/ValveSoftware/Proton/releases?per_page=20')
        .then(r => r.ok ? r.json() : [])
        .then(rels => { for (const rel of rels) { const l = tagToLabel(rel.tag_name); if (l) protonVersions.push(l); } }),
      fetch(pvUrl).then(r => r.ok ? r.json() : []).then(vs => { if (Array.isArray(vs)) for (const v of vs) if (v) protonVersions.push(v); }).catch(() => {}),
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

  // Wire the "how to measure FPS" info buttons on the FPS row. All three
  // buttons open the same popover with quick instructions for MangoHud and
  // the SteamOS QAM performance overlay so users know how to fill the
  // fields correctly. Once the plugin auto-populates these, the buttons
  // remain useful for anyone submitting from a browser.
  wireFpsInfoButtons(container);
  wireFpsCsvUpload(container);
  wireRunTypeToggle(container);
}

// Native vs Proton toggle at the top of the report. When "Native" is
// selected we disable the Proton-only fields so the form communicates
// clearly that they do not apply, and the submitted row carries a
// definitive run_type instead of a stale Proton version guess.
// Tracks the last Steam answer for the current form so wireRunTypeToggle
// can show / hide the "Also tested Linux?" follow-up row when the user
// swaps run types after Steam has replied.
const _nativeAvailableByContainer = new WeakMap();

/**
 * Adjust the Run Type dropdown based on whether the game ships a native
 * Linux binary per Steam appdetails. Called by the submit page after
 * Steam returns.
 *
 * When Steam says no: disable the Native option so users cannot submit
 * an impossible run_type. Restored drafts / edits with a stale
 * 'native' selection bounce back to Proton.
 *
 * When Steam says yes: enable the Native option, and if the current
 * pick is a non-native Proton flavor, reveal the "Also tested Linux?"
 * follow-up row so we can capture a paired comparison in one report.
 */
export function setRunTypeNativeAvailable(container, isAvailable) {
  _nativeAvailableByContainer.set(container, !!isAvailable);
  const sel = container.querySelector('#sf-run-type-select');
  if (!sel) return;
  const nativeOpt = sel.querySelector('option[value="native"]');
  if (nativeOpt) {
    nativeOpt.disabled = !isAvailable;
    nativeOpt.textContent = isAvailable
      ? 'Native Linux -- Linux build, no Proton'
      : 'Native Linux -- not offered by Steam for this game';
  }
  if (!isAvailable && sel.value === 'native') {
    sel.value = 'proton';
    sel.dispatchEvent(new Event('change'));
  } else {
    // Re-run applyRunType so the follow-up row appears / hides now that
    // we know the answer.
    sel.dispatchEvent(new Event('change'));
  }
}

function wireRunTypeToggle(container) {
  const sel = container.querySelector('#sf-run-type-select');
  const hintEl = container.querySelector('#sf-run-type-hint');
  const alsoRow = container.querySelector('#sf-also-linux-row');
  const alsoHidden = container.querySelector('input[name="alsoTestedLinux"]');
  const alsoNotes = container.querySelector('textarea[name="alsoTestedLinuxNotes"]');
  const alsoBtns = container.querySelectorAll('#sf-also-linux-yn button');
  const protonRow = [...container.querySelectorAll('.sf-row')]
    .find(row => row.querySelector('input[name="protonVersion"]'));
  if (!sel) return;

  const versionInput = container.querySelector('input[name="protonVersion"]');
  const versionLabel = container.querySelector('#sf-runtime-version-label');
  const versionWarn  = container.querySelector('#sf-runtime-version-warn');

  const runVersionValidate = () => {
    if (!versionInput || !versionWarn) return;
    const key = sel.value || 'proton';
    if (key === 'native' || versionInput.disabled) {
      versionWarn.hidden = true;
      versionWarn.textContent = '';
      return;
    }
    const v = validateRuntimeVersion(key, versionInput.value);
    if (v.ok === false) {
      versionWarn.textContent = `Does not look like a ${RUN_TYPES[key]?.label || key} version. ${v.hint}. Submission still allowed.`;
      versionWarn.hidden = false;
    } else {
      versionWarn.hidden = true;
      versionWarn.textContent = '';
    }
  };

  const applyRunType = () => {
    const key = sel.value || 'proton';
    const isNative = key === 'native';
    const meta = RUN_TYPES[key];
    if (protonRow) {
      const input = versionInput;
      if (input) {
        input.disabled = isNative;
        input.required = !isNative;
        input.placeholder = isNative
          ? 'Not applicable for native builds'
          : (meta?.versionExample || 'e.g. Proton 9.0-4');
        if (isNative) input.value = '';
      }
      if (versionLabel) {
        // "Runtime Version" stays the label; the runtime type is picked in
        // the field above so we don't need to repeat "(Proton)" here.
        versionLabel.textContent = isNative
          ? 'Runtime Version'
          : 'Runtime Version *';
      }
      protonRow.classList.toggle('sf-row--disabled', isNative);
    }
    runVersionValidate();
    if (hintEl) {
      if (isNative) {
        hintEl.textContent = 'Proton fields are disabled. FPS + compatibility answers still apply to the native build.';
        hintEl.hidden = false;
      } else {
        hintEl.hidden = true;
        hintEl.textContent = '';
      }
    }
    // Follow-up "Also tested Linux?" row appears only when the user is
    // reporting a non-native run AND Steam has confirmed native support.
    if (alsoRow) {
      const nativeAvailable = _nativeAvailableByContainer.get(container) === true;
      alsoRow.hidden = isNative || !nativeAvailable;
    }
  };

  sel.addEventListener('change', applyRunType);
  if (versionInput) {
    versionInput.addEventListener('blur', runVersionValidate);
    versionInput.addEventListener('input', runVersionValidate);
  }
  applyRunType();

  // "Also tested Linux?" Yes/No toggle: Yes reveals the notes textarea.
  for (const btn of alsoBtns) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const val = btn.dataset.value;
      if (alsoHidden) alsoHidden.value = val;
      for (const b of alsoBtns) b.setAttribute('aria-pressed', String(b === btn));
      if (alsoNotes) alsoNotes.style.display = (val === 'yes') ? '' : 'none';
    });
  }

  // Shortcut link: file a separate Native Linux report against this app.
  const shortcut = container.querySelector('#sf-submit-native-shortcut');
  if (shortcut) {
    shortcut.addEventListener('click', (e) => {
      e.preventDefault();
      const params = new URLSearchParams(window.location.search);
      params.set('runType', 'native');
      window.location.href = `submit.html?${params.toString()}`;
    });
  }
}

function wireFpsCsvUpload(container) {
  const input = container.querySelector('#fpsCsvInput');
  const status = container.querySelector('#fpsCsvStatus');
  if (!input || !status) return;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    status.textContent = 'Parsing...';
    status.classList.remove('sf-fps-upload-status--err');
    try {
      const text = await file.text();
      // Lazy-load the parser -- it is small but only relevant when someone
      // actually uploads a file, and the module is separately testable.
      const { parseMangohudCsv } = await import('../shared/mangohud-csv.js');
      const result = parseMangohudCsv(text);
      if (result.error) {
        status.textContent = result.error;
        status.classList.add('sf-fps-upload-status--err');
        return;
      }
      const form = container.querySelector('#submit-report-form') || container.querySelector('form');
      if (form) {
        if (form.fpsMin && result.fpsMin != null) form.fpsMin.value = String(result.fpsMin);
        if (form.fpsAvg && result.fpsAvg != null) form.fpsAvg.value = String(result.fpsAvg);
        if (form.fpsMax && result.fpsMax != null) form.fpsMax.value = String(result.fpsMax);
      }
      status.textContent = `Filled from ${result.sampleCount.toLocaleString()} MangoHud samples`;
    } catch (e) {
      status.textContent = `Could not read file: ${(e && e.message) || e}`;
      status.classList.add('sf-fps-upload-status--err');
    } finally {
      // Reset input so uploading the same file again re-triggers change.
      input.value = '';
    }
  });
}

function wireFpsInfoButtons(container) {
  const buttons = container.querySelectorAll('.sf-fps-info');
  if (!buttons.length) return;
  const showPopover = (btn) => {
    document.querySelectorAll('.sf-fps-popover').forEach(n => n.remove());
    const pop = document.createElement('div');
    pop.className = 'sf-fps-popover';
    pop.innerHTML = `
      <div class="sf-fps-popover-title">How to measure FPS</div>
      <ul>
        <li><strong>SteamOS (Steam Deck):</strong>
          Press the <em>...</em> button to open Quick Access,
          go to Performance, turn on
          <em>Show Performance Overlay</em> at level 3 or higher.
          Min / avg / max show while you play.
          <a href="https://www.steamdeck.com/en/support" target="_blank" rel="noopener">Steam Deck docs -&gt;</a></li>
        <li><strong>MangoHud (desktop Linux):</strong>
          install <code>mangohud</code>, then launch Steam games with
          <code>mangohud %command%</code> in the launch options,
          or <code>MANGOHUD=1 %command%</code>.
          Enable <code>fps_min</code> and <code>fps_max</code> in
          <code>~/.config/MangoHud/MangoHud.conf</code>.
          <a href="https://github.com/flightlessmango/MangoHud#configuration" target="_blank" rel="noopener">MangoHud config -&gt;</a></li>
        <li><strong>Have a MangoHud log?</strong> Use the
          <em>Upload MangoHud CSV</em> button below the FPS row to
          auto-fill min / avg / max from your file.</li>
        <li><strong>Coming soon:</strong> the Decky plugin will
          auto-sample MangoHud during play and pre-fill these fields.</li>
      </ul>
      <div class="sf-fps-popover-close-row">
        <button type="button" class="sf-fps-popover-close">Close</button>
      </div>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    // Anchor to the button; nudge into viewport if we overflow the right edge.
    pop.style.top = `${window.scrollY + r.bottom + 6}px`;
    const preferredLeft = r.left + window.scrollX;
    const rightEdge = preferredLeft + pop.offsetWidth;
    const overflow = rightEdge - (window.scrollX + window.innerWidth) + 12;
    pop.style.left = `${Math.max(8, preferredLeft - Math.max(0, overflow))}px`;
    const close = () => pop.remove();
    pop.querySelector('.sf-fps-popover-close')?.addEventListener('click', close);
    // Dismiss on outside click / Escape.
    setTimeout(() => {
      document.addEventListener('click', function onDoc(e) {
        if (!pop.contains(e.target) && e.target !== btn) { close(); document.removeEventListener('click', onDoc); }
      });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
      });
    }, 0);
  };
  for (const btn of buttons) {
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showPopover(btn); });
  }
}
