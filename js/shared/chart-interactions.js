// chart-interactions (shared) module. Used across multiple pages. Relocated from app-chart-interactions.js.

// Common interactive chart helpers. Adds hover-to-trace + click-to-filter
// to any SVG chart that follows the data-point convention below.
//
// The existing chart on stats.html (the multi-year sparkline) already uses
// invisible <rect class="hover-target"> per data point. This module wraps
// that pattern as a reusable helper so game-stats.html and any future chart
// can call attachChartHover() / attachClickToFilter() without duplicating
// boilerplate.
//
// Loaded as a classic script BEFORE the page's chart-rendering scripts so
// the globals (attachChartHover, attachClickToFilter, dispatchFilter) are
// ready at init time. There is no auto-init -- callers wire this up after
// they inject their SVG into the DOM.
//
// HTML contract for a hover-traceable chart:
//   <svg>
//     ...your chart paths...
//     <line class="ci-hover-guide" id="ci-guide-{id}"/>
//     <circle class="ci-hover-dot" id="ci-dot-{id}-pos"/>
//     <circle class="ci-hover-dot ci-neg" id="ci-dot-{id}-neg"/>
//     <rect class="ci-hover-target" data-idx="0" x="..." y="..." width="..." height="..."/>
//     ...one rect per data point...
//   </svg>
//   <div class="ci-tooltip" id="ci-tip-{id}"/>
//
// And in CSS (already in app.css for the existing chart):
//   .ci-hover-target { cursor: pointer; }
//   .ci-hover-guide  { opacity: 0; stroke: rgba(255,255,255,0.18); stroke-dasharray: 3 3; pointer-events: none; }
//   .ci-hover-dot    { opacity: 0; r: 4; fill: #5bd17a; pointer-events: none; }
//   .ci-hover-dot.ci-neg { fill: #ff6b6b; }
//   .ci-host.is-hovered .ci-hover-guide,
//   .ci-host.is-hovered .ci-hover-dot { opacity: 1; }
//   .ci-tooltip { position: absolute; opacity: 0; pointer-events: none; ... }
//   .ci-host.is-hovered .ci-tooltip { opacity: 1; }

// Attach hover behaviour to an already-rendered SVG chart.
//
// opts:
//   svg        : the <svg> element
//   host       : the wrapping element that gets the .is-hovered class
//                (so CSS can show the guide/dot/tooltip in one rule)
//   tooltip    : the tooltip DOM node positioned within `host`
//   guide      : the <line> guide element (optional)
//   dots       : array of <circle> elements positioned to the data point
//   data       : array of data items, one per hover target rect
//   getX       : (idx) => x coordinate in SVG userspace
//   getYForDot : (item, dotIdx) => y coordinate for dots[dotIdx]
//   renderTip  : (item, idx) => innerHTML for the tooltip
//   onClick    : (item, idx) => optional click handler for filtering
export function attachChartHover(opts) {
  const {
    svg, host, tooltip, guide, dots = [],
    data, getX, getYForDot, renderTip, onClick,
  } = opts;
  if (!svg || !host || !tooltip || !data || !data.length) return;

  // showAt(idx, atX) does the actual reveal -- guide line, dots, tooltip.
  // When atX is supplied (continuous-tracking mode), the guide line + dots
  // ride the cursor's x coordinate and their y is interpolated linearly
  // along the segment between data[idx] and the adjacent point, so they
  // visually slide along the line. Tooltip still shows the nearest data
  // point (idx) so the readout stays stable. atX is omitted in the legacy
  // discrete-rect path; the dot then sits at the data point exactly
  const showAt = (idx, atX) => {
    const item = data[idx];
    if (item == null) return;
    const x = atX != null ? atX : getX(idx);
    if (guide) {
      guide.setAttribute('x1', x);
      guide.setAttribute('x2', x);
    }
    dots.forEach((dot, di) => {
      if (!dot) return;
      let cy = getYForDot(item, di);
      if (atX != null) {
        // Pick the neighbour segment that contains atX and linearly
        // interpolate between this point's y and the neighbour's y
        const here = getX(idx);
        let neighbourIdx = -1;
        if (atX > here && idx < data.length - 1) neighbourIdx = idx + 1;
        else if (atX < here && idx > 0) neighbourIdx = idx - 1;
        if (neighbourIdx !== -1) {
          const there = getX(neighbourIdx);
          const span = there - here;
          if (span !== 0) {
            const t = (atX - here) / span;
            const yHere = cy;
            const yThere = getYForDot(data[neighbourIdx], di);
            cy = yHere + t * (yThere - yHere);
          }
        }
      }
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', cy);
    });
    host.classList.add('is-hovered');
    tooltip.innerHTML = renderTip(item, idx);

    // Tooltip x = data-point x in screen pixels, clamped inside the host.
    // We translate viewBox x -> screen x via the svg's bounding rect so
    // the math works whether the chart uses preserveAspectRatio meet or
    // none. viewBox is `0 0 vbW vbH`
    const hostRect = host.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const vbW = vb ? vb.width : svgRect.width;
    const screenXInSvg = (x / vbW) * svgRect.width;
    const screenX = svgRect.left + screenXInSvg - hostRect.left;

    const tipW = tooltip.offsetWidth || 120;
    let leftPx = screenX - tipW / 2;
    const maxLeft = hostRect.width - tipW - 4;
    if (leftPx < 4) leftPx = 4;
    if (leftPx > maxLeft) leftPx = maxLeft;
    tooltip.style.left = leftPx + 'px';
  };

  // Continuous mode: a single full-width <rect class="ci-hover-target ci-hover-full">
  // gets a mousemove listener that picks the nearest data point. Falls back
  // to discrete per-column rects when ci-hover-full isnt present.
  const fullTarget = svg.querySelector('.ci-hover-target.ci-hover-full');
  if (fullTarget) {
    const handleMove = (ev) => {
      const svgRect = svg.getBoundingClientRect();
      const vb = svg.viewBox && svg.viewBox.baseVal;
      const vbW = vb ? vb.width : svgRect.width;
      // Map cursor screen x back into viewBox x, then find nearest data idx
      const vbX = ((ev.clientX - svgRect.left) / svgRect.width) * vbW;
      let nearest = 0;
      let bestDist = Infinity;
      for (let i = 0; i < data.length; i++) {
        const dx = Math.abs(getX(i) - vbX);
        if (dx < bestDist) { bestDist = dx; nearest = i; }
      }
      showAt(nearest);
    };
    fullTarget.addEventListener('mousemove', handleMove);
    fullTarget.addEventListener('mouseleave', () => {
      host.classList.remove('is-hovered');
    });
    if (onClick) {
      fullTarget.addEventListener('click', (ev) => {
        const svgRect = svg.getBoundingClientRect();
        const vb = svg.viewBox && svg.viewBox.baseVal;
        const vbW = vb ? vb.width : svgRect.width;
        const vbX = ((ev.clientX - svgRect.left) / svgRect.width) * vbW;
        let nearest = 0;
        let bestDist = Infinity;
        for (let i = 0; i < data.length; i++) {
          const dx = Math.abs(getX(i) - vbX);
          if (dx < bestDist) { bestDist = dx; nearest = i; }
        }
        onClick(data[nearest], nearest);
      });
    }
    return;
  }

  // Legacy discrete mode: one rect per data point
  const targets = svg.querySelectorAll('.ci-hover-target');
  targets.forEach(rect => {
    const idx = parseInt(rect.getAttribute('data-idx'), 10);
    if (isNaN(idx) || data[idx] == null) return;
    rect.addEventListener('mouseenter', () => showAt(idx));
    rect.addEventListener('mouseleave', () => host.classList.remove('is-hovered'));
    if (onClick) rect.addEventListener('click', () => onClick(data[idx], idx));
  });
}

// Wire click-to-filter behaviour on any element matching a CSS selector.
// On click, dispatches a 'chart-filter' CustomEvent on the document so the
// page-level filter listener can update the list below.
//
// opts:
//   root      : ancestor to query within (defaults to document)
//   selector  : CSS selector for clickable items (eg. '.gs-dist .chip')
//   getFilter : (clickedEl) => { key, value } -- the filter payload
//   activeClass: optional CSS class to toggle as the active filter
export function attachClickToFilter({ root = document, selector, getFilter, activeClass = 'is-active' }) {
  root.querySelectorAll(selector).forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const payload = getFilter(el);
      if (!payload) return;
      // Toggle active state: clicking the active filter clears it
      const wasActive = el.classList.contains(activeClass);
      root.querySelectorAll(`${selector}.${activeClass}`).forEach(other => {
        other.classList.remove(activeClass);
      });
      if (!wasActive) el.classList.add(activeClass);
      dispatchFilter(wasActive ? null : payload);
    });
  });
}

export function dispatchFilter(payload) {
  document.dispatchEvent(new CustomEvent('chart-filter', { detail: payload }));
}

// Convenience listener registration. Callers pass a callback that receives
// the filter payload (or null when the filter is cleared) and decides what
// to do with the list below the chart.
export function onFilterChange(callback) {
  document.addEventListener('chart-filter', ev => callback(ev.detail));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    attachChartHover,
    attachClickToFilter,
    dispatchFilter,
    onFilterChange,
  };
}
