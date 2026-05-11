const SB_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
const SB_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
const STEAM_IMG = id => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;
// On github.io project page the URL is /proton-pulse-data/..., on the custom
// domain (www.proton-pulse.com) it serves from root. Keep SITE_BASE empty on
// the custom domain so links don't get a bogus prefix.
const SITE_BASE = (() => {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[0] === 'proton-pulse-data' ? '/proton-pulse-data' : '';
})();
// Pull data files from the same origin the page is loaded from, so both URLs
// keep working during the custom-domain transition.
const CDN = `${window.location.origin}${SITE_BASE}/data`;
const dataFilesHref = appId => `${SITE_BASE}/data/${appId}/`;
// Steam app IDs are sequentially assigned and currently top out ~3 million.
// Non-Steam shortcut IDs are CRC32-derived and can be any 32-bit value.
// Any ID above 10 million is treated as a non-Steam shortcut.
const isNonSteamAppId = id => Number(id) > 10_000_000;

const RATING_COLORS = {
  platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0',
  bronze: '#b07040', borked: '#c85050', pending: '#3a4a5a'
};
const RATING_TEXT = {
  platinum: '#0a0c10', gold: '#0a0c10', silver: '#0a0c10',
  bronze: '#0a0c10', borked: '#fff', pending: '#c8d4e0'
};

let searchIndex     = null;   // [[appId, title], ...]
let searchFocusIdx  = -1;
let scoringInfo     = null;   // loaded from scoring-info.json

async function loadScoringInfo() {
  if (scoringInfo) return scoringInfo;
  try {
    const r = await fetch('scoring-info.json');
    scoringInfo = r.ok ? await r.json() : null;
  } catch { scoringInfo = null; }
  return scoringInfo;
}

function normalizeOs(raw) {
  if (!raw) return '';
  let s = raw.trim();
  if (/^\d+$/.test(s)) return '';
  // strip parenthetical suffixes
  s = s.replace(/\s*\(.*\)$/, '');
  // strip trailing edition/variant words
  s = s.replace(/\s+(LTS|Holo|Core|Silverblue|Kinoite|Workstation|Server|Desktop)$/i, '');
  // collapse long build versions like "44.20260407.n.0" to just "44"
  s = s.replace(/\s(\d{1,3})\.\d{5,}[\w.]*/g, ' $1');
  // "24.04.3" -> "24.04"
  s = s.replace(/(\d+\.\d+)\.\d+/g, '$1');
  return s.trim();
}

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

async function submitReport(appId, title, form) {
  const session = await SupaAuth.getSession();
  if (!session) return { ok: false, error: 'Sign in with Steam to submit a report.' };
  const protonPulseUserId = getProtonPulseUserIdFromSession(session);
  const body = {
    client_id: getWebClientId(),
    proton_pulse_user_id: protonPulseUserId,
    app_id: appId,
    title: title,
    cpu: form.cpu.value,
    gpu: form.gpu.value,
    gpu_driver: form.gpuDriver.value,
    gpu_vendor: form.gpuVendor.value,
    ram: form.ram.value,
    os: (form.os.value + (form.osVersion.value ? ' ' + form.osVersion.value.trim() : '')),
    kernel: form.kernel.value,
    proton_version: form.protonVersion.value,
    duration: form.duration.value || 'unreported',
    rating: form.rating.value,
    notes: form.notes.value,
    launch_options: form.launchOptions.value,
    enabled_vars: {},
    confidence_score: null,
    source: form.reportSource?.value || getWebSource(),
    vram_mb: form.vramMb.value ? Number(form.vramMb.value) : null,
  };
  const r = await fetch(`${SB_URL}/user_configs?on_conflict=client_id,app_id`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true };
  try {
    const err = await r.json();
    return { ok: false, error: err.message || err.hint || `HTTP ${r.status}` };
  } catch {
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
  const ratings = schema.validRatings || [];
  const osList = schema.validOs || [];
  const gpuVendors = schema.validGpuVendors || [];
  const opts = (arr, cap) => arr.map(v => `<option value="${esc(v)}">${cap ? v[0].toUpperCase()+v.slice(1) : esc(v)}</option>`).join('');
  container.innerHTML = `
    <h3 style="margin:0 0 12px">Submit a Pulse Report</h3>
    <details class="scoring-guide">
      <summary>How Scoring Works</summary>
      <div class="scoring-guide-body">
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#b4c7dc;color:#111">Platinum</span><span class="scoring-guide-rule">Can install, start, and play. No faults. Works out of the box without tinkering.</span></div>
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#c8a050;color:#111">Gold</span><span class="scoring-guide-rule">Can install, start, and play. No faults. Works but required tinkering (launch options, config, etc.).</span></div>
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#8fa0b0;color:#111">Silver</span><span class="scoring-guide-rule">Can install, start, and play. Exactly 2 faults reported.</span></div>
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#b07040;color:#fff">Bronze</span><span class="scoring-guide-rule">Can install, start, and play. 3 or more faults. Significant issues.</span></div>
        <div class="scoring-guide-row"><span class="scoring-guide-badge" style="background:#c85050;color:#fff">Borked</span><span class="scoring-guide-rule">Cannot install, start, or play -- or overall verdict is No.</span></div>
        <div class="scoring-guide-section">Fault questions</div>
        <div class="scoring-guide-note">Each "Yes" to a fault question (performance, graphical, windowing, audio, input, stability, save game, significant bugs) counts as 1 fault. 1 fault = Gold, 2 = Silver, 3+ = Bronze.</div>
        <div class="scoring-guide-section">Out-of-the-box question</div>
        <div class="scoring-guide-note">Only shown when verdict is Yes and no faults are reported. Answering Yes elevates Gold to Platinum.</div>
      </div>
    </details>
    <form id="submit-report-form" autocomplete="on">
      <div class="sf-row"><label>Rating *</label><select name="rating" required><option value="" disabled selected>-- choose one --</option>${opts(ratings,true)}</select></div>
      <div class="sf-row"><label>Proton Version *</label>
        <input name="protonVersion" list="proton-versions" required placeholder="e.g. Proton 9.0-4 or GE-Proton9-7">
        <datalist id="proton-versions">
          ${(schema.knownProtonVersions || []).map(v => '<option value="'+esc(v)+'">').join('')}
        </datalist>
        <span class="sf-hint" id="proton-hint" style="display:none;color:#c87840;font-size:0.7rem;white-space:nowrap">Format: Proton X.Y-Z or GE-ProtonX-Y</span>
      </div>
      <div class="sf-row"><label>GPU *</label><input name="gpu" required placeholder="e.g. NVIDIA GeForce RTX 4070"></div>
      <div class="sf-row"><label>GPU Vendor *</label><select name="gpuVendor" required><option value="" disabled selected>-- choose one --</option>${opts(gpuVendors,true)}</select></div>
      <div class="sf-row"><label>GPU Driver</label><input name="gpuDriver" placeholder="e.g. Mesa 24.1.0 or 555.42.02"></div>
      <div class="sf-row"><label>CPU *</label><input name="cpu" required placeholder="e.g. AMD Ryzen 7 5800X3D"></div>
      <div class="sf-row"><label>RAM *</label><input name="ram" required placeholder="e.g. 16 GB" pattern="\\d+ GB" title="Format: number followed by GB, e.g. 16 GB"></div>
      <div class="sf-row"><label>VRAM (MB)</label><input name="vramMb" type="number" placeholder="e.g. 8192"></div>
      <div class="sf-row"><label>OS *</label><select name="os" required><option value="" disabled selected>-- choose one --</option>${opts(osList,false)}</select><input name="osVersion" placeholder="Version (e.g. 24.04)" style="max-width:120px"></div>
      <div class="sf-row"><label>Kernel</label><input name="kernel" placeholder="e.g. 6.8.0"></div>
      <div class="sf-row"><label>Duration</label><input name="duration" placeholder="e.g. severalHours"></div>
      <div class="sf-row"><label>Launch Options</label><input name="launchOptions" placeholder="e.g. PROTON_USE_WINED3D=1 %command%"></div>
      <div class="sf-row"><label>Notes *</label><textarea name="notes" rows="3" required placeholder="How did it run? Any issues or tweaks?"></textarea></div>
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
  // Populate proton datalist: schema defaults + live GE-Proton releases from GitHub
  const dl = container.querySelector('#proton-versions');
  if (dl) {
    try {
      const r = await fetch('https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=20');
      if (r.ok) {
        const geTags = (await r.json()).map(rel => rel.tag_name);
        const known = new Set(schema.knownProtonVersions || []);
        for (const tag of geTags) known.add(tag);
        dl.innerHTML = [...known].map(v => '<option value="'+esc(v)+'">').join('');
      }
    } catch { /* keep schema defaults */ }
  }
}
// -- Routing ------------------------------------------

async function populateScoringTooltip(el) {
  const container = el.querySelector('#rating-info-content');
  if (!container || container.dataset.loaded) return;
  const s = await loadScoringInfo();
  if (!s) { container.textContent = 'Could not load scoring-info.json'; return; }
  const w = s.weights;
  const rs = s.ratingScores;
  const t = s.scoreTiers;
  const ratingLine = Object.entries(rs).map(([k,v]) => `${k[0].toUpperCase()+k.slice(1)}=${Math.round(v*w.BASE_MAX)}`).join(', ');
  const tierLine = Object.entries(t).map(([k,v]) => `>=${v}: ${k[0].toUpperCase()+k.slice(1)}`).join(' | ') + ' | <' + t.bronze + ': Borked';
  const osFams = Object.entries(s.osFamilies).map(([parent, kids]) => `${parent}: ${kids.join(', ')}`).join(' | ');
  container.innerHTML = `
    <h3 style="margin:0 0 10px">ProtonDB Ratings</h3>
    <span style="color:#b4c7dc">Platinum</span> - Runs perfectly out of the box<br>
    <span style="color:#c8a050">Gold</span> - Runs after tweaks<br>
    <span style="color:#8fa0b0">Silver</span> - Runs with minor issues<br>
    <span style="color:#b07040">Bronze</span> - Runs but with significant issues<br>
    <span style="color:#c85050">Borked</span> - Does not run or is unplayable<br><br>
    The tier shown is the most common rating across all reports for this game.<br><br>

    <h3 style="margin:0 0 10px">Confidence Scoring</h3>
    Each report gets a relevance score (0-100) based on how closely it matches <em>your</em> hardware when viewed in the Decky plugin. On this website, an estimate is shown without local system info.<br><br>

    <h4 style="margin:0 0 6px">1. Base Rating (0-${w.BASE_MAX} pts)</h4>
    <code>${ratingLine}</code><br>
    Borked reports older than ${w.BORKED_DECAY_DAYS} days are treated as Bronze.<br><br>

    <h4 style="margin:0 0 6px">2. Recency Bonus</h4>
    <code>&lt;90 days: +${w.RECENCY_RECENT} | 90-365 days: +${w.RECENCY_MID} | &gt;1 year: ${w.RECENCY_OLD}</code><br><br>

    <h4 style="margin:0 0 6px">3. Custom Proton Bonus (+${w.CUSTOM_PROTON})</h4>
    Reports using ${s.customProtonMarkers.join(', ')} builds get +${w.CUSTOM_PROTON}.<br><br>

    <h4 style="margin:0 0 6px">4. Proton Version Match</h4>
    <code>Same major: +${w.PROTON_MATCH} | Adjacent: +${w.PROTON_CLOSE}</code><br><br>

    <h4 style="margin:0 0 6px">5. GPU Multiplier</h4>
    <code>Same vendor: ${w.GPU_MATCH}x | Different: ${w.GPU_MISMATCH}x | Unknown: ${w.GPU_UNKNOWN}x</code><br>
    Same vendor + same driver major: ${w.GPU_DRIVER_EXACT}x | Close driver: ${w.GPU_DRIVER_CLOSE}x<br><br>

    <h4 style="margin:0 0 6px">6. OS Multiplier</h4>
    <code>Exact match: ${w.OS_EXACT}x | Same family: ${w.OS_FAMILY_MATCH}x</code><br>
    Families: ${osFams}<br><br>

    <h4 style="margin:0 0 6px">7. Kernel Multiplier</h4>
    <code>Exact: ${w.KERNEL_EXACT}x | Same minor: ${w.KERNEL_PATCH_CLOSE}x | Same major: ${w.KERNEL_MINOR_CLOSE}x</code><br>
    Valve/SteamOS kernels compare build numbers instead of upstream versions.<br><br>

    <h4 style="margin:0 0 6px">8. Notes Sentiment (-${w.NOTES_MAX} to +${w.NOTES_MAX})</h4>
    Negative keywords: <code>${s.negativeKeywords.join(', ')}</code> (-3 each)<br>
    Positive keywords: <code>${s.positiveKeywords.join(', ')}</code> (+2 each)<br>
    Negation-aware: "no crash" does NOT count as negative.<br><br>

    <h4 style="margin:0 0 6px">Final Formula</h4>
    <code>${s.formula}</code><br><br>

    <h4 style="margin:0 0 6px">Score-to-Tier Mapping</h4>
    <code>${tierLine}</code><br><br>

    <a href="${s._source}" target="_blank" rel="noopener" style="color:var(--accent)">View full scoring source on GitHub</a>
  `;
  container.dataset.loaded = '1';
}

function getRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const m = h.match(/^app\/(\d+)/);
  const q = new URLSearchParams(location.search).get('q')?.trim() || '';
  if (m) return { page: 'app', appId: m[1], query: q };
  if (q) return { page: 'search', query: q };
  return { page: 'home', query: '' };
}

window.addEventListener('hashchange', () => route());
window.addEventListener('popstate', () => route());
route();

async function route() {
  const r = getRoute();
  const routeSearchInput = document.getElementById('search');
  if (routeSearchInput) {
    routeSearchInput.value = r.page === 'search' ? r.query : '';
  }
  if (r.page === 'app') await renderGamePage(r.appId);
  else if (r.page === 'search') await renderSearchPage(r.query);
  else await renderHomePage();
}

async function renderHomePage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading Proton Pulse reports...</div>';
  try {
    // Kick off the search index load in parallel so we can mark cards that
    // also have ProtonDB data without blocking on the configs fetch
    const [r, pulseReports] = await Promise.all([
      fetch(
        `${SB_URL}/user_proton_configs?is_published=eq.true&select=id,voter_id,app_id,app_name,config,updated_at,is_published&order=updated_at.desc`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      ),
      fetchRecentPulseReports(),
      loadSearchIndex(),
    ]);
    const configRows = r.ok
      ? latestPerApp(await r.json()).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      : [];
    if (!configRows.length && !pulseReports.length) {
      el.innerHTML = await renderHomeFallback();
      return;
    }
    // Build a quick lookup of app IDs that also appear in the ProtonDB search
    // index so we can tag those cards with both badges
    const protonDbAppIds = new Set((searchIndex || []).map(([id]) => String(id)));
    el.innerHTML = `
      ${pulseReports.length ? `
        <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Reports</p>
        <div class="cards" style="border:1px solid var(--border);margin-bottom:16px">
          ${renderPulseReportCards(pulseReports)}
        </div>` : ''}
      ${configRows.length ? `
        <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Configs</p>
        <div class="cards" style="border:1px solid var(--border)">
          ${configRows.map(row => {
          const cfg = row.config || {};
          const name = row.app_name || cfg.appName || `App ${row.app_id}`;
          const proton = cfg.protonVersion || '';
          const profile = cfg.profileName || '';
          const d = Math.round((Date.now() / 1000 - new Date(row.updated_at).getTime() / 1000) / 86400);
          const age = d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
          const hwParts = [proton, profile].filter(Boolean);
          const isNonSteam = cfg.isNonSteam === true || isNonSteamAppId(row.app_id);
          const hasProtonDb = !isNonSteam && protonDbAppIds.has(String(row.app_id));
          return `
            <a class="card" href="#/app/${row.app_id}" style="text-decoration:none">
              <img src="${STEAM_IMG(row.app_id)}" onerror="this.style.display='none'" alt=""
                   style="width:108px;height:40px;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">
              <div class="left">
                <div class="proton">${esc(name)}</div>
                <div class="hw">${hwParts.length ? hwParts.map(esc).join(' | ') : ''}</div>
                <div class="age">${age}</div>
              </div>
              <div class="right" style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
                <span class="source-badge pulse">
                  <img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse
                </span>
                ${hasProtonDb ? '<span class="source-badge protondb">ProtonDB</span>' : ''}
                ${isNonSteam
                  ? '<span class="source-badge non-steam-game">Non-Steam</span>'
                  : '<span class="source-badge steam-game">Steam</span>'}
              </div>
            </a>`;
          }).join('')}
        </div>` : ''}`;
  } catch {
    el.innerHTML = '<div class="state-box">Search for a game above or navigate to <code>#/app/{appId}</code></div>';
  }
}

async function renderHomeFallback() {
  const [pulseReports] = await Promise.all([
    fetchRecentPulseReports(),
    loadSearchIndex(),
  ]);
  const popularIds = ['730', '570', '440', '292030', '1245620', '1091500', '1174180', '413150'];
  const titleById = new Map((searchIndex || []).map(([id, title]) => [String(id), title]));
  const popularCards = popularIds
    .map((appId) => ({ appId, title: titleById.get(appId) || `App ${appId}` }))
    .filter((row) => row.title)
    .map((row) => `
      <a class="card" href="#/app/${row.appId}" style="text-decoration:none">
        <img src="${STEAM_IMG(row.appId)}" onerror="this.style.display='none'" alt=""
             style="width:108px;height:40px;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">
        <div class="left">
          <div class="proton">${esc(row.title)}</div>
          <div class="hw">Open ProtonDB and Proton Pulse reports</div>
        </div>
        <div class="right"><span class="source-badge protondb">ProtonDB</span></div>
      </a>`)
    .join('');

  const pulseCards = renderPulseReportCards(pulseReports);

  return `
    ${pulseCards ? `
      <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Reports</p>
      <div class="cards" style="border:1px solid var(--border);margin-bottom:16px">
        ${pulseCards}
      </div>` : ''}
    <p class="section-label" style="margin-bottom:10px">Popular ProtonDB Reports</p>
    <div class="cards" style="border:1px solid var(--border)">
      ${popularCards}
    </div>`;
}

function renderPulseReportCards(rows) {
  return rows.map((row) => `
    <a class="card" href="#/app/${row.app_id}" style="text-decoration:none">
      <img src="${STEAM_IMG(row.app_id)}" onerror="this.style.display='none'" alt=""
           style="width:108px;height:40px;object-fit:cover;flex-shrink:0;border:1px solid var(--border)">
      <div class="left">
        <div class="proton">${esc(row.title || `App ${row.app_id}`)}</div>
        <div class="hw">${esc([row.rating, row.proton_version].filter(Boolean).join(' | '))}</div>
        <div class="age">${daysAgo(Math.floor(new Date(row.created_at).getTime() / 1000))}</div>
      </div>
      <div class="right"><span class="source-badge pulse"><img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse</span></div>
    </a>`)
    .join('');
}

async function fetchRecentPulseReports() {
  try {
    const r = await fetch(
      `${SB_URL}/user_configs?select=id,app_id,title,rating,proton_version,created_at,source&order=created_at.desc&limit=8`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    return latestPerApp(await r.json()).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    return [];
  }
}

function latestPerApp(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = String(row.app_id || row.appId || '');
    if (!key) continue;
    const existing = seen.get(key);
    const rowTime = row.updated_at || row.created_at || '';
    const existingTime = existing?.updated_at || existing?.created_at || '';
    if (!existing || rowTime > existingTime) seen.set(key, row);
  }
  return [...seen.values()];
}

async function fetchMatchingPulseConfigs(query) {
  const q = query.trim();
  if (!q) return [];
  try {
    const url = new URL(`${SB_URL}/user_proton_configs`);
    url.searchParams.set('select', 'id,voter_id,app_id,app_name,config,updated_at,is_published');
    url.searchParams.set('is_published', 'eq.true');
    url.searchParams.set('order', 'updated_at.desc');
    url.searchParams.set('limit', '60');
    if (/^\d+$/.test(q)) {
      url.searchParams.set('or', `(app_id.eq.${q},app_name.ilike.*${q}*)`);
    } else {
      url.searchParams.set('app_name', `ilike.*${q}*`);
    }
    const r = await fetch(url.toString(), {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) return [];
    return latestPerApp(await r.json()).map((row) => {
      const cfg = row.config || {};
      return {
        appId: row.app_id,
        appName: row.app_name || cfg.appName || `App ${row.app_id}`,
        profileName: cfg.profileName || 'Unnamed Config',
        protonVersion: cfg.protonVersion || '',
        updatedAt: row.updated_at,
        source: cfg.source || 'proton-pulse',
      };
    });
  } catch {
    return [];
  }
}

// Return distinct app_ids from user_configs (Pulse compatibility reports) that
// match the query. Used to tag search results with the Pulse badge even when
// the game has no saved launch profile yet
async function fetchMatchingPulseReportAppIds(query) {
  const q = query.trim();
  if (!q) return new Set();
  try {
    const url = new URL(`${SB_URL}/user_configs`);
    url.searchParams.set('select', 'app_id');
    url.searchParams.set('limit', '100');
    if (/^\d+$/.test(q)) {
      url.searchParams.set('or', `(app_id.eq.${q},title.ilike.*${q}*)`);
    } else {
      url.searchParams.set('title', `ilike.*${q}*`);
    }
    const r = await fetch(url.toString(), {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) return new Set();
    const rows = await r.json();
    return new Set(rows.map((row) => String(row.app_id)));
  } catch {
    return new Set();
  }
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

// -- Data fetching ------------------------------------

async function fetchCdn(appId) {
  try {
    const r = await fetch(`${CDN}/${appId}/latest.json`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

/** Deduplicate rows by voter_id, keeping only the most recent per unique client. */
function latestPerClient(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.voter_id || row.config?.clientId || Math.random();
    const existing = seen.get(key);
    if (!existing || row.updated_at > existing.updated_at) seen.set(key, row);
  }
  return [...seen.values()];
}

async function fetchSupabase(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/user_proton_configs?app_id=eq.${appId}&is_published=eq.true&select=id,voter_id,app_id,app_name,config,updated_at,is_published&order=updated_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    const rows = latestPerClient(await r.json());

    return rows.map(row => {
      const cfg = row.config || {};
      return {
        appId:         row.app_id,
        configId:      row.id ?? null,
        clientId:      row.voter_id || cfg.clientId || '',
        profileName:   cfg.profileName || '',
        protonVersion: cfg.protonVersion || '',
        launchOptions: cfg.launchOptions || '',
        enabledVars:   cfg.enabledVars   || {},
        appName:       row.app_name || cfg.appName || `App ${row.app_id}`,
        timestamp:     Math.floor(new Date(row.updated_at).getTime() / 1000),
        source:        cfg.source || 'proton-pulse',
        cpu:           cfg.cpu   || null,
        gpu:           cfg.gpu   || null,
        gpuVendor:     cfg.gpuVendor || null,
        gpuDriver:     cfg.gpuDriver || null,
        ram:           cfg.ram   || null,
        os:            cfg.os    || null,
        kernel:        cfg.kernel || null,
        isNonSteam:    cfg.isNonSteam === true,
        pluginVersion: cfg.pluginVersion || null,
        isEdited:      cfg.isEdited === true,
      };
    });
  } catch { return []; }
}

async function fetchNativeReports(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/user_configs?app_id=eq.${appId}&select=id,client_id,app_id,title,cpu,gpu,gpu_driver,gpu_vendor,ram,os,kernel,proton_version,rating,duration,notes,vram_mb,form_responses,created_at,source&order=created_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    const rows = await r.json();
    // keep only the latest submission per client
    const seen = new Map();
    for (const row of rows) {
      const key = row.client_id || Math.random();
      const existing = seen.get(key);
      if (!existing || row.created_at > existing.created_at) seen.set(key, row);
    }
    return [...seen.values()].map(row => ({
      reportId:          row.id ?? null,
      appId:             row.app_id,
      clientId:          row.client_id || '',
      title:             row.title || `App ${row.app_id}`,
      cpu:               row.cpu || '',
      gpu:               row.gpu || '',
      gpuDriver:         row.gpu_driver || '',
      gpuVendor:         row.gpu_vendor || '',
      ram:               row.ram || '',
      os:                row.os || '',
      kernel:            row.kernel || '',
      protonVersion:     row.proton_version || '',
      rating:            row.rating || '',
      duration:          row.duration || '',
      notes:             row.notes || '',
      vramMb:            row.vram_mb ?? null,
      formResponses:     row.form_responses ?? null,
      timestamp:         Math.floor(new Date(row.created_at).getTime() / 1000),
      source:            row.source || 'proton-pulse',
    }));
  } catch { return []; }
}

async function fetchVotes(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/report_vote_totals?app_id=eq.${appId}&select=report_key,upvotes,downvotes`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return {};
    const rows = await r.json();
    const totals = {};
    for (const v of rows) {
      totals[v.report_key] = { up: Number(v.upvotes || 0), down: Number(v.downvotes || 0) };
    }
    return totals;
  } catch { return {}; }
}

async function fetchUserVotes(appId) {
  try {
    const voterId = getWebClientId();
    if (!voterId) return {};
    const r = await fetch(
      `${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${appId}&select=report_key,vote`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return {};
    const rows = await r.json();
    const result = {};
    for (const row of rows) result[row.report_key] = row.vote;
    return result;
  } catch { return {}; }
}

async function castVote(appId, rKey, vote, upBtn, dnBtn) {
  const voterId = getWebClientId();
  const wasUp = upBtn.classList.contains('active');
  const wasDn = dnBtn.classList.contains('active');
  const upCount = upBtn.querySelector('.vote-count');
  const dnCount = dnBtn.querySelector('.vote-count');
  const up = parseInt(upCount.textContent) || 0;
  const dn = parseInt(dnCount.textContent) || 0;

  const isUndo = (vote === 1 && wasUp) || (vote === -1 && wasDn);

  upBtn.classList.remove('active');
  dnBtn.classList.remove('active');

  if (isUndo) {
    if (vote === 1) upCount.textContent = Math.max(0, up - 1);
    else dnCount.textContent = Math.max(0, dn - 1);
    try {
      await fetch(`${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${String(appId)}&report_key=eq.${encodeURIComponent(rKey)}`, {
        method: 'DELETE',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'return=minimal' },
      });
    } catch { /* silently fail */ }
    return;
  }

  if (vote === 1) {
    upBtn.classList.add('active');
    upCount.textContent = up + 1;
    if (wasDn) dnCount.textContent = Math.max(0, dn - 1);
  } else {
    dnBtn.classList.add('active');
    dnCount.textContent = dn + 1;
    if (wasUp) upCount.textContent = Math.max(0, up - 1);
  }

  try {
    const existing = wasUp ? 1 : wasDn ? -1 : null;
    if (existing === null) {
      await fetch(`${SB_URL}/report_votes?on_conflict=voter_id,app_id,report_key`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ voter_id: voterId, app_id: String(appId), report_key: rKey, vote }),
      });
    } else {
      await fetch(`${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${String(appId)}&report_key=eq.${encodeURIComponent(rKey)}`, {
        method: 'PATCH',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ vote }),
      });
    }
  } catch { /* silently fail */ }
}

// -- Helpers ------------------------------------------

function reportKey(r) {
  return `${r.timestamp}:${(r.gpu||'').slice(0,20)}:${(r.protonVersion||'').slice(0,15)}`;
}


function tierFromReports(reports) {
  const order = ['platinum','gold','silver','bronze','borked'];
  const counts = {};
  for (const r of reports) counts[r.rating] = (counts[r.rating] || 0) + 1;
  for (const t of order) if (counts[t]) return t;
  return 'pending';
}

function pulseTierFromReports(nativeReports, protonDbCount = 0) {
  if (!nativeReports.length) {
    return { tier: 'pending', count: 0, confidence: 'none', confidenceNote: protonDbCount > 0 ? 'No Pulse reports yet' : 'No Pulse data yet' };
  }
  const SCORE = { platinum: 1.0, gold: 0.8, silver: 0.6, bronze: 0.4, borked: 0.0 };
  const now = Date.now() / 1000;
  let wSum = 0, wTotal = 0;
  for (const r of nativeReports) {
    const days = (now - (r.timestamp || 0)) / 86400;
    const recency = days < 30 ? 1.0 : days < 90 ? 0.85 : days < 180 ? 0.65 : days < 365 ? 0.40 : 0.15;
    const s = SCORE[r.rating] ?? 0.5;
    wSum += s * recency;
    wTotal += recency;
  }
  const avg = wTotal > 0 ? wSum / wTotal : 0;
  const tier = avg >= 0.85 ? 'platinum' : avg >= 0.65 ? 'gold' : avg >= 0.40 ? 'silver' : avg >= 0.15 ? 'bronze' : 'borked';
  const count = nativeReports.length;
  const weightedEvidence = count + (protonDbCount * 0.2);
  const confidence = weightedEvidence >= 6 ? 'high' : weightedEvidence >= 3 ? 'medium' : 'low';
  const confidenceNote = protonDbCount > 0
    ? `${confidence} confidence (${count} Pulse + ${protonDbCount} ProtonDB reports weighted)`
    : `${confidence} confidence (${count} Pulse report${count !== 1 ? 's' : ''})`;
  return { tier, count, confidence, confidenceNote };
}

function daysAgo(ts) {
  const d = Math.round((Date.now() / 1000 - ts) / 86400);
  return d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}

function utcStamp(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function confColor(s) {
  if (s >= 8) return '#4caf80';
  if (s >= 6) return '#c8a050';
  if (s >= 4) return '#c87840';
  return '#c85050';
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : s; }

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function searchIndexMatches(query, limit) {
  const q = query.trim();
  const ql = q.toLowerCase();
  const isNum = /^\d+$/.test(q);
  return (searchIndex || []).filter(([id, title]) =>
    isNum ? String(id).startsWith(q) : (String(title).toLowerCase().includes(ql) || String(id).startsWith(q))
  ).slice(0, limit);
}

function estimateScore(r) {
  const base = { platinum: 60, gold: 48, silver: 36, bronze: 24, borked: 0 }[r.rating] || 30;
  const days = Math.round((Date.now() / 1000 - r.timestamp) / 86400);
  const recency = days < 90 ? 15 : days < 365 ? 5 : -5;
  return Math.max(0, base + recency);
}

function renderPulseSearchResult(row) {
  const age = daysAgo(Math.floor(new Date(row.updatedAt).getTime() / 1000));
  const isProtonDb = (row.source || '').toLowerCase() === 'protondb';
  const alsoInIndex = !isProtonDb && (searchIndex || []).some(([id]) => String(id) === String(row.appId));
  const sourceBadge = isProtonDb
    ? '<span class="source-badge protondb">ProtonDB</span>'
    : '<span class="source-badge pulse"><img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse</span>'
      + (alsoInIndex ? ' <span class="source-badge protondb">ProtonDB</span>' : '');
  return `
    <a class="search-result-card" href="#/app/${row.appId}">
      <img src="${STEAM_IMG(row.appId)}" onerror="this.style.display='none'" alt="">
      <div class="search-result-main">
        <div class="search-result-main-title">${esc(row.appName)}</div>
        <div class="search-result-main-meta">
          Latest config: ${esc(row.profileName)}${row.protonVersion ? ` · ${esc(row.protonVersion)}` : ''}<br>
          Updated ${age}
        </div>
      </div>
      <div class="search-result-side">
        ${sourceBadge}
      </div>
    </a>`;
}

function renderIndexSearchResult([appId, title]) {
  return `
    <a class="search-result-card" href="${dataFilesHref(appId)}">
      <img src="${STEAM_IMG(appId)}" onerror="this.style.display='none'" alt="">
      <div class="search-result-main">
        <div class="search-result-main-title">${esc(title)}</div>
        <div class="search-result-main-meta">
          Static ProtonDB mirror data indexed for app ${esc(appId)}.
        </div>
      </div>
      <div class="search-result-side">
        <span class="badge badge-reports">Index</span>
      </div>
    </a>`;
}

async function renderSearchPage(query) {
  const el = document.getElementById('content');
  const q = query.trim();
  el.innerHTML = '<div class="state-box">Searching Proton Pulse and index data...</div>';
  await loadSearchIndex();
  const pulseResults = await withTimeout(fetchMatchingPulseConfigs(q), 2500, []);
  const indexResults = searchIndexMatches(q, 24);
  const total = pulseResults.length + indexResults.length;

  el.innerHTML = `
    <div class="search-summary">
      Search results for <strong>${esc(q)}</strong> · ${total} grouped hit${total === 1 ? '' : 's'}${pulseResults.length === 0 && indexResults.length > 0 ? ' · Proton Pulse config search may still be catching up' : ''}
    </div>
    <div class="search-groups">
      <section class="search-group">
        <div class="search-group-head">
          <span class="search-group-title">User Configs</span>
          <span class="search-group-count">${pulseResults.length} app${pulseResults.length === 1 ? '' : 's'}</span>
        </div>
        ${pulseResults.length
          ? `<div class="search-result-list">${pulseResults.map(renderPulseSearchResult).join('')}</div>`
          : '<div class="search-group-empty">No Proton Pulse user configs matched this query.</div>'}
      </section>

      <section class="search-group">
        <div class="search-group-head">
          <span class="search-group-title">Index Data Hits</span>
          <span class="search-group-count">${indexResults.length} app${indexResults.length === 1 ? '' : 's'}</span>
        </div>
        ${indexResults.length
          ? `<div class="search-result-list">${indexResults.map(renderIndexSearchResult).join('')}</div>`
          : '<div class="search-group-empty">No static index entries matched this query.</div>'}
      </section>
    </div>`;
}

// -- Render: Proton Pulse Configs section ------------

const NA_SPAN = '<span style="color:#4a5f70;font-style:italic">Not available</span>';
function cfgNa(s) { return s || NA_SPAN; }

function downloadJson(obj, prefix) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${prefix}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  a.click();
  URL.revokeObjectURL(a.href);
}

function configKey(c) {
  return `cfg:${c.configId != null ? c.configId : (c.clientId || '')}`;
}

const FORM_RESPONSE_LABELS = {
  canInstall:        'Were you able to install the game?',
  canStart:          'Were you able to start the game?',
  canPlay:           'Were you able to begin playing?',
  performanceFaults: 'Unexpected slowdowns or stutters?',
  graphicalFaults:   'Graphical glitches or artifacts?',
  windowingFaults:   'Windowing or display issues?',
  audioFaults:       'Audio issues?',
  inputFaults:       'Input or controller issues?',
  stabilityFaults:   'Crashes or instability?',
  saveGameFaults:    'Save game issues?',
  significantBugs:   'Other significant bugs?',
  onlineMultiplayer: 'Online multiplayer tested?',
  localMultiplayer:  'Local multiplayer tested?',
  verdict:           'Overall: would you recommend this to others?',
  verdictOob:        'Works out of the box without tweaks?',
};

function renderFormResponses(c) {
  const r = c.formResponses;
  if (!r || typeof r !== 'object') return '';
  const rows = Object.entries(FORM_RESPONSE_LABELS)
    .map(([key, label]) => {
      const val = r[key];
      if (val == null || val === '') return '';
      const v = String(val).toLowerCase();
      const badge = v === 'yes'
        ? '<span class="fr-badge fr-yes">Yes</span>'
        : v === 'no'
          ? '<span class="fr-badge fr-no">No</span>'
          : `<span class="fr-badge">${esc(String(val))}</span>`;
      return `<div class="config-row fr-row"><span class="config-lbl fr-lbl">${esc(label)}</span>${badge}</div>`;
    })
    .filter(Boolean);
  if (!rows.length) return '';
  const tinker = Array.isArray(r.tinkeringMethods) && r.tinkeringMethods.length
    ? `<div class="config-row fr-row"><span class="config-lbl fr-lbl">Tinkering methods</span><span>${r.tinkeringMethods.map(m => `<span class="var-tag">${esc(m)}</span>`).join(' ')}</span></div>`
    : '';
  return `
    <div class="fr-section">
      <button class="all-details-btn" onclick="this.nextElementSibling.classList.toggle('open');this.textContent=this.nextElementSibling.classList.contains('open')?'Hide Q&amp;A Responses':'Show Q&amp;A Responses'">Show Q&amp;A Responses</button>
      <div class="all-details-panel">
        ${rows.join('')}
        ${tinker}
      </div>
    </div>`;
}

function renderConfigCard(c, idx, votes = {}, userVotes = {}) {
  const ck = configKey(c);
  const cv = votes[ck] || { up: 0, down: 0 };
  const userVote = userVotes[ck] || 0;
  const vars = Object.entries(c.enabledVars || {}).filter(([, v]) => v);
  const isProtonDb = (c.source || '').toLowerCase() === 'protondb';
  const isPlugin = !isProtonDb && (c.source || '').toLowerCase() !== 'web' && !(c.source || '').startsWith('web-');
  const sourceLabel = isProtonDb
    ? (c.isEdited ? 'ProtonDB (edited)' : 'ProtonDB')
    : isPlugin ? 'Decky Plugin' : 'Web';
  const unnamed = !c.profileName;
  const configId = c.configId != null ? `#${c.configId}` : (c.clientId ? `#${c.clientId.slice(0, 8)}…` : null);
  return `
    <div class="config-card">
      <div class="config-head">
        <div>
          <div class="config-name${unnamed ? ' config-name--unnamed' : ''}">${unnamed ? 'Unnamed Config' : esc(c.profileName)}</div>
          ${configId ? `<div class="config-id-line" title="${esc(c.clientId)}">${esc(configId)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
            <span class="source-badge pulse">
              <img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse
            </span>
            ${(c.isNonSteam || isNonSteamAppId(c.appId))
              ? '<span class="source-badge non-steam-game">Non-Steam</span>'
              : '<span class="source-badge steam-game">Steam</span>'}
          </div>
          <div class="vote-btns">
            <button class="vote-btn vote-up${userVote === 1 ? ' active' : ''}" data-vote="1" data-rkey="${esc(ck)}" data-appid="${c.appId}" title="Helpful"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${cv.up}</span></button>
            <button class="vote-btn vote-dn${userVote === -1 ? ' active' : ''}" data-vote="-1" data-rkey="${esc(ck)}" data-appid="${c.appId}" title="Not helpful"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="transform:scaleY(-1)"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${cv.down}</span></button>
          </div>
        </div>
      </div>
      ${isPlugin && c.pluginVersion ? `<div class="config-row"><span class="config-lbl">Plugin Version</span><span class="config-val">${esc(c.pluginVersion)}</span></div>` : ''}
      <div class="config-row">
        <span class="config-lbl">Proton</span>
        <span class="config-val">${cfgNa(esc(c.protonVersion))}</span>
      </div>
      ${c.launchOptions ? `
      <div class="config-row">
        <span class="config-lbl">Launch Options</span>
        <span class="config-val">${esc(c.launchOptions)}</span>
      </div>` : ''}
      ${vars.length ? `
      <div class="config-row">
        <span class="config-lbl">Env Vars</span>
        <span class="config-vars">${vars.map(([k]) => `<span class="var-tag">${esc(k)}</span>`).join('')}</span>
      </div>` : ''}
      ${renderFormResponses(c)}
      <div class="config-hw">
        <div class="config-hw-label">Hardware</div>
        <div class="config-row"><span class="config-lbl">GPU</span><span>${cfgNa(esc(c.gpu))}</span></div>
        <div class="config-row"><span class="config-lbl">CPU</span><span>${cfgNa(esc(c.cpu))}</span></div>
        <div class="config-row"><span class="config-lbl">RAM</span><span>${cfgNa(esc(c.ram))}</span></div>
        <div class="config-row"><span class="config-lbl">OS</span><span>${cfgNa(esc(c.os))}</span></div>
        <div class="config-row"><span class="config-lbl">Kernel</span><span>${cfgNa(esc(c.kernel))}</span></div>
        <button class="all-details-btn" onclick="this.nextElementSibling.classList.toggle('open');this.textContent=this.nextElementSibling.classList.contains('open')?'Hide Hardware Details':'All Hardware Details'">All Hardware Details</button>
        <div class="all-details-panel">
          <div class="config-row"><span class="config-lbl">GPU Driver</span><span>${cfgNa(esc(c.gpuDriver))}</span></div>
          <div class="config-row"><span class="config-lbl">GPU Vendor</span><span>${cfgNa(esc(c.gpuVendor))}</span></div>
        </div>
      </div>
      <div class="config-meta">
        ${utcStamp(c.timestamp)} | Source: ${sourceLabel}
        <button class="cfg-dl-btn" data-cfg-json='${JSON.stringify(c).replace(/'/g,"&#39;")}' title="Download as JSON">JSON</button>
        ${c.clientId && c.clientId === getWebClientId()
          ? `<button class="cfg-dl-btn delete-cfg-btn" data-voter-id="${esc(c.clientId)}" data-app-id="${c.appId}" style="color:#c85050;border-color:#c85050" title="Delete your config">Delete</button>`
          : ''}
      </div>
    </div>`;
}

function renderConfigsSection(configs) {
  if (!configs.length) return '';
  const gistBar = GhAuth.isLoggedIn()
    ? `<div class="gist-bar" id="configs-gist-bar">
         <span class="gist-bar-label">Gist</span>
         <button class="gist-btn gist-btn-save" id="gist-save-btn" title="Save these configs to your GitHub Gist backup">Save to Gist</button>
         <button class="gist-btn" id="gist-load-btn" title="Load configs from your GitHub Gist backup">Load from Gist</button>
         <span class="gist-status" id="gist-status"></span>
       </div>`
    : '';
  return `
    <div class="configs-section">
      <div class="configs-section-head">
        <span class="configs-section-title">Proton Pulse Configs</span>
        <span class="configs-section-count">${configs.length} saved</span>
      </div>
      ${gistBar}
      <div class="configs-list">
        ${configs.map((c, i) => renderConfigCard(c, i)).join('')}
      </div>
    </div>`;
}

// -- Render: trend summary ----------------------------

function trendSummary(reps) {
  if (reps.length < 2) return '';
  const ratingVal = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };
  const now = Date.now() / 1000;
  const recent = reps.filter(r => now - r.timestamp < 180 * 86400);
  const older  = reps.filter(r => now - r.timestamp >= 180 * 86400);
  if (!recent.length || !older.length) return '';
  const avg = arr => arr.reduce((s, r) => s + (ratingVal[r.rating] || 3), 0) / arr.length;
  const diff = avg(recent) - avg(older);
  if (Math.abs(diff) < 0.3)
    return `<div class="trend">Compatibility is <strong>stable</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
  if (diff > 0)
    return `<div class="trend">Compatibility is <strong style="color:var(--green)">improving</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
  return `<div class="trend">Compatibility is <strong style="color:var(--red)">declining</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
}

// -- Render: report card ------------------------------

function renderCard(r, votes, userVotes = {}) {
  const v     = votes[reportKey(r)] || { up: 0, down: 0 };
  const rKey  = reportKey(r);
  const userVote = userVotes[rKey] || 0;
  const score = Math.min(10, Math.max(0, (r.score || estimateScore(r)) / 10)).toFixed(1);
  const src = (r.source || '').toLowerCase();
  // Pulse-submitted reports land in user_configs with source='user' (plugin) or
  // 'proton-pulse' (legacy). ProtonDB mirror rows are tagged 'protondb'.
  // Anything starting with 'web' is the web submit flow, which is a Pulse path too
  const isProtonDb = src === 'protondb';
  const isWeb = src.startsWith('web');
  const WEB_LABELS = { 'web-steamdeck': 'Steam Deck', 'web-linux': 'Linux', 'web-windows': 'Windows', 'web-macos': 'macOS', 'web': 'Web' };
  const rc    = RATING_COLORS[r.rating] || '#3a4a5a';
  const rt    = RATING_TEXT[r.rating]   || '#c8d4e0';
  const na = s => s || '<span style="color:#4a5f70;font-style:italic">Not available</span>';
  const sourceBadge = isProtonDb
    ? '<span class="source-badge protondb">ProtonDB</span>'
    : isWeb
      ? `<span class="source-badge web">${WEB_LABELS[src] || 'Web'}</span>`
      : '<span class="source-badge pulse"><img src="https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/assets/logo.png" alt="">Pulse</span>';
  return `
    <div class="card">
      <div class="left">
        <div class="proton">${esc(r.protonVersion || 'Unknown')}</div>
        <div class="hw">${esc([r.gpu, r.os].filter(Boolean).join(' / ') || 'Hardware unavailable')}</div>
        <div class="age">${daysAgo(r.timestamp)}</div>
      </div>
      <div class="right">
        ${sourceBadge}
        <div class="card-rating-row">
          <span class="rating" style="background:${rc};color:${rt}">${r.rating || '?'}</span>
          <span class="score" style="color:${confColor(parseFloat(score))}">${score}/10</span>
        </div>
        <div class="vote-btns">
          <button class="vote-btn vote-up${userVote === 1 ? ' active' : ''}" data-vote="1" data-rkey="${esc(rKey)}" data-appid="${r.appId}" title="Helpful"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${v.up}</span></button>
          <button class="vote-btn vote-dn${userVote === -1 ? ' active' : ''}" data-vote="-1" data-rkey="${esc(rKey)}" data-appid="${r.appId}" title="Not helpful"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="transform:scaleY(-1)"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${v.down}</span></button>
        </div>
      </div>
    </div>
    <div class="card-summary">
      <div class="row"><span class="label">GPU</span><span>${na(esc(r.gpu))}</span></div>
      <div class="row"><span class="label">CPU</span><span>${na(esc(r.cpu))}</span></div>
      <div class="row"><span class="label">OS</span><span>${na(esc(r.os))}</span></div>
      <div class="row"><span class="label">Proton</span><span>${na(esc(r.protonVersion))}</span></div>
      ${r.notes ? `<div class="notes-full">${esc(r.notes)}</div>` : ''}
      <button class="all-details-btn" onclick="this.nextElementSibling.classList.toggle('open');this.textContent=this.nextElementSibling.classList.contains('open')?'Hide Hardware Details':'All Hardware Details'">All Hardware Details</button>
      <div class="all-details-panel">
        <div class="row"><span class="label">RAM</span><span>${na(esc(r.ram))}</span></div>
        ${r.vramMb ? `<div class="row"><span class="label">VRAM</span><span>${r.vramMb >= 1024 ? (r.vramMb/1024).toFixed(1)+' GB' : r.vramMb+' MB'}</span></div>` : ''}
        <div class="row"><span class="label">GPU Driver</span><span>${na(esc(r.gpuDriver))}</span></div>
        <div class="row"><span class="label">Kernel</span><span>${na(esc(r.kernel))}</span></div>
        <div class="row"><span class="label">Duration</span><span>${na(esc(r.duration))}</span></div>
        ${r.launchOptions ? `<div class="row"><span class="label">Launch Options</span><span>${esc(r.launchOptions)}</span></div>` : ''}
      </div>
      ${renderFormResponses(r)}
      ${r.reportId != null ? `<div class="row"><span class="label">Report ID</span><span style="font-family:monospace;font-size:0.8em;color:var(--muted)">#${r.reportId}</span></div>` : ''}
      <div class="card-footer">${r.clientId && r.clientId === getWebClientId() ? `<button class="cfg-dl-btn delete-report-btn" data-app-id="${r.appId || ''}" style="color:#c85050;border-color:#c85050" title="Delete your report">Delete</button>` : ''}<button class="cfg-dl-btn" data-report-json='${JSON.stringify(r).replace(/'/g,"&#39;")}' title="Download as JSON">JSON</button></div>
    </div>`;
}

// -- Render: game page --------------------------------

async function renderGamePage(appId) {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading reports...</div>';

  const [cdn, configs, nativeReports, votes, userVotes] = await Promise.all([
    fetchCdn(appId),
    fetchSupabase(appId),
    fetchNativeReports(appId),
    fetchVotes(appId),
    fetchUserVotes(appId),
  ]);

  const reports = [
    ...cdn.map(r => ({ ...r, source: 'protondb' })),
    ...nativeReports,
  ];

  if (!reports.length && !configs.length) {
    el.innerHTML = `<div class="state-box">No reports found for app ${appId}</div>`;
    return;
  }

  const title = reports[0]?.title || configs[0]?.appName || `App ${appId}`;
  const protonDbTier = tierFromReports(cdn);
  const pulseTier = pulseTierFromReports(nativeReports, cdn.length);
  document.title = `${title} - Proton Pulse`;

  let sortMode = 'recent';
  let filterGpu    = '';
  let filterOs     = '';
  let filterRating = '';
  // Unified source filter across configs + reports: 'pulse-config', 'pulse-report',
  // 'protondb', or '' for any
  let filterSource = localStorage.getItem('proton-pulse:config-type') || '';

  const gpuVendor = g => {
    if (!g) return '';
    const l = g.toLowerCase();
    if (/nvidia|geforce|rtx|gtx/.test(l)) return 'nvidia';
    if (/\bamd\b|radeon/.test(l)) return 'amd';
    if (/\bintel\b|iris|arc\b/.test(l)) return 'intel';
    return '';
  };
  const osBase = o => {
    if (!o) return '';
    return o.trim().split(/\s+/)[0];
  };

  // Tag each incoming item with the bucket it belongs to so we can render + filter
  // from one unified list. 'pulse-report' covers both plugin and web submissions,
  // 'protondb' is the upstream mirror, 'pulse-config' is a saved launch profile
  const taggedReports = reports.map((r) => {
    const src = (r.source || '').toLowerCase();
    const bucket = src === 'protondb' ? 'protondb' : 'pulse-report';
    return { ...r, _kind: 'report', _bucket: bucket };
  });
  const taggedConfigs = configs.map((c) => {
    const src = (c.source || '').toLowerCase();
    const bucket = src === 'protondb'
      ? (c.isEdited ? 'protondb-edited' : 'protondb')
      : 'pulse-config';
    return { ...c, _kind: 'config', _bucket: bucket };
  });
  const combined = [...taggedConfigs, ...taggedReports];

  const filtered = () => {
    let arr = [...combined];
    if (filterGpu)    arr = arr.filter(r => gpuVendor(r.gpu) === filterGpu);
    if (filterOs)     arr = arr.filter(r => osBase(r.os) === filterOs);
    // Rating filter only makes sense for reports. Configs don't carry a rating,
    // so drop them when the user explicitly narrows by rating
    if (filterRating) arr = arr.filter(r => r._kind === 'report' && r.rating === filterRating);
    if (filterSource) arr = arr.filter(r => r._bucket === filterSource);
    return arr;
  };

  const sorted = () => {
    const arr = filtered();
    if (sortMode === 'recent') arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    else if (sortMode === 'votes') arr.sort((a, b) => {
      const aKey = a._kind === 'config' ? configKey(a) : reportKey(a);
      const bKey = b._kind === 'config' ? configKey(b) : reportKey(b);
      const va = votes[aKey] || { up:0, down:0 };
      const vb = votes[bKey] || { up:0, down:0 };
      return (vb.up - vb.down) - (va.up - va.down);
    });
    return arr;
  };

  function render() {
    const reps = sorted();
    const protonDbBadgeColor = RATING_COLORS[protonDbTier] || '#3a4a5a';
    const protonDbBadgeText = RATING_TEXT[protonDbTier] || '#c8d4e0';
    const pulseHasReports = nativeReports.length > 0;
    const pulseHasConfigs = configs.length > 0;
    const pulseSummaryBits = [];
    if (pulseHasReports) pulseSummaryBits.push(`${nativeReports.length} report${nativeReports.length !== 1 ? 's' : ''}`);
    if (pulseHasConfigs) pulseSummaryBits.push(`${configs.length} config${configs.length !== 1 ? 's' : ''}`);
    const pulseTileValue = pulseHasReports ? pulseTier.tier : (pulseHasConfigs ? 'config' : 'pending');
    const pulseTileColor = pulseHasReports ? (RATING_COLORS[pulseTier.tier] || '#3a4a5a') : '#2a5a8c';
    const pulseTileText = pulseHasReports ? (RATING_TEXT[pulseTier.tier] || '#c8d4e0') : '#d7e9fb';
    const pulseTileSummary = pulseSummaryBits.length ? pulseSummaryBits.join(' / ') : 'No Pulse data yet';
    const protonDbTileValue = cdn.length > 0 ? protonDbTier : 'pending';
    const protonDbTileSummary = cdn.length > 0
      ? `${cdn.length} report${cdn.length !== 1 ? 's' : ''}`
      : 'No ProtonDB reports';
    const sourceTiles = `
      <div class="source-summary-grid">
        <button class="source-summary-tile source-summary-tile-pulse" type="button" data-target="pulse-summary" title="Jump to Proton Pulse configs and reports">
          <span class="source-summary-kicker">Pulse</span>
          <span class="source-summary-value" style="background:${pulseTileColor};color:${pulseTileText}">${pulseTileValue}</span>
          <span class="source-summary-meta">${pulseTileSummary}</span>
          <span class="source-summary-note">${pulseHasReports ? pulseTier.confidenceNote : (pulseHasConfigs ? 'Community-submitted configs available' : 'Waiting for Pulse reports')}</span>
        </button>
        <button class="source-summary-tile source-summary-tile-protondb" type="button" data-target="reports-summary" title="Jump to ProtonDB community reports">
          <span class="source-summary-kicker">ProtonDB</span>
          <span class="source-summary-value" style="background:${protonDbBadgeColor};color:${protonDbBadgeText}">${protonDbTileValue}</span>
          <span class="source-summary-meta">${protonDbTileSummary}</span>
          <span class="source-summary-note">Community compatibility rating</span>
        </button>
      </div>`;

    // Show a banner if the signed-in client already has a public report on this
    // game (matched via client id on user_configs). No draft concept: upload means publish.
    const myCid = getWebClientId();
    const myPublished = nativeReports.find(r => r.clientId && r.clientId === myCid);
    const myStatusBadge = myPublished ? `
      <div class="my-config-banner my-config-banner--published" title="Your report for this game">
        <span class="my-config-banner-dot"></span>
        <span class="my-config-banner-label">Your report:</span>
        <span class="my-config-banner-status">Published</span>
      </div>` : '';

    el.innerHTML = `
      <div class="game-header">
        <div class="game-header-main">
          <img src="${STEAM_IMG(appId)}" onerror="this.style.display='none'" alt="">
          <div class="game-header-info">
            <div class="game-title">${esc(title)}</div>
            <div class="game-meta">
              App ${appId}
              &nbsp;/&nbsp; <strong>${cdn.length}</strong> ProtonDB report${cdn.length !== 1 ? 's' : ''}
              ${nativeReports.length ? `&nbsp;/&nbsp; <strong>${nativeReports.length}</strong> Pulse report${nativeReports.length !== 1 ? 's' : ''}` : ''}
              &nbsp;/&nbsp; <strong>${configs.length}</strong> Pulse config${configs.length !== 1 ? 's' : ''}
            </div>
            <div class="game-header-summary">
              Browse the combined community view for this game across ProtonDB reports, Pulse compatibility reports, and shared Pulse configs.
            </div>
            ${myStatusBadge}
          </div>
        </div>
        <div class="game-header-side">
          ${sourceTiles}
          <div class="game-header-actions">
            <button class="info-btn" id="rating-info-btn" title="What does this rating mean?"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="11" fill="#3b82f6"/><text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="serif">i</text></svg></button>
            <button class="submit-report-btn" id="submit-report-btn">Submit Report</button>
          </div>
        </div>
        <div class="info-tooltip" id="rating-info-tip">
          <div class="info-tooltip-inner" id="rating-info-content">Loading...</div>
        </div>
        <div class="info-tooltip" id="submit-form-panel">
          <div class="info-tooltip-inner" id="submit-form-content">Loading form...</div>
        </div>
      </div>

      <div class="hub-links">
        <a class="hub-link" href="https://store.steampowered.com/app/${appId}" target="_blank" rel="noopener">Steam ></a>
        <a class="hub-link" href="https://steamdb.info/app/${appId}/" target="_blank" rel="noopener">SteamDB ></a>
        <a class="hub-link" href="https://www.protondb.com/app/${appId}" target="_blank" rel="noopener">ProtonDB ></a>
        <a class="hub-link" href="https://www.pcgamingwiki.com/w/index.php?search=${encodeURIComponent(title)}" target="_blank" rel="noopener">PCGamingWiki ></a>
        <a class="hub-link" href="${dataFilesHref(appId)}">Data Files ></a>
        <button class="hub-link" id="scoring-info-btn">How Scoring Works ></button>
      </div>

      ${trendSummary(reports)}

      <div class="reports-section-head" id="pulse-summary">
        <div class="reports-section-copy">
          <span class="reports-section-title">Community Configs &amp; Reports</span>
          <span class="reports-section-subtitle">Saved Pulse configs and compatibility reports from ProtonDB and Proton Pulse contributors, listed together and labeled by source.</span>
        </div>
        <div class="sort-bar">
          <button class="${sortMode==='recent'?'active':''}" data-sort="recent">Recent</button>
          <button class="${sortMode==='votes'?'active':''}" data-sort="votes">Top Voted</button>
        </div>
      </div>

      <div class="filter-bar">
        ${(() => {
          const GPU_LABEL = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };
          const SRC_LABEL = {
            'pulse-config': 'Pulse',
            'pulse-report': 'Pulse Report',
            'protondb': 'ProtonDB',
            'protondb-edited': 'ProtonDB (edited)',
          };
          const SRC_ORDER = ['pulse-config', 'pulse-report', 'protondb', 'protondb-edited'];
          const RATING_LABEL = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked' };
          const RATING_ORDER = ['platinum','gold','silver','bronze','borked'];

          const availGpus    = [...new Set(combined.map(r => gpuVendor(r.gpu)).filter(Boolean))];
          const availOs      = [...new Set(combined.map(r => osBase(r.os)).filter(Boolean))].sort();
          const availRatings = RATING_ORDER.filter(rt => taggedReports.some(r => r.rating === rt));
          const availSrcs    = SRC_ORDER.filter(b => combined.some(r => r._bucket === b));

          const gpuSel    = availGpus.length > 0 ? `
            <label>GPU</label>
            <select id="fGpu">
              <option value="">Any</option>
              ${availGpus.map(v => `<option value="${v}" ${filterGpu===v?'selected':''}>${GPU_LABEL[v]||v}</option>`).join('')}
            </select>` : '';
          const osSel     = availOs.length > 0 ? `
            <label>OS</label>
            <select id="fOs">
              <option value="">Any</option>
              ${availOs.map(v => `<option value="${esc(v)}" ${filterOs===v?'selected':''}>${esc(v)}</option>`).join('')}
            </select>` : '';
          const ratingSel = availRatings.length > 0 ? `
            <label>Rating</label>
            <select id="fRating">
              <option value="">Any</option>
              ${availRatings.map(v => `<option value="${v}" ${filterRating===v?'selected':''}>${RATING_LABEL[v]||v}</option>`).join('')}
            </select>` : '';
          const srcSel    = availSrcs.length > 1 ? `
            <label>Source</label>
            <select id="fSource">
              <option value="">Any</option>
              ${availSrcs.map(v => `<option value="${v}" ${filterSource===v?'selected':''}>${SRC_LABEL[v]||v}</option>`).join('')}
            </select>` : '';

          const anyActive = filterGpu || filterOs || filterRating || filterSource;
          return gpuSel + osSel + ratingSel + srcSel +
            (anyActive ? `<span class="filter-count">${reps.length} of ${combined.length}</span>` : '');
        })()}
      </div>

      <div class="cards">
        ${reps.length
          ? reps.map((r, i) => r._kind === 'config'
              ? renderConfigCard(r, i, votes, userVotes)
              : renderCard(r, votes, userVotes)
            ).join('')
          : '<div class="state-box" style="border:none">No configs or reports match filters</div>'}
      </div>
    `;

    el.querySelectorAll('.sort-bar button').forEach(b =>
      b.onclick = () => { sortMode = b.dataset.sort; render(); }
    );
    el.querySelector('#rating-info-btn')?.addEventListener('click', async () => {
      const tip = el.querySelector('#rating-info-tip');
      tip?.classList.toggle('open');
      if (tip?.classList.contains('open')) await populateScoringTooltip(el);
    });
    el.querySelectorAll('.source-summary-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        const targetId = tile.getAttribute('data-target');
        const target = targetId ? el.querySelector(`#${targetId}`) : null;
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    el.querySelector('#scoring-info-btn')?.addEventListener('click', async () => {
      const tip = el.querySelector('#rating-info-tip');
      tip?.classList.toggle('open');
      if (tip?.classList.contains('open')) await populateScoringTooltip(el);
    });
    el.querySelector('#submit-report-btn')?.addEventListener('click', async () => {
      const session = await SupaAuth.getSession();
      if (!session) {
        window.location.href = SupaAuth.buildLoginPageUrl(window.location.href);
        return;
      }
      const panel = el.querySelector('#submit-form-panel');
      panel?.classList.toggle('open');
      if (panel?.classList.contains('open')) {
        await populateSubmitForm(el);
        prefillSubmitFormFromMyHardware(el);
        const protonInput = el.querySelector('input[name="protonVersion"]');
        const protonHint = el.querySelector('#proton-hint');
        if (protonInput && protonHint) {
          protonInput.addEventListener('input', () => {
            const v = protonInput.value;
            protonHint.style.display = v && !/^(Proton |GE-Proton|Proton-)\d/.test(v) ? '' : 'none';
          });
        }
        el.querySelector('#submit-report-form')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const status = el.querySelector('#submit-status');
          status.textContent = 'Submitting...';
          const result = await submitReport(appId, title, e.target);
          status.textContent = result.ok ? 'Submitted!' : (result.error || 'Unknown error');
          status.style.color = result.ok ? 'var(--green)' : 'var(--red)';
          if (result.ok) setTimeout(() => { panel.classList.remove('open'); render(); }, 1500);
        });
      }
    });
    el.querySelector('#fGpu')?.addEventListener('change', e => { filterGpu    = e.target.value; render(); });
    el.querySelector('#fOs')?.addEventListener('change',  e => { filterOs     = e.target.value; render(); });
    el.querySelector('#fRating')?.addEventListener('change', e => { filterRating = e.target.value; render(); });
    el.querySelector('#fSource')?.addEventListener('change', e => { filterSource = e.target.value; render(); });
    el.querySelectorAll('.cfg-dl-btn').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        // Cards embed their full payload in data-cfg-json or data-report-json.
        // Falling back to an index lookup broke after configs and reports were
        // merged into one list, so both kinds now carry the JSON inline
        if (b.dataset.cfgJson) downloadJson(JSON.parse(b.dataset.cfgJson), 'pulse-config');
        else if (b.dataset.reportJson) downloadJson(JSON.parse(b.dataset.reportJson), 'report');
      });
    });
    el.querySelectorAll('.vote-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const vote  = parseInt(btn.dataset.vote);
        const rKey  = btn.dataset.rkey;
        const aId   = btn.dataset.appid;
        const btns  = btn.closest('.vote-btns');
        castVote(aId, rKey, vote, btns.querySelector('.vote-up'), btns.querySelector('.vote-dn'));
      });
    });

    el.querySelectorAll('.delete-report-btn').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete your report for this game?')) return;
        const clientId = getWebClientId();
        const r = await fetch(`${SB_URL}/user_configs?client_id=eq.${clientId}&app_id=eq.${appId}`, {
          method: 'DELETE',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'x-client-id': clientId },
        });
        if (r.ok) { b.textContent = 'Deleted'; setTimeout(render, 1000); }
        else { b.textContent = 'Failed'; }
      });
    });

    // Delete plugin config (user_proton_configs) — shown when voter_id matches this device's client ID
    el.querySelectorAll('.delete-cfg-btn').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete your Proton config for this game?')) return;
        const voterId  = b.dataset.voterId;
        const cfgAppId = b.dataset.appId;
        const r = await fetch(
          `${SB_URL}/user_proton_configs?voter_id=eq.${voterId}&app_id=eq.${cfgAppId}`,
          { method: 'DELETE', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'x-client-id': voterId } }
        );
        console.log('[delete-cfg]', r.status, voterId, cfgAppId);
        if (r.ok) { b.textContent = 'Deleted'; setTimeout(render, 1000); }
        else { b.textContent = 'Failed'; }
      });
    });
  }

  render();
}

// -- Search --------------------------------------------

const searchInput   = document.getElementById('search');
const searchResults = document.getElementById('search-results');

async function loadSearchIndex() {
  if (searchIndex !== null) return;
  try {
    const r = await fetch('search-index.json');
    searchIndex = r.ok ? await r.json() : [];
  } catch { searchIndex = []; }
}

function closeSearch() {
  searchResults.classList.remove('open');
  searchResults.innerHTML = '';
  searchFocusIdx = -1;
}

function positionSearchResults() {
  const rect = searchInput.getBoundingClientRect();
  const desiredWidth = Math.max(rect.width, 620);
  const maxWidth = Math.min(desiredWidth, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - maxWidth - 12));
  searchResults.style.top = `${Math.round(rect.bottom + 4)}px`;
  searchResults.style.left = `${Math.round(left)}px`;
  searchResults.style.width = `${Math.round(maxWidth)}px`;
}

function renderSearchResults(q) {
  const items = searchResults.querySelectorAll('a.search-item');
  searchFocusIdx = Math.max(-1, Math.min(searchFocusIdx, items.length - 1));
  items.forEach((a, i) => a.classList.toggle('focused', i === searchFocusIdx));
}

async function onSearchInput() {
  const q = searchInput.value.trim();
  if (!q) { closeSearch(); return; }
  await loadSearchIndex();
  positionSearchResults();
  const MAX = 8;

  // Filter: numeric queries match only on app ID prefix; text matches title or ID
  const matches = searchIndexMatches(q, MAX);
  // Check which matched apps have Pulse configs AND/OR Pulse reports. Either
  // one is enough to earn the Pulse badge in the dropdown
  const [pulseResults, pulseReportAppIds] = await Promise.all([
    withTimeout(fetchMatchingPulseConfigs(q), 1500, []),
    withTimeout(fetchMatchingPulseReportAppIds(q), 1500, new Set()),
  ]);
  const pulseAppIds = new Set([
    ...pulseResults.map(r => String(r.appId)),
    ...pulseReportAppIds,
  ]);

  if (!matches.length && !pulseAppIds.size) {
    searchResults.innerHTML = `<div class="search-no-results">No quick matches — press Enter to open grouped search results.</div>`;
    searchResults.classList.add('open');
    searchFocusIdx = -1;
    return;
  }

  // Merge: index matches + pulse-only apps not in index
  const seenIds = new Set(matches.map(([id]) => String(id)));
  const pulseOnly = pulseResults.filter(r => !seenIds.has(String(r.appId))).slice(0, MAX - matches.length);
  const allItems = [
    ...matches.map(([id, title]) => ({ id, title, hasIndex: true, hasPulse: pulseAppIds.has(String(id)) })),
    ...pulseOnly.map(r => ({ id: r.appId, title: r.appName, hasIndex: false, hasPulse: true })),
  ];

  const rows = allItems.map(({ id, title, hasIndex, hasPulse }) => {
    const img = STEAM_IMG(id);
    return `<a class="search-item" href="#/app/${id}" data-id="${id}">
      <img src="${img}" onerror="this.style.display='none'" alt="" loading="lazy">
      <div class="search-result-info">
        <div class="search-result-title">${esc(title)}</div>
        <div class="search-result-badges">
          ${hasIndex ? '<span class="badge badge-reports">ProtonDB</span>' : ''}
          ${hasPulse ? '<span class="badge badge-pulse">Pulse</span>' : ''}
        </div>
      </div>
    </a>`;
  }).join('');

  const footer = `<a class="search-footer" href="app.html?q=${encodeURIComponent(q)}">Open grouped search results →</a>`;
  searchResults.innerHTML = rows + footer;
  searchResults.classList.add('open');
  searchFocusIdx = -1;

  // Close when a result is clicked
  searchResults.querySelectorAll('a.search-item').forEach(a => {
    a.addEventListener('click', () => { closeSearch(); searchInput.value = ''; });
  });
}

searchInput.addEventListener('input', onSearchInput);

searchInput.addEventListener('keydown', e => {
  const items = [...searchResults.querySelectorAll('a.search-item')];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchFocusIdx = Math.min(searchFocusIdx + 1, items.length - 1);
    renderSearchResults(searchInput.value.trim());
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchFocusIdx = Math.max(searchFocusIdx - 1, -1);
    renderSearchResults(searchInput.value.trim());
    return;
  }
  if (e.key === 'Escape') { closeSearch(); return; }
  if (e.key === 'Enter') {
    const focused = items[searchFocusIdx];
    if (focused) { focused.click(); return; }
    const q = searchInput.value.trim();
    if (!q) return;
    closeSearch();
    searchInput.value = '';
    if (/^\d+$/.test(q)) {
      location.hash = '#/app/' + q;
    } else {
      window.location.href = 'app.html?q=' + encodeURIComponent(q);
    }
  }
});

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) closeSearch();
});

window.addEventListener('resize', () => {
  if (searchResults.classList.contains('open')) positionSearchResults();
});

(function(){
  var toggle  = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }

  toggle.addEventListener('click', function() {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });

  overlay.addEventListener('click', closeSidebar);
  sidebar.querySelectorAll('a').forEach(function(a) {
    a.addEventListener('click', closeSidebar);
  });
})();

// ── Steam Auth (Supabase) ─────────────────────────────────────────────────

(function initGoogleAuth() {
  const loginBtn  = document.getElementById('google-login-btn');
  const userMenu  = document.getElementById('google-user-menu');
  const avatarEl  = document.getElementById('google-avatar');
  const nameEl    = document.getElementById('google-username');
  const menuBtn   = document.getElementById('google-menu-btn');
  const dropdown  = document.getElementById('google-dropdown');
  const logoutBtn = document.getElementById('google-logout-btn');

  SupaAuth.onStateChange(({ user }) => {
    if (user) {
      loginBtn.hidden    = true;
      userMenu.hidden    = false;
      avatarEl.src       = user.user_metadata?.avatar_url || '';
      avatarEl.alt       = user.user_metadata?.name || user.email || '';
      nameEl.textContent = user.user_metadata?.name || user.email || '';
    } else {
      loginBtn.hidden = false;
      userMenu.hidden = true;
      dropdown.classList.remove('open');
    }
  });

  loginBtn.addEventListener('click', () => {
    window.location.href = SupaAuth.buildLoginPageUrl(window.location.href);
  });

  logoutBtn?.addEventListener('click', () => {
    dropdown.classList.remove('open');
    SupaAuth.logout();
  });

  userMenu?.addEventListener('click', e => {
    if (dropdown.contains(e.target)) return;
    dropdown.classList.toggle('open');
  });

  const chip = document.getElementById('gh-auth-chip');
  document.addEventListener('click', e => {
    if (chip && chip.contains(e.target)) return;
    if (dropdown) dropdown.classList.remove('open');
  });
})();
