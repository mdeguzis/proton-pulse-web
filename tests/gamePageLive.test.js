const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8'
);

describe('game page: ProtonDB live-only handling', () => {
  test('live summary is not merged into the rendered report list', () => {
    // reports[] must not spread liveCached (that produced the broken stub card)
    expect(src).not.toMatch(/\.\.\.liveCached\.map/);
    expect(src).toContain('const liveSummary = liveCached.find(r => r._liveOnly) || null');
    expect(src).toContain('const liveOnly = !!liveSummary && !cdn.length');
  });

  test('stub page is gated so a live summary renders the full page', () => {
    expect(src).toContain('if (!reports.length && !configs.length && !liveSummary)');
  });

  test('header tier and count come from the live summary when mirror is empty', () => {
    expect(src).toContain('const protonDbCount = cdn.length || (liveSummary ? (liveSummary.total || 0) : 0)');
    expect(src).toContain("const protonDbTier = liveOnly ? String(liveSummary.tier || '').toLowerCase() : tierFromReports(cdn)");
    expect(src).toContain('const totalReports = nativeReports.length + protonDbCount');
  });

  test('live-only shows an explanatory note instead of fake cards', () => {
    expect(src).toContain('class="live-summary-note"');
    expect(src).toContain('Per-tier breakdown is not available from ProtonDB');
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
