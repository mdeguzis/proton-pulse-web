/**
 * Tests for admin analytics component and userDetail report actions.
 *
 * Coverage:
 *  - renderAnalytics: stat rows, chart canvas, table sections rendered
 *  - renderUserDetail: report table, copy button, edit modal, audit log
 *  - ppTrack wiring in game-page.js and submit/main.js (source-level checks)
 */

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const ROOT = path.join(__dirname, '..');
const noop = () => {};

function stubEl() {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {},
    addEventListener: noop, removeEventListener: noop,
    appendChild: noop, removeChild: noop,
    setAttribute: noop, getAttribute: () => null,
    querySelector: () => stubEl(),
    querySelectorAll: () => [],
    closest: () => null, contains: () => false,
    focus: noop, blur: noop, click: noop,
  };
}

function capturedElement() {
  const store = { html: '' };
  const el = stubEl();
  Object.defineProperty(el, 'innerHTML', {
    set(v) { store.html = v; },
    get()  { return store.html; },
    configurable: true,
  });
  el._querySelector = sel => stubEl();
  el.querySelector   = sel => el._querySelector(sel);
  el.querySelectorAll = () => [];
  return { el, store };
}

// ── renderAnalytics ──────────────────────────────────────────────────────────

describe('renderAnalytics', () => {
  let ctx;
  let store;

  beforeAll(() => {
    const { el: contentEl, store: s } = capturedElement();
    store = s;
    ctx = loadEsm(['js/admin/utils.js', 'js/admin/components/analytics.js'], {
      console, Promise, JSON, Object, Array, Number, String, Boolean,
      RegExp, Error, Date, Math, Map, Set, URL, URLSearchParams,
      setTimeout, clearTimeout, parseInt, isNaN,
      document: {
        getElementById: () => contentEl,
        querySelector:   () => null,
        querySelectorAll: () => [],
        createElement:   () => stubEl(),
        addEventListener: noop,
      },
      window: {},
      Chart: undefined,
    });
  });

  const sampleData = {
    totals: {
      total_events: 42, total_sessions: 10, authed_users: 5,
      new_users: 2, auth_success: 8, auth_failure: 1, reports_submitted: 3,
    },
    daily:       [{ day: '2026-06-01', events: 5, sessions: 2, unique_users: 1 }],
    top_pages:   [{ page: '/app.html', views: 7 }],
    top_games:   [{ app_id: '730', title: 'Counter-Strike 2', views: 4 }],
    event_types: [{ event_type: 'page_view', total: 7 }],
  };

  test('renders stat rows with correct values', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('42');
    expect(store.html).toContain('Total events');
    expect(store.html).toContain('New users');
    expect(store.html).toContain('Login failures');
    expect(store.html).toContain('Reports submitted');
  });

  test('renders chart canvas placeholder', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('analytics-daily-chart');
  });

  test('renders top pages table', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('/app.html');
    expect(store.html).toContain('Top pages');
  });

  test('renders top games table with link', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('Counter-Strike 2');
    expect(store.html).toContain('/app/730');
  });

  test('renders event breakdown table', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('page_view');
    expect(store.html).toContain('Event breakdown');
  });

  test('renders empty state for no top games', () => {
    ctx.renderAnalytics({ ...sampleData, top_games: [] }, { daysBack: 7, onChangeDays: noop });
    expect(store.html).toContain('No game views tracked yet');
  });

  test('shows active day button', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 7, onChangeDays: noop });
    expect(store.html).toContain('data-days="7"');
    expect(store.html).toContain('admin-sort-btn--active');
  });

  test('escapes HTML in page names', () => {
    const data = { ...sampleData, top_pages: [{ page: '<script>alert(1)</script>', views: 1 }] };
    ctx.renderAnalytics(data, { daysBack: 30, onChangeDays: noop });
    expect(store.html).not.toContain('<script>alert(1)</script>');
    expect(store.html).toContain('&lt;script&gt;');
  });

  test('renders Summary section header', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('Summary');
  });

  test('renders sticky jump-nav with all section buttons', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('analytics-jump-nav');
    // One button per major section -- a missing one means the nav is out of sync
    ['sec-daily', 'sec-reports', 'sec-pages', 'sec-games', 'sec-summary', 'sec-sw-cache', 'sec-data-cache', 'sec-img-routes', 'sec-img-timings']
      .forEach(id => expect(store.html).toContain(`data-target="${id}"`));
  });

  test('renders data-cache section placeholder and refresh button', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('Pipeline data cache');
    expect(store.html).toContain('id="data-cache-table"');
    expect(store.html).toContain('id="data-cache-refresh"');
    // Initial placeholder is rendered synchronously; the actual probe runs async
    expect(store.html).toContain('Probing data files...');
  });

  test('image routes section reads window.__imgRouteCounts', () => {
    // Bump the counter, then render -- the rendered table should reflect counts.
    ctx.window.__imgRouteCounts = { cloudflare: 3, 'game-images-json': 1, 'nonsteam-images-json': 0, hidden: 0 };
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('Image route hits');
    expect(store.html).toContain('Cloudflare CDN');
    expect(store.html).toContain('Total fallbacks');
    ctx.window.__imgRouteCounts = {};
  });

  test('image routes section shows empty state when no fallbacks hit', () => {
    ctx.window.__imgRouteCounts = {};
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('Primary akamai CDN handled every image');
  });

  test('image timings section renders and shows empty state when no entries', () => {
    ctx.renderAnalytics(sampleData, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('Image load timings');
    expect(store.html).toContain('id="img-timings-table"');
    // performance is undefined in the vm context -> stats are empty -> empty state shown
    expect(store.html).toContain('No image transfers observed yet this session');
  });

  test('Most viewed games link is relative so it works on the staged subpath', () => {
    // A leading-slash `/app.html` resolves to the domain root and breaks the
    // staging preview which lives under /proton-pulse-web-staging/. The
    // relative form works on both prod and staging.
    ctx.renderAnalytics({
      ...sampleData,
      top_games: [{ app_id: '12345', title: 'Test Game', views: 42 }],
    }, { daysBack: 30, onChangeDays: noop });
    expect(store.html).toContain('href="app.html#/app/12345"');
    expect(store.html).not.toContain('href="/app.html');
  });
});

// ── renderUserDetail ─────────────────────────────────────────────────────────

describe('renderUserDetail', () => {
  let ctx;
  let store;

  beforeAll(() => {
    const { el: contentEl, store: s } = capturedElement();
    store = s;
    // querySelector needs to return stubs with addEventListener
    contentEl._querySelector = () => {
      const el = stubEl();
      el.addEventListener = noop;
      return el;
    };
    ctx = loadEsm([
      'js/admin/utils.js',
      'js/admin/api/userDetail.js',
      'js/admin/components/userDetail.js',
    ], {
      console, Promise, JSON, Object, Array, Number, String, Boolean,
      RegExp, Error, Date, Math, Map, Set, URL, URLSearchParams,
      setTimeout, clearTimeout, parseInt, isNaN,
      document: {
        getElementById: () => contentEl,
        querySelector:   () => null,
        querySelectorAll: () => [],
        createElement:   () => stubEl(),
        addEventListener: noop,
      },
      navigator: { clipboard: { writeText: () => Promise.resolve() } },
      window: {},
      fetch: () => Promise.resolve({ ok: true, json: async () => [] }),
    });
  });

  const user = {
    proton_pulse_user_id: 'aaa-111',
    client_id: 'bbb-222',
    display_name: 'testuser',
    role: 'user',
    last_login: '2026-06-01T00:00:00Z',
    last_active: '2026-06-10T00:00:00Z',
  };

  const reports = [{
    id: 1, app_id: '730', title: 'Counter-Strike 2',
    rating: 'gold', proton_version: 'Proton 9.0',
    created_at: '2026-06-01T00:00:00Z', source: 'web',
    is_hidden: false, is_flagged: false,
    launch_options: '', notes: '',
  }];

  test('renders report row with game title', () => {
    ctx.renderUserDetail(user, reports, [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('Counter-Strike 2');
  });

  test('renders Edit, Hide, Delete action buttons', () => {
    ctx.renderUserDetail(user, reports, [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('data-action="edit-report"');
    expect(store.html).toContain('data-action="hide-report"');
    expect(store.html).toContain('data-action="delete-report"');
  });

  test('renders hidden badge when is_hidden=true', () => {
    // #150: user-detail Reports rows now reuse the shared admin-badge
    // palette (muted = hidden) so the row matches the All Reports table.
    ctx.renderUserDetail(user, [{ ...reports[0], is_hidden: true }], [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('admin-badge--muted');
  });

  test('renders flagged badge when is_flagged=true', () => {
    ctx.renderUserDetail(user, [{ ...reports[0], is_flagged: true }], [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('admin-badge--warn');
  });

  test('renders empty state when no reports', () => {
    ctx.renderUserDetail(user, [], [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('No reports submitted yet');
  });

  test('renders clipboard icon copy button with SVG', () => {
    ctx.renderUserDetail(user, [], [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('data-action="copy-id"');
    expect(store.html).toContain('<svg');
    expect(store.html).not.toMatch(/data-action="copy-id"[^>]*>\s*Copy\s*</);
  });

  test('escapes HTML in display_name', () => {
    ctx.renderUserDetail({ ...user, display_name: '<script>alert(1)</script>' }, [], [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).not.toContain('<script>alert(1)</script>');
    expect(store.html).toContain('&lt;script&gt;');
  });

  test('disables ban button when viewing self', () => {
    ctx.renderUserDetail(user, [], [], { session: null, onBack: noop, onBan: noop, currentUserId: 'aaa-111' });
    expect(store.html).toContain('Cannot ban yourself');
  });

  test('renders audit log filter dropdown with event types', () => {
    const events = [
      { id: 1, event_type: 'page_view',    page: '/app.html',  metadata: null, created_at: '2026-06-01T00:00:00Z' },
      { id: 2, event_type: 'auth_success', page: '/auth.html', metadata: null, created_at: '2026-06-02T00:00:00Z' },
    ];
    ctx.renderUserDetail(user, [], events, { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('ud-activity-filter');
    expect(store.html).toContain('page_view');
    expect(store.html).toContain('auth_success');
  });

  test('renders edit modal in DOM', () => {
    ctx.renderUserDetail(user, reports, [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('ud-edit-modal');
    expect(store.html).toContain('ud-edit-rating');
  });

  test('shows Plugin ID label (not Plugin Client ID)', () => {
    ctx.renderUserDetail(user, [], [], { session: null, onBack: noop, onBan: noop, currentUserId: 'other' });
    expect(store.html).toContain('Plugin ID');
    expect(store.html).not.toContain('Plugin Client ID');
  });
});

// ── ppTrack source-level wiring ──────────────────────────────────────────────

describe('ppTrack - game_view event', () => {
  test('game-page.js calls ppTrack with game_view, app_id, and title', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/app/components/game-page.js'), 'utf8');
    expect(src).toContain("ppTrack('game_view'");
    expect(src).toContain('app_id');
    expect(src).toContain('title');
  });
});

describe('ppTrack - report_submit event', () => {
  test('submit/main.js calls ppTrack with report_submit on result.ok', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/submit/main.js'), 'utf8');
    expect(src).toContain("ppTrack('report_submit'");
    expect(src).toContain('app_id');
    expect(src).toContain('result.ok');
  });
});
