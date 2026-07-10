const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8'
);

describe('game page: ProtonDB live-only handling', () => {
  test('live summary is not merged into the rendered report list', () => {
    // reports[] must not spread liveFetched (that produced the broken stub card)
    expect(src).not.toMatch(/\.\.\.liveFetched\.map/);
    expect(src).not.toMatch(/\.\.\.liveCached\.map/);
    expect(src).toContain("const liveSummary = (liveFetched || []).find(r => r._liveOnly) || null");
    expect(src).toContain('const liveOnly = !!liveSummary && !cdn.length');
  });

  test('stub page is gated so a live summary renders the full page', () => {
    expect(src).toContain('if (!reports.length && !configs.length && !liveSummary)');
  });

  test('header count uses MAX(mirror, live total) so ProtonDB totals show through (#219)', () => {
    // #219: even when we have some mirror reports, use the live total when
    // ProtonDB says there are more (Hollow Knight etc).
    expect(src).toContain('const protonDbCount = Math.max(cdn.length, liveTotal)');
    expect(src).toContain('const liveTotal = liveSummary ? (liveSummary.total || 0) : 0');
    expect(src).toContain('const totalReports = nativeReports.length + protonDbCount');
  });

  test('tier falls back to live summary when mirror is empty (#219)', () => {
    // liveOnly branch returns the live tier verbatim; the else branch prefers
    // tierFromReports but falls back to the live summary tier if empty.
    expect(src).toContain("liveOnly");
    expect(src).toContain("String(liveSummary.tier || '').toLowerCase()");
    expect(src).toContain("(tierFromReports(cdn) || String(liveSummary?.tier || '').toLowerCase())");
  });

  test('ProtonDB live summary is auto-fetched in the parallel Promise.all (#219)', () => {
    // #219: the live summary must load automatically on every page render
    // so aggregate stats reflect ProtonDB reality, not just what we mirror.
    expect(src).toContain("safeFetch(() => fetchProtonDbLive(appId), 'fetchProtonDbLive', [])");
  });

  test('live-only shows an explanatory note in the cards area, not fake cards', () => {
    // The .live-summary-note block still exists to explain why there are no
    // report cards below when the mirror is empty.
    expect(src).toContain('class="live-summary-note"');
    expect(src).toContain('checked live');
  });

  test('report_moderation fetch does not double the /rest/v1 prefix', () => {
    // SB_URL already includes /rest/v1; the fetch must not add it again
    expect(src).toContain('`${SB_URL}/report_moderation?app_id=');
    expect(src).not.toContain('${SB_URL}/rest/v1/report_moderation');
  });

  test('stub submit link uses the ?app= param submit.html expects', () => {
    expect(src).toContain('href="submit.html?app=${esc(String(appId))}');
    expect(src).not.toContain('submit.html?appId=');
  });
});

describe('game page: rating panel (dial + per-tier bars + flag)', () => {
  test('renders a confidence gauge dial driven by the overall confidence %', () => {
    expect(src).toContain('const _dialPct = hasAnyReports ? Math.max(0, Math.min(100, Math.round(overallConfidencePct || 0))) : 0');
    expect(src).toContain('const _dialOffset = _DIAL_C * (1 - _dialPct / 100)');
    expect(src).toContain('class="grp-dial"');
    expect(src).toContain('class="grp-dial-pct"');
  });

  test('per-tier bars are built from the real rating counts, scaled to the busiest tier', () => {
    expect(src).toContain("const TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked']");
    expect(src).toContain('const maxTierCount = Math.max(1, ...TIER_ORDER.map((t) => ratingCounts[t]))');
    expect(src).toContain('const pct = Math.round((n / maxTierCount) * 100)');
    expect(src).toContain('class="grp-bar-fill"');
    expect(src).toContain('background:${RATING_COLORS[t]}');
  });

  test('live-only games still show the 5-bar breakdown, with a ProtonDB rating + count note above', () => {
    // ProtonDB's summary API has no per-tier counts, so the bars will read
    // 0/0/0/0/0 for a live-only game. We prepend a one-line note telling
    // users the aggregate rating + count so the section still communicates
    // something (#219 follow-up).
    expect(src).toContain('class="grp-bars"');
    expect(src).toContain('grp-bars-note--live');
    expect(src).toContain('ProtonDB rating:');
  });

  test('confidence summary links to the scoring breakdown via a "why?" link', () => {
    expect(src).toContain('class="grp-why conf-link"');
    expect(src).toContain('href="confidence.html?app=${appId}&tier=${overallTier}"');
    expect(src).toContain('>why?</a>');
  });

  test('flag button opens the Game Report template prefilled with title, appId, and starter body', () => {
    expect(src).toContain('const _flagStarter =');
    expect(src).toContain('issues/new?template=game_report.yml');
    expect(src).toContain('game_name=${encodeURIComponent(title)}');
    expect(src).toContain('app_id=${encodeURIComponent(String(appId))}');
    expect(src).toContain('description=${encodeURIComponent(_flagStarter)}');
    expect(src).toContain('id="flag-game-btn"');
    expect(src).toContain('class="info-btn info-btn-flag"');
  });

  test('box art is preserved in the header grid', () => {
    expect(src).toContain('class="game-header-art"');
    expect(src).toContain('src="${STEAM_IMG(appId)}"');
  });

  test('ProtonDB rating + count note renders above the 5-bar stack when live data exists (#219)', () => {
    // Kept the classic 5-bar breakdown even when mirror sample is empty; just
    // prepend a one-line "ProtonDB rating: PLATINUM * 371 reports" note so
    // users see the aggregate alongside the (possibly empty) bars.
    expect(src).toContain("grp-bars-note--live");
    expect(src).toContain("ProtonDB rating:");
    expect(src).toContain("liveTotal.toLocaleString()");
  });

  test('summary tags source when count is driven by ProtonDB live (#219)', () => {
    // Users need to see whether "N reports" came from mirror or live so the
    // aggregate makes sense even when the tier bars look tiny.
    expect(src).toContain("_fromLive");
    expect(src).toContain("(via ProtonDB live)");
  });

  test('confidence summary buckets off the percent, not the report count (#187)', () => {
    // Single source of truth: the dial %, the summary label, and confidence.html
    // must agree. Bucket thresholds match confidence.html (>=80 high, >=50 moderate).
    expect(src).toContain("overallConfidencePct >= 80 ? 'high' : overallConfidencePct >= 50 ? 'moderate' : 'low'");
    // The old report-count bucket is gone.
    expect(src).not.toContain("totalReports >= 20 ? 'high' : totalReports >= 5 ? 'medium'");
  });
});
