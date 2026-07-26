/**
 * #405: the reporter's overall verdict ("would you recommend this to
 * others?") must be visible on the report card face, and the Delete button
 * must NOT be on the game page (report deletion lives on the profile page
 * only).
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CARD_SRC = read('js/app/components/report-card.js');
const GAME_PAGE_SRC = read('js/app/components/game-page.js');
const CSS_SRC = read('css/app/reports.css');

function loadCard() {
  return loadEsm(['js/app/components/report-card.js'], {
    console: { log() {}, debug() {}, warn() {}, error() {} },
  });
}

describe('renderRecommendLine (#405)', () => {
  test('verdict yes renders the green "Would recommend" line', () => {
    const mod = loadCard();
    const html = mod.renderRecommendLine({ formResponses: { verdict: 'yes' } });
    expect(html).toContain('rec-verdict--yes');
    expect(html).toContain('Would recommend');
    expect(html).toContain('<svg');
  });

  test('verdict no renders the red "Would not recommend" line with a flipped thumb', () => {
    const mod = loadCard();
    const html = mod.renderRecommendLine({ formResponses: { verdict: 'no' } });
    expect(html).toContain('rec-verdict--no');
    expect(html).toContain('Would not recommend');
    expect(html).toContain('scaleY(-1)');
  });

  test('no verdict (ProtonDB mirror rows, old reports) renders nothing at all', () => {
    const mod = loadCard();
    expect(mod.renderRecommendLine({})).toBe('');
    expect(mod.renderRecommendLine({ formResponses: null })).toBe('');
    expect(mod.renderRecommendLine({ formResponses: {} })).toBe('');
    // Unknown values must not render a misleading badge either.
    expect(mod.renderRecommendLine({ formResponses: { verdict: 'maybe' } })).toBe('');
  });

  test('the card body includes the verdict line before the signal strip', () => {
    const idx = CARD_SRC.indexOf('${renderRecommendLine(r)}');
    const strip = CARD_SRC.indexOf('${renderSignalStrip(r)}');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(strip);
  });

  test('rec-verdict styles exist for both outcomes', () => {
    expect(CSS_SRC).toContain('.card .rec-verdict--yes');
    expect(CSS_SRC).toContain('.card .rec-verdict--no');
  });
});

describe('report delete lives on the profile page only (#405)', () => {
  test('report card renders no delete button', () => {
    expect(CARD_SRC).not.toContain('delete-report-btn');
  });

  test('game page has no delete-report handlers left behind', () => {
    expect(GAME_PAGE_SRC).not.toContain('delete-report-btn');
    expect(GAME_PAGE_SRC).not.toContain('Delete your report');
  });

  test('profile page still owns report deletion', () => {
    const PROFILE_API = read('js/profile/api/configs.js');
    expect(PROFILE_API).toContain('user_configs');
    expect(PROFILE_API).toMatch(/method:\s*'DELETE'/);
  });
});
