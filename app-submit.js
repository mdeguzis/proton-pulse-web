// Form submission + populate-submit-form -- factored out of app.js.
// Loaded as a classic script BEFORE app.js so its globals
// (submitReport, populateSubmitForm, prefillSubmitFormFromMyHardware,
// loadFormSchema, formSchema, MYHW_FORM_MAP, getWebClientId,
// getProtonPulseUserIdFromSession, getWebSource, normalizeRam) are
// available when app.js runs. Depends on FAULT_KEYS_WEB +
// deriveRatingFromState + inferProtonType from app-scoring.js.

function getWebClientId() {
  const key = 'proton-pulse:web-client-id';
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
}

function getProtonPulseUserIdFromSession(session) {
  return session?.user?.id || null;
}

function getWebSource() {
  const ua = navigator.userAgent || '';
  if (/SteamGamepad|SteamDeck/.test(ua) || (/Linux/.test(ua) && /Valve/.test(ua))) return 'web-steamdeck';
  if (/Linux/.test(ua)) return 'web-linux';
  if (/Windows/.test(ua)) return 'web-windows';
  if (/Mac/.test(ua)) return 'web-macos';
  return 'web';
}

let formSchema      = null;   // loaded from form-schema.json

async function loadFormSchema() {
  if (formSchema) return formSchema;
  try {
    const r = await fetch('form-schema.json');
    formSchema = r.ok ? await r.json() : null;
  } catch { formSchema = null; }
  return formSchema;
}

function normalizeRam(raw) {
  const n = parseInt((raw || '').replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? raw.trim() : `${n} GB`;
}




async function submitReport(appId, title, form) {
  const session = await SupaAuth.getSession();
  if (!session) return { ok: false, error: 'Sign in with Steam to submit a report.' };
  const protonPulseUserId = getProtonPulseUserIdFromSession(session);
  const state = form._formState || {};
  const installFailed = state.canInstall === 'no' || state.canStart === 'no' || state.canPlay === 'no';
  const derivedRating = deriveRatingFromState(state);
  const formResponses = {
    canInstall: state.canInstall || null,
    canStart:   state.canStart   || null,
    canPlay:    state.canPlay    || null,
    protonType: inferProtonType(form.protonVersion.value),
    tinkeringMethods: state.tinkeringMethods ? [...state.tinkeringMethods] : [],
    isTinker: !!(state.tinkeringMethods && state.tinkeringMethods.size > 0),
    ...Object.fromEntries(FAULT_KEYS_WEB.map(k => [k, state.faults?.[k] || null])),
    onlineMultiplayer: state.onlineMultiplayer || null,
    localMultiplayer:  state.localMultiplayer  || null,
    verdict:    installFailed ? 'no' : (state.verdict || null),
    verdictOob: installFailed ? null : (state.verdictOob || null),
    // framegen is informational only, never read by scoring (app-scoring.js)
    requiresFramegen: installFailed ? null : (state.requiresFramegen || null),
    summary:    null,
  };
  const body = {
    client_id: getWebClientId(),
    proton_pulse_user_id: protonPulseUserId,
    app_id: appId,
    title: title,
    cpu: form.cpu.value,
    gpu: form.gpu.value,
    gpu_driver: form.gpuDriver.value,
    gpu_vendor: form.gpuVendor.value,
    ram: normalizeRam(form.ram.value),
    os: (form.os.value + (form.osVersion.value ? ' ' + form.osVersion.value.trim() : '')),
    kernel: form.kernel.value,
    proton_version: form.protonVersion.value,
    duration: form.duration.value || 'unreported',
    rating: derivedRating || 'borked',
    notes: form.notes.value,
    launch_options: form.launchOptions.value,
    enabled_vars: {},
    confidence_score: null,
    source: form.reportSource?.value || getWebSource(),
    vram_mb: form.vramMb.value ? Number(form.vramMb.value) : null,
    game_owned: form.gameOwned?.checked ?? false,
    form_responses: formResponses,
  };
  const r = await fetch(`${SB_URL}/user_configs?on_conflict=client_id,app_id`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      'x-client-id': body.client_id,
      Prefer: 'resolution=merge-duplicates,return=minimal',
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
const MYHW_FORM_MAP = {
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
function prefillSubmitFormFromMyHardware(el) {
  // your code here
}

async function populateSubmitForm(el) {
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
      <div class="sf-section-label">Hardware &amp; Setup</div>
      <div class="sf-row"><label>Proton Version *</label>
        <input name="protonVersion" list="proton-versions" required placeholder="e.g. Proton 9.0-4 or GE-Proton9-7">
        <datalist id="proton-versions">
          ${(schema.knownProtonVersions || []).map(v => '<option value="'+esc(v)+'">').join('')}
        </datalist>
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

      <div class="sf-question sf-hidden" id="q-verdict">
        <div class="sf-q-label">Overall, did the game work? *</div>
        ${ynBtns('verdict')}
      </div>

      <div class="sf-question sf-hidden" id="q-oob">
        <div class="sf-q-label">Did it work out of the box (no tinkering needed)? *</div>
        ${ynBtns('verdictOob')}
      </div>

      <div class="sf-question sf-hidden" id="q-framegen">
        <div class="sf-q-label">Did this game require framegen (FSR, LSFG, DLSS-G, etc.) to hit smooth gameplay / 60 FPS?</div>
        <div class="sf-q-hint">Optional. Helps separate games that work natively from those leaning on upscalers.</div>
        ${ynBtns('requiresFramegen')}
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
      <div class="sf-row sf-row--check">
        <label class="sf-check-label"><input type="checkbox" name="gameOwned"> I own this game on Steam</label>
        <span class="sf-check-hint">Adds a verified owner badge to your report</span>
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

    // Tinkering + faults + verdict only when all install steps pass
    if (allInstallYes) { show('q-tinkering'); show('q-faults'); show('q-verdict'); }
    else { hide('q-tinkering'); hide('q-faults'); hide('q-verdict'); }

    // Out-of-box only if verdict=yes and 0 faults
    if (showOob) show('q-oob'); else { hide('q-oob'); state.verdictOob = null; clearRadios('verdictOob'); }

    // Framegen reveals whenever the game is reported as playable (verdict=yes
    // means it works, just maybe with help). Optional, so we don't reset on
    // verdict=no -- but we DO clear it on install failure since the question
    // would be meaningless
    const showFramegen = allInstallYes && state.verdict === 'yes';
    if (showFramegen) show('q-framegen');
    else { hide('q-framegen'); state.requiresFramegen = null; clearRadios('requiresFramegen'); }

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

  // Wire yes/no radio buttons
  ['canInstall','canStart','canPlay','verdict','verdictOob'].forEach(name => {
    form.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
      radio.addEventListener('change', () => {
        state[name] = radio.value;
        updateFormUI();
      });
    });
  });

  // Wire fault radios
  FAULT_KEYS_WEB.forEach(k => {
    form.querySelectorAll(`input[name="${k}"]`).forEach(radio => {
      radio.addEventListener('change', () => {
        state.faults[k] = radio.value;
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

  // - Populate proton datalist: schema defaults + live GE-Proton + official Proton releases
  const dl = container.querySelector('#proton-versions');
  if (dl) {
    const known = new Set(schema.knownProtonVersions || []);
    const tagToLabel = tag => {
      // proton-10.0-4 -> "Proton 10.0-4", ignore pre-release suffixes like -beta3
      const m = tag.match(/^proton-(\d+\.\d+-\d+)$/i);
      return m ? `Proton ${m[1]}` : null;
    };
    await Promise.allSettled([
      fetch('https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=20')
        .then(r => r.ok ? r.json() : [])
        .then(rels => { for (const rel of rels) known.add(rel.tag_name); }),
      fetch('https://api.github.com/repos/ValveSoftware/Proton/releases?per_page=20')
        .then(r => r.ok ? r.json() : [])
        .then(rels => { for (const rel of rels) { const l = tagToLabel(rel.tag_name); if (l) known.add(l); } }),
    ]);
    dl.innerHTML = [...known].map(v => '<option value="'+esc(v)+'">').join('');
  }
}
