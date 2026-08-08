// Numbered page nav for the home browse sections. Cumulative model: page
// N shows the first N pages of content (matches Load More at the bottom).
// Renders up to 10 button slots -- first 1-2 pages, an ellipsis, then the
// current page + its neighbours, then the last 1-2 pages. Zero side
// effects; caller supplies the click handler.

/**
 * Compute the list of page slots to render.
 * Returns an array of numbers or the literal '...' for gaps.
 * @param {number} current  1-indexed
 * @param {number} total    1-indexed max
 * @param {number} maxSlots visual budget; safe values 7-11
 */
export function pageSlots(current, total, maxSlots = 10) {
  const t = Math.max(1, Math.floor(total));
  if (t <= maxSlots) return Array.from({ length: t }, (_, i) => i + 1);
  const c = Math.min(Math.max(1, Math.floor(current)), t);
  // Reserve slots for: 1, current-1, current, current+1, t. Ellipses go
  // in between. If the neighbourhood already touches the edges skip the
  // extra ellipsis so we never emit '1, ..., 2'.
  const set = new Set([1, t, c - 1, c, c + 1]);
  // Widen by one when we still have budget.
  if (set.size + 2 < maxSlots) { set.add(c - 2); set.add(c + 2); }
  const sorted = [...set].filter((n) => n >= 1 && n <= t).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    if (i > 0 && n - sorted[i - 1] > 1) out.push('...');
    out.push(n);
  }
  return out;
}

/**
 * Render the nav HTML. Caller stores the returned innerHTML and wires
 * clicks via `wirePageNav`. Splitting render + wire lets the caller
 * substitute in a document fragment or a virtualized shadow root.
 *
 * Layout: "Page X of Y" label + Prev arrow + [numbered slots] + Next arrow.
 * The label anchors the reader when the middle slots rearrange as the
 * current page moves (standard for compact pagination). Arrows give an
 * always-visible +/-1 fallback so a click doesn't require aiming for a
 * tiny number.
 */
export function pageNavHtml(current, total, { maxSlots = 10 } = {}) {
  const t = Math.max(1, Math.floor(total));
  if (t <= 1) return '';
  const c = Math.min(Math.max(1, Math.floor(current)), t);
  const slots = pageSlots(c, t, maxSlots);
  const slotParts = slots.map((slot) => {
    if (slot === '...') return `<span class="page-nav-ellipsis" aria-hidden="true">...</span>`;
    const isActive = slot === c;
    return `<button class="page-nav-btn${isActive ? ' page-nav-btn--active' : ''}" data-page="${slot}" type="button" ${isActive ? 'aria-current="page"' : ''}>${slot}</button>`;
  });
  const prevDisabled = c <= 1;
  const nextDisabled = c >= t;
  const prev = `<button class="page-nav-btn page-nav-btn--arrow" data-page="${c - 1}" type="button" aria-label="Previous page" ${prevDisabled ? 'disabled' : ''}>&larr;</button>`;
  const next = `<button class="page-nav-btn page-nav-btn--arrow" data-page="${c + 1}" type="button" aria-label="Next page" ${nextDisabled ? 'disabled' : ''}>&rarr;</button>`;
  const label = `<span class="page-nav-label">Page ${c} of ${t}</span>`;
  return `<nav class="page-nav-inner" aria-label="Page navigation">${label}${prev}${slotParts.join('')}${next}</nav>`;
}

const _HANDLER_KEY = '__pageNavHandler';

/**
 * Wire click handlers on all `[data-page]` buttons in the container.
 * Idempotent -- a second call REPLACES the previous handler so callers
 * can wire on every re-render without stacking listeners. Disabled
 * buttons (prev on page 1, next on last page) are ignored.
 */
export function wirePageNav(container, onSelect) {
  if (!container) return;
  if (container[_HANDLER_KEY]) {
    container.removeEventListener('click', container[_HANDLER_KEY]);
  }
  const handler = (ev) => {
    const btn = ev.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    const page = Number(btn.dataset.page);
    if (Number.isFinite(page)) onSelect(page);
  };
  container[_HANDLER_KEY] = handler;
  container.addEventListener('click', handler);
}
