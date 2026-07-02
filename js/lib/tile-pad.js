// Pad a tile-mode grid container so the last row is never ragged.
//
// Two modes depending on whether more items are queued behind the "Load
// more" button:
//
// - hasMore=true: the last row is likely incomplete because the fixed
//   page size doesn't divide evenly by the current column count. In that
//   case we REMOVE the trailing orphan tiles so the grid ends on a full
//   row and the Load more button visually takes the place of the missing
//   tiles. The removed items come back on the next Load more click via
//   a normal re-render.
// - hasMore=false: everything the source has is already on screen, so
//   the incomplete last row is real. We PAD it with invisible filler
//   divs (`.tile-filler`) that occupy the trailing grid cells so the
//   real tiles stay aligned with the columns above.
//
// Call padTileRows(containerEl, { tileSelector, fillerClass, hasMore })
// after every render, and re-render on window resize (the column count
// changes with viewport width, so a stale clamp needs recomputing).

const _RESIZE_KEY = '__tilePadHandlers';

// Returns the number of grid columns the container is currently showing,
// or 1 if it isn't in grid mode (list layout / probe hasn't laid out yet).
// Column count is derived from the resolved gridTemplateColumns tracks,
// which reflect the auto-fill count for the container's actual width.
export function currentColCount(container) {
  if (!container) return 1;
  const cs = getComputedStyle(container);
  if (cs.display !== 'grid') return 1;
  const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, cols);
}

// How many tiles the caller should render per "page" (initial + each Load
// more click) so the visible grid always fills roughly N complete rows.
// Enforces a floor so a viewport that only fits 1 column doesn't ship a
// 4-item first page (too little content to be useful).
export function pageSizeForFullRows(container, rows = 4, minItems = 8) {
  return Math.max(minItems, currentColCount(container) * rows);
}

// Viewport-aware row target: mobile shows 5 rows (more room to scan the
// tighter grid), desktop shows 4 (larger tiles + Load more feels fast).
// Callers pass `pageSizeForFullRows(el, targetRowsForViewport())` so the
// initial page size and each Load more click land the same target.
export function targetRowsForViewport() {
  return window.matchMedia('(max-width: 560px)').matches ? 5 : 4;
}

export function padTileRows(container, { tileSelector = '> *', fillerClass = 'tile-filler', hasMore = false } = {}) {
  if (!container) return;
  // Wipe stale fillers from the previous pad pass before counting.
  container.querySelectorAll('.' + fillerClass).forEach(f => f.remove());

  // Only pad when the container is laid out as a grid (tile mode is on).
  // List mode is still a flex column so grid-template-columns will be
  // 'none' and we should bail.
  const cs = getComputedStyle(container);
  if (cs.display !== 'grid') return;
  const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
  if (!cols || cols < 2) return;

  const items = container.querySelectorAll(':scope ' + tileSelector + ':not(.' + fillerClass + ')');
  const remainder = items.length % cols;
  if (remainder === 0) return;

  if (hasMore) {
    // Trim the incomplete last row -- the user can pull the missing tiles
    // into view by clicking Load more, which re-renders with more items.
    for (let i = 0; i < remainder; i++) {
      const orphan = items[items.length - 1 - i];
      if (orphan && orphan.parentNode === container) orphan.remove();
    }
    return;
  }

  const need = cols - remainder;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < need; i++) {
    const f = document.createElement('div');
    f.className = fillerClass;
    f.setAttribute('aria-hidden', 'true');
    frag.appendChild(f);
  }
  container.appendChild(frag);
}

// Wire one container so it re-pads on window resize. Idempotent -- a
// second call replaces the previous handler so callers can wire on
// every render without leaking listeners.
export function watchTileRows(container, opts) {
  if (!container) return;
  if (container[_RESIZE_KEY]) {
    window.removeEventListener('resize', container[_RESIZE_KEY]);
  }
  let pending = null;
  const handler = () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => padTileRows(container, opts));
  };
  container[_RESIZE_KEY] = handler;
  window.addEventListener('resize', handler, { passive: true });
  padTileRows(container, opts);
}

// Wire a container so it re-renders (via the caller's callback) on
// window resize. Needed when padTileRows is used with hasMore=true:
// trimming orphans is destructive, so a resize that changes the column
// count means the trimmed tiles need to come back via a fresh render.
// Idempotent -- a second call replaces the previous handler.
const _RERENDER_KEY = '__tileRerenderHandler';
export function watchTileRerender(container, callback) {
  if (!container || typeof callback !== 'function') return;
  if (container[_RERENDER_KEY]) {
    window.removeEventListener('resize', container[_RERENDER_KEY]);
  }
  let pending = null;
  const handler = () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => callback());
  };
  container[_RERENDER_KEY] = handler;
  window.addEventListener('resize', handler, { passive: true });
}
