// hardware (shared) module. Used across multiple pages. Relocated from app-hardware.js.

// Hardware preview helper -- if the user hasn't saved their own hardware on
// the Profile page, fall back to Steam Deck specs so the personalised
// confidence + stats views still show real hardware-match data instead of
// the gated "save hardware to see..." placeholder.
//
// The pages that consume this (confidence.html, game-stats.html, etc) get
// a banner explaining the fallback is active and a link to the profile page
// so the visitor can swap in their own specs.
//
// Loaded as a classic script BEFORE the page's main script so the globals
// (loadMyHardware, isPreviewHardware, STEAM_DECK_HW) are ready at init.

// Steam Deck OLED specs (current model). The original LCD was Zen 2 4c/8t
// w/ 8 RDNA2 CUs - same arch so vendor/family match still resolves the same
// way for scoring. Kernel here is the SteamOS 3.6 default at time of writing
export const STEAM_DECK_HW = {
  cpu:       'AMD Custom APU 0405 (Zen 2)',
  gpu:       'AMD Custom GPU 0405 (RDNA 2)',
  gpuVendor: 'AMD',
  os:        'SteamOS Holo',
  kernel:    '6.5.0-valve',
  _isPreview: true,  // marker so the UI can show the "swap on Profile" hint
};

// Real localStorage keys written by profile.js. Read these before falling
// back to the Steam Deck preview hw above.
export const HW_STORAGE_KEYS = {
  cpu:       'proton-pulse:myhw:cpu',
  gpu:       'proton-pulse:myhw:gpu',
  gpuVendor: 'proton-pulse:myhw:gpu-vendor',
  os:        'proton-pulse:myhw:os',
  kernel:    'proton-pulse:myhw:kernel',
};

// Read the viewer's saved hardware; if none, return the Steam Deck preview
// with _isPreview: true so callers can render the banner. Returns null only
// if localStorage itself is unavailable (eg. private browsing edge case).
/**
 * Read the viewer's saved hardware specs from localStorage.
 * Falls back to `STEAM_DECK_HW` (with `_isPreview: true`) if no specs are saved
 * or if `localStorage` is unavailable (e.g. private browsing).
 * Requires at least `gpu` or `os` to be present to consider the profile saved.
 * @returns {{cpu: string, gpu: string, gpuVendor: string, os: string, kernel: string, _isPreview: boolean}}
 */
export function loadMyHardware() {
  try {
    const saved = {
      cpu:       localStorage.getItem(HW_STORAGE_KEYS.cpu)       || '',
      gpu:       localStorage.getItem(HW_STORAGE_KEYS.gpu)       || '',
      gpuVendor: localStorage.getItem(HW_STORAGE_KEYS.gpuVendor) || '',
      os:        localStorage.getItem(HW_STORAGE_KEYS.os)        || '',
      kernel:    localStorage.getItem(HW_STORAGE_KEYS.kernel)    || '',
    };
    // We need at least gpu or os to consider it "saved". If neither is
    // present, fall back to the Steam Deck preview profile.
    if (saved.gpu || saved.os) {
      return { ...saved, _isPreview: false };
    }
    return { ...STEAM_DECK_HW };
  } catch {
    // localStorage blew up. Still hand back the preview so the page renders
    return { ...STEAM_DECK_HW };
  }
}

/**
 * Check whether a hardware object is the Steam Deck preview fallback rather than the user's own saved specs.
 * @param {{_isPreview?: boolean}} hw - Hardware object returned by `loadMyHardware`.
 * @returns {boolean} True if `hw._isPreview` is set.
 */
export function isPreviewHardware(hw) {
  return !!(hw && hw._isPreview);
}

// Small inline banner shown when the page is rendering with the Steam Deck
// preview hardware fallback. Keeps the user informed without bothering
// people who already saved their own specs.
/**
 * Render an inline info banner shown when the page is using the Steam Deck preview hardware fallback.
 * If the user is signed in and has uploaded systems, shows a dropdown to switch between them.
 * Otherwise shows a static message linking to the profile page.
 * @returns {string} HTML string for the banner element.
 */
export function renderPreviewHardwareBanner() {
  return `
    <div class="hw-preview-banner" id="hw-banner" style="
      display:flex;align-items:center;gap:10px;
      padding:8px 12px;margin:0 0 14px;
      background:linear-gradient(180deg,rgba(40,80,120,0.32),rgba(20,40,60,0.22));
      border:1px solid rgba(110,180,240,0.22);
      border-left:3px solid var(--accent);
      border-radius:3px;
      font-size:0.82rem;color:var(--text);
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:0.7">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 16v-4M12 8h.01"/>
      </svg>
      <span style="flex:1" id="hw-banner-content">
        Showing <strong>Steam Deck</strong> hardware for preview.
        <a href="profile.html" style="color:var(--accent);text-decoration:underline">Save your own specs</a>
        to see hardware-match scores personalised to your system.
      </span>
    </div>
  `;
}

/**
 * Enhance the hardware banner with a system selector dropdown when the user
 * is signed in and has uploaded systems. Call after the banner HTML is in the DOM.
 * The dropdown defaults to the user's `is_default` system. Selecting a system
 * writes its specs to localStorage (same keys as the profile page) and reloads
 * the page so scoring recalculates.
 */
export async function enhanceHardwareBanner() {
  const banner = document.getElementById('hw-banner-content');
  if (!banner) return;
  let session = null;
  try {
    if (!window.SupaAuth) return;
    session = await window.SupaAuth.getSession();
    if (!session?.user) return;
  } catch { return; }

  const userId = session.user.id;
  const SB_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
  const SB_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
  try {
    const url = `${SB_URL}/user_systems?proton_pulse_user_id=eq.${encodeURIComponent(userId)}&order=is_default.desc,updated_at.desc`;
    const r = await fetch(url, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${session.access_token}` },
    });
    if (!r.ok) return;
    const systems = await r.json();
    if (!systems.length) return;

    const defaultSys = systems.find(s => s.is_default) || systems[0];
    const esc = s => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const options = systems.map(s => {
      const label = s.label || `${s.gpu || 'Unknown GPU'} / ${s.os || 'Unknown OS'}`;
      const selected = s.device_id === defaultSys.device_id ? ' selected' : '';
      return `<option value="${esc(s.device_id)}"${selected}>${esc(label)}</option>`;
    }).join('');

    banner.innerHTML = `
      <span>Scoring against:</span>
      <select id="hw-system-select" style="
        background:rgba(20,32,44,0.8);color:var(--text);border:1px solid var(--border);
        border-radius:3px;padding:3px 8px;font-family:var(--mono);font-size:0.78rem;
        max-width:280px;
      ">${options}</select>
      <a href="profile.html" style="color:var(--accent);font-size:0.75rem;margin-left:auto">manage &rarr;</a>
    `;

    const applySystem = (sys) => {
      try {
        localStorage.setItem(HW_STORAGE_KEYS.cpu, sys.cpu || '');
        localStorage.setItem(HW_STORAGE_KEYS.gpu, sys.gpu || '');
        localStorage.setItem(HW_STORAGE_KEYS.gpuVendor, sys.gpu_vendor || '');
        localStorage.setItem(HW_STORAGE_KEYS.os, sys.os || '');
        localStorage.setItem(HW_STORAGE_KEYS.kernel, sys.kernel || '');
      } catch { /* quota */ }
    };

    // Apply default on first load if user hasn't manually set local hw
    const currentHw = loadMyHardware();
    if (currentHw._isPreview) applySystem(defaultSys);

    document.getElementById('hw-system-select')?.addEventListener('change', (e) => {
      const chosen = systems.find(s => s.device_id === e.target.value);
      if (chosen) {
        applySystem(chosen);
        location.reload();
      }
    });
  } catch { /* network / parse fail — keep the static banner */ }
}

// CommonJS export so tests can require() this directly. In the browser the
// classic script tag just leaks the globals defined above.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STEAM_DECK_HW,
    HW_STORAGE_KEYS,
    loadMyHardware,
    isPreviewHardware,
    renderPreviewHardwareBanner,
    enhanceHardwareBanner,
  };
}
