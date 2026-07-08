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
 */
export function pageNavHtml(current, total, { maxSlots = 10 } = {}) {
  const t = Math.max(1, Math.floor(total));
  if (t <= 1) return '';
  const slots = pageSlots(current, t, maxSlots);
  const parts = slots.map((slot) => {
    if (slot === '...') return `<span class="page-nav-ellipsis" aria-hidden="true">...</span>`;
    const isActive = slot === current;
    return `<button class="page-nav-btn${isActive ? ' page-nav-btn--active' : ''}" data-page="${slot}" type="button" ${isActive ? 'aria-current="page"' : ''}>${slot}</button>`;
  });
  return `<nav class="page-nav-inner" aria-label="Page navigation">${parts.join('')}</nav>`;
}

/** Wire click handlers on all `[data-page]` buttons in the container. */
export function wirePageNav(container, onSelect) {
  if (!container) return;
  container.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-page]');
    if (!btn) return;
    const page = Number(btn.dataset.page);
    if (Number.isFinite(page)) onSelect(page);
  });
}
