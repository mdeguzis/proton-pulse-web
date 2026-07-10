/**
 * #N/A: numbered page nav for the home browse sections.
 * Pins the slot algorithm and the rendered HTML shape so the layout
 * stays consistent + the click wiring keeps addressing the right button.
 */
const path = require('path');

let pageSlots, pageNavHtml, wirePageNav;
beforeAll(async () => {
  const mod = await import(path.join(__dirname, '..', 'js', 'app', 'lib', 'page-nav.js'));
  ({ pageSlots, pageNavHtml, wirePageNav } = mod);
});

describe('pageSlots', () => {
  test('lists every page when total fits under the visual budget', () => {
    expect(pageSlots(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageSlots(3, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('collapses the middle with ellipsis when totals exceed the budget', () => {
    // Current at 6 / 20 -> keep edges, current, +- 1 with an ellipsis on each side.
    const out = pageSlots(6, 20);
    expect(out[0]).toBe(1);
    expect(out.includes('...')).toBe(true);
    expect(out.includes(6)).toBe(true);
    expect(out[out.length - 1]).toBe(20);
  });

  test('never emits adjacent-page ellipsis for pages near the edges', () => {
    // Current at 2 / 20 -> "1, 2, 3, 4, ..., 19, 20" -- no "1, ..., 2".
    const out = pageSlots(2, 20);
    // Ellipsis only appears once, between the low run and the tail.
    const idx = out.indexOf('...');
    expect(idx).toBeGreaterThanOrEqual(3);
  });

  test('clamps current to [1, total]', () => {
    expect(pageSlots(-5, 3)).toEqual([1, 2, 3]);
    expect(pageSlots(999, 3)).toEqual([1, 2, 3]);
  });

  test('total <= 0 collapses to a single page', () => {
    expect(pageSlots(1, 0)).toEqual([1]);
    expect(pageSlots(1, -3)).toEqual([1]);
  });
});

describe('pageNavHtml', () => {
  test('returns empty string when there is at most one page (no nav needed)', () => {
    expect(pageNavHtml(1, 1)).toBe('');
    expect(pageNavHtml(1, 0)).toBe('');
  });

  test('renders a button per page slot with the current page marked', () => {
    const html = pageNavHtml(3, 5);
    // Class hooks the CSS to render right-aligned; test the important bits.
    expect(html).toContain('page-nav-btn');
    expect(html).toContain('data-page="3"');
    expect(html).toContain('page-nav-btn--active');
    expect(html).toContain('aria-current="page"');
  });

  test('emits ellipsis markup when totals exceed the budget', () => {
    expect(pageNavHtml(6, 30)).toContain('page-nav-ellipsis');
  });

  test('includes Prev / Next arrow buttons and a "Page X of Y" label', () => {
    const html = pageNavHtml(5, 15);
    expect(html).toContain('page-nav-btn--arrow');
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
    expect(html).toContain('data-page="4"');   // prev
    expect(html).toContain('data-page="6"');   // next
    expect(html).toContain('Page 5 of 15');
  });

  test('disables Prev on page 1 and Next on the last page', () => {
    const first = pageNavHtml(1, 15);
    expect(first).toMatch(/data-page="0"[^>]*disabled/);
    expect(first).not.toMatch(/data-page="2"[^>]*disabled/);
    const last = pageNavHtml(15, 15);
    expect(last).toMatch(/data-page="16"[^>]*disabled/);
    expect(last).not.toMatch(/data-page="14"[^>]*disabled/);
  });
});

describe('wirePageNav', () => {
  test('is a no-op when container is missing', () => {
    expect(() => wirePageNav(null, () => {})).not.toThrow();
  });

  test('replaces the previous handler instead of stacking on re-wire', () => {
    // Simulate a container that records addEventListener/removeEventListener
    // calls. A caller re-wiring on every re-render must NOT accumulate
    // listeners -- otherwise a click would fire onSelect N times.
    const added = [];
    const removed = [];
    const container = {
      addEventListener: (type, fn) => added.push(fn),
      removeEventListener: (type, fn) => removed.push(fn),
    };
    const onSelect = () => {};
    wirePageNav(container, onSelect);
    wirePageNav(container, onSelect);
    wirePageNav(container, onSelect);
    // Three wires => two removes (the second and third wire each remove the
    // prior handler) and three adds.
    expect(added.length).toBe(3);
    expect(removed.length).toBe(2);
    // Each removal targets the handler that was added just before it.
    expect(removed[0]).toBe(added[0]);
    expect(removed[1]).toBe(added[1]);
  });

  test('ignores clicks on disabled buttons (prev on page 1, next on last)', () => {
    // The arrow buttons render with the `disabled` attribute at the edges;
    // wirePageNav's handler must respect that so a click on a disabled
    // arrow does not fire onSelect(0) or onSelect(total+1).
    const calls = [];
    const container = {
      _listener: null,
      addEventListener: function (type, fn) { this._listener = fn; },
      removeEventListener: function () { this._listener = null; },
    };
    wirePageNav(container, (n) => calls.push(n));
    // Simulate a click on a disabled prev button.
    container._listener({
      target: {
        closest: () => ({ disabled: true, dataset: { page: '0' } }),
      },
    });
    expect(calls).toEqual([]);
    // Simulate a click on an enabled page 3 button.
    container._listener({
      target: {
        closest: () => ({ disabled: false, dataset: { page: '3' } }),
      },
    });
    expect(calls).toEqual([3]);
  });
});
