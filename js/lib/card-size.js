// Shared S/M/L/XL card-size toggle used by the home landing (js/index/main.js)
// and the app browse page (js/app/components/home.js). Both pages previously
// carried near-identical duplicate implementations -- one XL parity fix had
// to be applied twice. #459 folds the shared bits here so the two pages
// consume the same constants + apply pipeline, and only the button selector
// / container elements differ per page.

export const CARD_SIZES = ['sm', 'md', 'lg', 'xl'];
export const CARD_SIZE_KEY = 'pp:grid-size';

// Desktop has the room for larger cards, so the default steps up to 'lg'
// there; mobile stays on 'md' to keep more rows on screen. matchMedia is
// guarded so this module is safe to import in a jsdom test environment.
export function defaultCardSize() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(min-width: 760px)').matches ? 'lg' : 'md';
    }
  } catch { /* no-op */ }
  return 'md';
}

export function savedCardSize() {
  try {
    const s = localStorage.getItem(CARD_SIZE_KEY);
    return CARD_SIZES.includes(s) ? s : defaultCardSize();
  } catch {
    return defaultCardSize();
  }
}

export function saveCardSize(size) {
  try { localStorage.setItem(CARD_SIZE_KEY, size); } catch { /* ignore */ }
}

// Swap the cards--<size> class on every provided container. Null entries in
// the list are skipped so callers can pass getElementById results directly
// without null-checking each one.
export function applyCardSize(size, containers) {
  for (const el of containers) {
    if (!el) continue;
    for (const s of CARD_SIZES) el.classList.remove(`cards--${s}`);
    el.classList.add(`cards--${size}`);
  }
}

// Reflect the current size on the button row (adds `active` to the matching
// data-size button, removes from the others). Caller supplies the selector
// so home (.home-size-btn) and index (.pg-size-btn) stay independent.
export function syncCardSizeButtons(size, buttonSelector) {
  document.querySelectorAll(buttonSelector).forEach(b =>
    b.classList.toggle('active', b.dataset.size === size));
}

// Enable / disable the button row. `toggleId` is the id of the wrapping
// container; the corresponding `${toggleId}--disabled` modifier is toggled
// so page CSS can style the disabled state (dim, un-hover, etc.).
export function setCardSizeButtonsEnabled(enabled, buttonSelector, toggleId) {
  document.querySelectorAll(buttonSelector).forEach(b => { b.disabled = !enabled; });
  if (toggleId) {
    document.getElementById(toggleId)?.classList.toggle(`${toggleId}--disabled`, !enabled);
  }
}

// One-liner init: wires click handlers, applies the saved size on mount,
// returns the apply function so the caller can trigger it after a layout
// change. onApply fires after the class + button sync so callers can
// re-render their grids to refill rows for the new column width.
export function initCardSizeToggle({ containers, buttonSelector, onApply }) {
  const apply = (size) => {
    applyCardSize(size, containers);
    syncCardSizeButtons(size, buttonSelector);
    if (typeof onApply === 'function') onApply(size);
  };
  document.querySelectorAll(buttonSelector).forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.dataset.size;
      if (!CARD_SIZES.includes(size)) return;
      saveCardSize(size);
      apply(size);
    });
  });
  apply(savedCardSize());
  return apply;
}
