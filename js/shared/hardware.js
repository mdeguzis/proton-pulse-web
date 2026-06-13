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

export function isPreviewHardware(hw) {
  return !!(hw && hw._isPreview);
}

// Small inline banner shown when the page is rendering with the Steam Deck
// preview hardware fallback. Keeps the user informed without bothering
// people who already saved their own specs.
export function renderPreviewHardwareBanner() {
  return `
    <div class="hw-preview-banner" style="
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
      <span style="flex:1">
        Showing <strong>Steam Deck</strong> hardware for preview.
        <a href="profile.html" style="color:var(--accent);text-decoration:underline">Save your own specs</a>
        to see hardware-match scores personalised to your system.
      </span>
    </div>
  `;
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
  };
}
