// Shared "All + specific values" pill-group helper (#96).
//
// The same toggle pattern was inline in js/app/components/home.js and
// (nearly) in js/index/main.js: click All to clear specifics; click a
// specific to toggle it; when the last specific is deselected, re-activate
// All. Extracted here so a bug fix only lives in one place and future
// pill-group filters can drop it in.
//
// Buttons need:
//   - shared class (default '.pg-filter'), one per option
//   - data-value attribute; the "clear all" button uses data-value="all"
//   - active state applied via classList ('.pg-filter--active' by default)
//   - aria-pressed kept in sync for a11y
//
// The API is intentionally tiny:
//   readActive(groupEl)                       -> Set<string> of active non-'all' values
//   wireGroup(groupEl, { onChange, ...opts }) -> attaches click handlers

const DEFAULT_SELECTOR = '.pg-filter';
const DEFAULT_ACTIVE_CLASS = 'pg-filter--active';

export function readActive(groupEl, { selector = DEFAULT_SELECTOR, activeClass = DEFAULT_ACTIVE_CLASS } = {}) {
  const active = new Set();
  if (!groupEl) return active;
  groupEl.querySelectorAll(selector).forEach(btn => {
    if (btn.dataset.value !== 'all' && btn.classList.contains(activeClass)) {
      active.add(btn.dataset.value);
    }
  });
  return active;
}

// Applies the toggle mutual-exclusion rules and calls onChange(Set) after
// each click. Keeps aria-pressed in sync with the active class so screen
// readers reflect the pressed state without every caller remembering to.
export function wireGroup(groupEl, {
  onChange = () => {},
  selector = DEFAULT_SELECTOR,
  activeClass = DEFAULT_ACTIVE_CLASS,
} = {}) {
  if (!groupEl) return;
  const allBtn = groupEl.querySelector(`${selector}[data-value="all"]`);
  const buttons = Array.from(groupEl.querySelectorAll(selector));

  const syncAria = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.classList.contains(activeClass)));
  };

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      if (btn.dataset.value === 'all') {
        for (const b of buttons) b.classList.remove(activeClass);
        btn.classList.add(activeClass);
      } else {
        btn.classList.toggle(activeClass);
        if (allBtn) allBtn.classList.remove(activeClass);
        // Re-arm the "all" button when no specifics remain, so the group
        // always has SOME active state to reflect "unfiltered".
        if (readActive(groupEl, { selector, activeClass }).size === 0 && allBtn) {
          allBtn.classList.add(activeClass);
        }
      }
      syncAria();
      onChange(readActive(groupEl, { selector, activeClass }));
    });
  }
  // Initial a11y sync so pre-marked-active buttons announce correctly.
  syncAria();
}
