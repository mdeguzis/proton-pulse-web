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
});

describe('wirePageNav', () => {
  test('is a no-op when container is missing', () => {
    expect(() => wirePageNav(null, () => {})).not.toThrow();
  });
});
