// Pad a tile-mode grid container so the last row has the same number of
// boxes as the rows above it. CSS grid normally leaves the trailing
// columns of an incomplete row blank, which reads as a ragged edge in
// the Steam-style tile view. We append invisible filler divs (with the
// classes `<prefix>-card tile-filler`) so the trailing tiles still take
// up the same grid cells without showing any content.
//
// Call padTileRows(containerEl, { tileSelector, fillerClass }) after
// every render of the tiles, and once after window resize. The helper
// reads grid-template-columns off the live computed style so it
// respects whatever auto-fill column count the browser actually picked.

const _RESIZE_KEY = '__tilePadHandlers';

export function padTileRows(container, { tileSelector = '> *', fillerClass = 'tile-filler' } = {}) {
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
