/**
 * #410 variant B: FPS runs on report cards + the single-report stats slice.
 *
 * - renderFpsRow: aggregate row + runs chip capped at 5 inline rows, with
 *   the All stats link to game-stats.html?app=X&report=Y
 * - game-stats.html?report=<id> filters every section to that one report
 *   and renders the per-run graph + sortable table
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const GS_SRC = read('js/game-stats/main.js');
const GS_HTML = read('game-stats.html');
const CARD_CSS = read('css/app/reports.css');
const GP_SRC = read('js/app/components/game-page.js');

function loadCard() {
  return loadEsm(['js/app/components/report-card.js'], {
    console: { log() {}, debug() {}, warn() {}, error() {} },
    // loadEsm strips imports; esc normally arrives from app/utils.js.
    esc: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  });
}

const runs = (n) => Array.from({ length: n }, (_, i) => ({
  name: `run${i + 1}.csv`, fpsMin: 50 + i, fpsAvg: 60 + i, fpsMax: 70 + i, sampleCount: 1000 + i,
}));

describe('renderFpsRow (report card, variant B)', () => {
  test('renders nothing without aggregate or runs', () => {
    const mod = loadCard();
    expect(mod.renderFpsRow({})).toBe('');
  });

  test('aggregate-only report keeps the plain FPS row, no chip', () => {
    const mod = loadCard();
    const html = mod.renderFpsRow({ fpsMin: 54.2, fpsAvg: 72.8, fpsMax: 101.2 });
    expect(html).toContain('54.2 / 72.8 / 101.2');
    expect(html).not.toContain('fps-runs-chip');
    expect(html).not.toContain('All stats');
  });

  test('runs produce the chip, the panel, and the All stats link', () => {
    const mod = loadCard();
    const html = mod.renderFpsRow({
      appId: '2561580', reportId: 42, fpsMin: 50, fpsAvg: 61, fpsMax: 72,
      formResponses: { fpsRuns: runs(3) },
    });
    expect(html).toContain('3 runs');
    expect(html).toContain('fps-runs-panel');
    expect(html).toContain('game-stats.html?app=2561580&report=42');
    expect(html).toContain('All stats');
    expect((html.match(/fps-run-line-name/g) || []).length).toBe(3);
  });

  test('caps inline rows at 5 and routes overflow to the All stats page', () => {
    const mod = loadCard();
    const html = mod.renderFpsRow({
      appId: '10', reportId: 7, fpsAvg: 60, formResponses: { fpsRuns: runs(8) },
    });
    expect((html.match(/fps-run-line-name/g) || []).length).toBe(5);
    expect(html).toContain('+3 more run');
    expect(html).toContain('game-stats.html?app=10&report=7');
  });

  test('escapes run names (uploaded filenames are user input)', () => {
    const mod = loadCard();
    const html = mod.renderFpsRow({
      appId: '10', reportId: 7, fpsAvg: 60,
      formResponses: { fpsRuns: [{ name: '<img src=x onerror=alert(1)>.csv', fpsAvg: 60, sampleCount: 5 }] },
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  test('card CSS carries the chip and panel styles', () => {
    expect(CARD_CSS).toContain('.fps-runs-chip');
    expect(CARD_CSS).toContain('.fps-run-line');
  });
});

describe('game-stats single-report slice (?report=)', () => {
  test('report param is numeric-validated before use', () => {
    expect(GS_SRC).toMatch(/\/\^\[0-9\]\+\$\/\.test\(reportRaw\)/);
  });

  test('slice filters allReports down to the matching report', () => {
    expect(GS_SRC).toContain("allReports.find(r => String(r.id ?? r.reportId ?? '') === reportId)");
    expect(GS_SRC).toContain('allReports = [sliceReport]');
  });

  test('missing report id falls back to full stats instead of erroring', () => {
    expect(GS_SRC).toContain('report id not found; falling back to full stats');
  });

  test('slice banner links back to the full game stats', () => {
    expect(GS_SRC).toContain('gs-slice-banner');
    expect(GS_HTML).toContain('.gs-slice-banner');
  });

  test('per-run section: Chart.js graph, JSON download, summary bars, sortable table', () => {
    expect(GS_SRC).toContain('renderFpsRunsSection');
    // Interactive Chart.js line chart on a canvas (pinned CDN version).
    expect(GS_SRC).toContain("new window.Chart(canvas");
    expect(GS_SRC).toContain("interaction: { mode: 'index', intersect: false }");
    expect(GS_HTML).toContain('chart.js@4.4.7');
    // The graph ALWAYS renders: FPS-over-time lines with series; without
    // series, a multi-line chart across runs (one toggleable line per
    // metric: Max / Average / 1% Low / Min). Both are type line.
    expect(GS_SRC).not.toContain("type: 'bar'");
    // 3 line charts: series over time, no-series metric fallback, and the
    // FlightlessSomething detail expansion.
    expect((GS_SRC.match(/type: 'line'/g) || []).length).toBe(3);
    expect((GS_SRC.match(/new window\.Chart\(canvas/g) || []).length).toBe(3);
    // The toolbar download icon must not inherit the generic chart-svg size.
    expect(GS_HTML).toContain('.gs-chart .gs-fps-dl svg { width: 15px; height: 15px;');
    // Download-as-JSON icon in the chart toolbar.
    expect(GS_SRC).toContain('id="fps-download-json"');
    expect(GS_SRC).toContain('series_downsampled');
    expect(GS_SRC).toContain('fps_p1_low');
    // FlightlessSomething Summary-tab bars: Average / 1% Low / 0.1% Low.
    expect(GS_SRC).toContain("{ label: '1% Low', get: r => r.fpsP1 ?? r.fpsMin");
    expect(GS_SRC).toContain("'0.1% Low'");
    // Filterable + sortable table.
    expect(GS_SRC).toContain('id="fps-runs-filter"');
    expect(GS_SRC).toContain('id="fps-runs-table"');
    expect(GS_SRC).toContain('wireFpsRunsSection');
    expect(GS_SRC).toContain("th.dataset.sort === 'num'");
    expect(GS_HTML).toContain('.gs-fps-table');
    expect(GS_HTML).toContain('.gs-fps-dl');
  });

  test('slice mode is FOCUSED: only report stats render, banner links to full stats', () => {
    // In report mode the game-wide sections are skipped entirely (early
    // return before the full renderAll output is used).
    expect(GS_SRC).toContain('Click here to view all game statistics');
    expect(GS_SRC).toMatch(/root\.innerHTML = sliceBanner \+ renderFpsRunsSection\(sliceReport\);[\s\S]{0,300}return;/);
    // Plain header line (no chips) + a link back to the report.
    expect(GS_SRC).toContain('gs-slice-head-title');
    expect(GS_SRC).not.toContain('gs-slice-fact ');
    expect(GS_SRC).toContain("facts.join(' · ')");
    expect(GS_SRC).toContain('View the report');
    // No-runs slice explains itself instead of a blank page.
    expect(GS_SRC).toContain('This report has no per-run MangoHud captures.');
    // No hardware-match banner in slice mode -- nothing scores against the
    // viewer's system on the focused view (#412 tracks the real consumer).
    expect(GS_SRC).toContain('root.innerHTML = sliceBanner + renderFpsRunsSection(sliceReport);');
  });

  test('pulse reports load from user_configs, not the phantom native_reports table', () => {
    // Regression: game-stats queried a native_reports table that does not
    // exist, so Pulse reports (and the ?report= slice target) never loaded.
    expect(GS_SRC).not.toContain("from('native_reports')");
    expect(GS_SRC).toContain('/user_configs?app_id=eq.');
    expect(GS_SRC).toContain('form_responses');
    // Plugin config lookup skips non-numeric ids (bigint column).
    expect(GS_SRC).toMatch(/if \(!\/\^\\d\+\$\/\.test\(String\(appId\)\)\) return \[\];/);
  });
});

describe('game-wide stats mode (#410 follow-ups)', () => {
  test('FPS section renders at the BOTTOM with all reports runs, report-prefixed', () => {
    // Game mode merges every report's fpsRuns (no filter), prefixing each
    // run with its report id so the table stays attributable.
    expect(GS_SRC).toContain('const gameFpsRuns = allReports.filter');
    expect(GS_SRC).toMatch(/name: `#\$\{rid \?\? '\?'\} \$\{run\.name \|\| 'run'\}`/);
    // Section is appended after the two-col block, before the back link.
    const fpsIdx = GS_SRC.indexOf('${fpsSectionHtml}');
    const backIdx = GS_SRC.lastIndexOf('class="gs-back"');
    const launchIdx = GS_SRC.lastIndexOf("'Launch options that work'");
    expect(fpsIdx).toBeGreaterThan(launchIdx);
    expect(fpsIdx).toBeLessThan(backIdx);
    // Wired in game mode too (chart + download + sort).
    expect(GS_SRC).toContain('wireFpsRunsSection(root, appId, null)');
  });

  test('jump-to-section dropdown mirrors the profile pattern', () => {
    expect(GS_SRC).toContain('id="gs-jump-select"');
    expect(GS_SRC).toContain("['current-state', 'Current state']");
    expect(GS_SRC).toContain("['launch-options', 'Launch options']");
    // FPS entry only when the section exists.
    expect(GS_SRC).toContain("...(fpsSectionHtml ? [['fps-runs', 'FPS runs']] : [])");
    // Select resets to the placeholder after each jump.
    expect(GS_SRC).toContain("jumpSelect.value = ''");
    expect(GS_HTML).toContain('.gs-jump-select');
  });
});

describe('runs filters + legend fill (#410 polish)', () => {
  test('legend squares fill when active and hollow when toggled off', () => {
    expect(GS_SRC).toContain('generateLabels(chart)');
    expect(GS_SRC).toContain("it.fillStyle = it.hidden ? 'transparent' : color");
  });

  test('date-range picker filters runs by filename date', () => {
    expect(GS_SRC).toContain('_runDateFromName');
    expect(GS_SRC).toContain('id="fps-runs-from"');
    expect(GS_SRC).toContain('id="fps-runs-to"');
    // Range check: hidden when outside [from, to]; undated rows stay visible.
    expect(GS_SRC).toContain('const dateMiss = !!d && ((from && d < from) || (to && d > to))');
    expect(GS_HTML).toContain('.gs-fps-date');
  });
});

describe('title-matched FlightlessSomething section on the stats page (#410)', () => {
  test('renders below the confirmed FPS section with the disclaimer', () => {
    const fpsIdx = GS_SRC.indexOf('${fpsSectionHtml}');
    const flIdx = GS_SRC.indexOf('${renderFlightlessSection(flightlessEntry, title)}');
    expect(flIdx).toBeGreaterThan(fpsIdx);
    // Required disclaimer copy: title-matched, unverified runtime, never
    // counted in the confirmed stats.
    expect(GS_SRC).toContain('Title-matched, unverified runtime.');
    expect(GS_SRC).toContain('matched to this game by title only');
    expect(GS_SRC).toContain('never counted in ratings, confidence, or the');
    expect(GS_SRC).toContain('mangohud.com');
  });

  test('loads the pipeline map and joins the parallel fetch', () => {
    expect(GS_SRC).toContain('loadFlightlessEntry(appId)');
    expect(GS_SRC).toContain('flightless-benchmarks.json');
    // The section always renders (matched or empty state), so its jump-list
    // entry is unconditional.
    expect(GS_SRC).toContain("['flightless-benchmarks', 'Community benchmarks'],");
  });

  test('community benchmarks live ONLY on the stats page, never on the game page', () => {
    // User requirement (2026-07-26): benchmarks are display-only context and
    // clutter the game reports page. They belong on the stats page next to
    // FPS + trend, not next to the reports list. Regression guard against
    // any future edit that reintroduces the section on the game page.
    expect(GP_SRC).not.toMatch(/flightless-section/);
    expect(GP_SRC).not.toMatch(/renderFlightless/);
    expect(GP_SRC).not.toMatch(/_loadFlightlessMap/);
    expect(GP_SRC).not.toMatch(/flightless-benchmarks\.json/);
    // Sanity: the stats page still has its copy so nothing was accidentally
    // stripped there instead.
    expect(GS_SRC).toContain('flightless-benchmarks.json');
  });

  test('no-match empty state names FlightlessSomething and links the formatted search', () => {
    // Games with zero matched benchmarks (e.g. Apex Legends) still get the
    // section: a "nothing found" note plus the same ?search= link a matched
    // game would have carried, so users can check or upload themselves.
    expect(GS_SRC).toContain('No community benchmarks found on');
    expect(GS_SRC).toContain('function flightlessSearchUrl(title)');
    expect(GS_SRC).toMatch(/flightlesssomething\.ambrosia\.one\/\?search=\$\{norm/);
    expect(GS_SRC).toContain('search for it yourself');
  });

  test('flightlessSearchUrl mirrors the pipeline normalization', () => {
    // Same normalize + quote_plus shape as search_url_for_title in
    // flightless_benchmarks.py: lowercase, alnum runs, + separators.
    const fn = new Function('title', `
      const norm = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return \`https://flightlesssomething.ambrosia.one/?search=\${norm.split(' ').filter(Boolean).join('+')}\`;
    `);
    expect(fn('Apex Legends')).toBe('https://flightlesssomething.ambrosia.one/?search=apex+legends');
    expect(fn("Sid Meier's Civilization VI")).toBe('https://flightlesssomething.ambrosia.one/?search=sid+meier+s+civilization+vi');
    expect(fn('OVERWATCH 2')).toBe('https://flightlesssomething.ambrosia.one/?search=overwatch+2');
  });

  test('benchmarks render on the no-reports stub too (OW2 regression)', () => {
    // OW2 had zero mirrored reports, so the early-return stub path skipped
    // renderAll -- and the benchmarks section with it. The stub must append
    // the section itself.
    expect(GS_SRC).toContain("` + renderFlightlessSection(flightlessEntry, title);");
  });

  test('benchmark links are origin-checked before rendering', () => {
    expect(GS_SRC).toMatch(/String\(entry\.search_url \|\| ''\)\.startsWith\('https:\/\/flightlesssomething\.ambrosia\.one\/'\)/);
  });
});

describe('flightless benchmark expansion (#410)', () => {
  test('each benchmark row carries a Show data & graphs toggle', () => {
    expect(GS_SRC).toContain('fl-expand-btn');
    expect(GS_SRC).toContain('Show data &amp; graphs');
    expect(GS_SRC).toContain('Hide data & graphs');
  });

  test('detail fetch is on-demand, cached, and renders chart + table', () => {
    // Never during page load; routed through the flightless-benchmark edge
    // fn proxy because FS's REST API sends no CORS headers.
    expect(GS_SRC).toContain('/functions/v1/flightless-benchmark?id=${encodeURIComponent(benchId)}');
    expect(GS_SRC).not.toContain('fetch(`https://flightlesssomething.ambrosia.one');
    expect(GS_SRC).toContain('_flDetailCache');
    // FS series arrives as [x, y] pairs; we plot the y values.
    expect(GS_SRC).toContain('Array.isArray(pt) ? pt[1] : pt');
    expect(GS_SRC).toContain('_renderFlightlessDetail');
    // Wired on BOTH render paths (stub + full page).
    expect((GS_SRC.match(/wireFlightlessSection\(root\)/g) || []).length).toBe(2);
  });

  test('game-stats CSP does NOT need the FS host (proxy handles it)', () => {
    expect(GS_HTML).not.toMatch(/connect-src[^;]*flightlesssomething/);
    // The edge fn itself must be registered public (read-only proxy).
    const CONFIG = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'config.toml'), 'utf8');
    expect(CONFIG).toContain('[functions.flightless-benchmark]');
    const FN = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'flightless-benchmark', 'index.ts'), 'utf8');
    expect(FN).toContain('isRateLimited');
    expect(FN).toMatch(/\/\^\\d\{1,10\}\$\//);
  });
});
