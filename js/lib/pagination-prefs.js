// Site preference for how the home library paginates:
//   - tiles per page (separate mobile + desktop values)
//   - auto-load mode (append the next page automatically as the user
//     scrolls near the bottom of the list, #253)
//
// The three values are stored under a single localStorage key so they
// survive site sessions and can be edited from the Site Options page.
// If nothing is stored the module falls back to sensible defaults tuned
// for each viewport class.

export const PAGE_SIZE_KEY = 'pp-page-size';

export const DEFAULT_MOBILE_TILES_PER_PAGE = 20;
export const DEFAULT_DESKTOP_TILES_PER_PAGE = 50;
export const DEFAULT_AUTO_LOAD = false;

const MOBILE_BREAKPOINT = 1024;

function _isMobile() {
  return typeof window !== 'undefined'
    && typeof window.innerWidth === 'number'
    && window.innerWidth < MOBILE_BREAKPOINT;
}

// Returns { mobile, desktop, autoLoad } with defaults when nothing is
// stored or the stored blob is malformed. Never throws.
export function getPageSizePref() {
  try {
    if (typeof localStorage === 'undefined') throw new Error('no localStorage');
    const raw = localStorage.getItem(PAGE_SIZE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      mobile: Number.isFinite(parsed.mobile) && parsed.mobile > 0
        ? Math.floor(parsed.mobile) : DEFAULT_MOBILE_TILES_PER_PAGE,
      desktop: Number.isFinite(parsed.desktop) && parsed.desktop > 0
        ? Math.floor(parsed.desktop) : DEFAULT_DESKTOP_TILES_PER_PAGE,
      autoLoad: typeof parsed.autoLoad === 'boolean'
        ? parsed.autoLoad : DEFAULT_AUTO_LOAD,
    };
  } catch (e) {
    return {
      mobile: DEFAULT_MOBILE_TILES_PER_PAGE,
      desktop: DEFAULT_DESKTOP_TILES_PER_PAGE,
      autoLoad: DEFAULT_AUTO_LOAD,
    };
  }
}

// Merge and persist. Missing fields keep their current value.
export function setPageSizePref(patch) {
  try {
    if (typeof localStorage === 'undefined') return;
    const current = getPageSizePref();
    const next = {
      mobile: Number.isFinite(patch?.mobile) && patch.mobile > 0
        ? Math.floor(patch.mobile) : current.mobile,
      desktop: Number.isFinite(patch?.desktop) && patch.desktop > 0
        ? Math.floor(patch.desktop) : current.desktop,
      autoLoad: typeof patch?.autoLoad === 'boolean' ? patch.autoLoad : current.autoLoad,
    };
    localStorage.setItem(PAGE_SIZE_KEY, JSON.stringify(next));
  } catch (e) {
    // Silently ignore -- storage may be full or blocked.
  }
}

// Returns the effective tiles-per-page for the current viewport class.
export function getEffectivePageSize() {
  const p = getPageSizePref();
  return _isMobile() ? p.mobile : p.desktop;
}

export function isAutoLoadEnabled() {
  return getPageSizePref().autoLoad;
}
