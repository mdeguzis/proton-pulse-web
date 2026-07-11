/**
 * Steam Deck status now comes from the pipeline-published deck-status.json
 * (task #37), not a live browser fetch to Valve's endpoint (which is CORS-
 * blocked and always failed -> everything read "Unknown ?").
 */
const fs = require('fs');
const path = require('path');

const API = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'api', 'deck-status.js'),
  'utf8',
);
const COMP = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'deck-status.js'),
  'utf8',
);

describe('deck status: reads published deck-status.json', () => {
  test('api loads the pipeline file via dataUrl, cached once', () => {
    expect(API).toContain("dataUrl('deck-status.json')");
    expect(API).toContain('function _loadDeckMap()');
  });

  test('api no longer does the CORS-blocked live fetch to Valve', () => {
    // the endpoint name may appear in a comment; what must be gone is the
    // live per-app browser fetch to it.
    expect(API).not.toContain('ajaxgetdeckappcompatibilityreport?nAppID=');
  });

  test('category + display_type maps stay in sync with the pipeline', () => {
    expect(API).toContain("0: 'unknown', 1: 'unsupported', 2: 'playable', 3: 'verified'");
    expect(API).toContain('4: true, 3: null, 2: false');
  });

  test('modal drops the sample-data / task #37 placeholder note', () => {
    expect(COMP).not.toContain('Sample data shown');
    expect(COMP).not.toContain('task #37');
    // unknown now means Valve simply has not evaluated the title
    expect(COMP).toContain('Valve has not evaluated this title yet');
  });

  test('modal is a three-tab Deck / Machine / SteamOS layout (#273)', () => {
    // Radio-driven CSS tabs so it needs no JS wiring.
    expect(COMP).toContain('class="deck-tabs"');
    expect(COMP).toContain('id="dt-deck"');
    expect(COMP).toContain('id="dt-machine"');
    expect(COMP).toContain('id="dt-steamos"');
    expect(COMP).toContain("'icon-steam-machine'");
    expect(COMP).toContain("'icon-steamos'");
    // SteamOS reads its own status field, not the Deck status.
    expect(COMP).toContain('d.machine');
    expect(COMP).toContain('d.steamos');
    expect(COMP).toContain('Compatible');
  });

  test('api exposes machine_criteria + steamos_criteria arrays alongside the verdicts', () => {
    // Frontend renders a per-criterion checklist for all three tabs, matching
    // Valve's own compatibility modal (#273 follow-up). Missing / undefined
    // input defaults to [] so an empty checklist reads as "no notes" rather
    // than "unknown" (see also the fetchDeckStatusForApp normalisation).
    expect(API).toContain('entry.machine_criteria');
    expect(API).toContain('entry.steamos_criteria');
    expect(API).toContain('Array.isArray(entry.machine_criteria) ? entry.machine_criteria : []');
    expect(API).toContain('Array.isArray(entry.steamos_criteria) ? entry.steamos_criteria : []');
  });

  test('Machine + SteamOS panels render a per-criterion checklist from tokens (#273 follow-up)', () => {
    // Previously only the Deck tab showed the four-point criteria list.
    // Now Machine and SteamOS ship their own resolved_items arrays with
    // arbitrary count + tokenized labels, so the panels drop the "Source:
    // Valve's report" placeholder in favour of the same checklist UI.
    expect(COMP).toContain('CRITERIA_TOKEN_LABELS');
    expect(COMP).toContain('_tokenToProse');
    expect(COMP).toContain('_criterionLabel');
    expect(COMP).toContain('_iconKeyForDisplayType');
    // The renderer walks the [[display_type, short_token], ...] shape.
    expect(COMP).toMatch(/tokenizedCriteria\.map\(\(\[dt, tok\]\)/);
    // Machine + SteamOS pass their arrays through in the modal wiring.
    expect(COMP).toContain('d.machine_criteria');
    expect(COMP).toContain('d.steamos_criteria');
  });

  test('_tokenToProse converts CamelCase tokens to human prose', () => {
    // Load the module in an isolated VM so we can call the exported helper
    // without pulling in the whole app-page render tree.
    const { loadEsm } = require('./_esm-vm.js');
    const mod = loadEsm(['js/app/components/deck-status.js'], { Math, Object, Array, JSON, console });
    expect(mod._tokenToProse('DefaultControllerConfigNotFullyFunctional'))
      .toBe('Default controller config not fully functional');
    expect(mod._tokenToProse('GameStartupFunctional')).toBe('Game startup functional');
    expect(mod._tokenToProse('')).toBe('');
    expect(mod._tokenToProse(null)).toBe('');
  });

  test('_criterionLabel prefers curated labels but falls back to prose', () => {
    const { loadEsm } = require('./_esm-vm.js');
    const mod = loadEsm(['js/app/components/deck-status.js'], { Math, Object, Array, JSON, console });
    // Known token: uses the friendly hand-written label from CRITERIA_TOKEN_LABELS.
    expect(mod._criterionLabel('GameStartupFunctional')).toBe('This game runs successfully on SteamOS');
    // Unknown token: falls back to camelCase-to-prose.
    expect(mod._criterionLabel('SomeBrandNewValveToken')).toBe('Some brand new valve token');
  });

  // Icon comes from the token, not display_type, because Valve's display_type
  // is inconsistent across the three reports (see _iconKeyForCriterion). This
  // pins the SteamOS TF2 case (app 440) to Valve's store modal.
  test('_iconKeyForCriterion maps SteamOS criteria to the icons Valve shows', () => {
    const { loadEsm } = require('./_esm-vm.js');
    const mod = loadEsm(['js/app/components/deck-status.js'], { Math, Object, Array, JSON, console });
    // display_type=3 here but Valve shows a green check (pass).
    expect(mod._iconKeyForCriterion(3, 'GameStartupFunctional')).toBe('verified');
    // display_type=1 caveats -> info "i", NOT red-x (the old dt-only bug).
    expect(mod._iconKeyForCriterion(1, 'DefaultControllerConfigNotFullyFunctional')).toBe('playable');
    expect(mod._iconKeyForCriterion(1, 'ExternalControllersNotSupportedPrimaryPlayer')).toBe('playable');
  });

  test('_iconKeyForCriterion keeps Machine passes/caveats correct', () => {
    const { loadEsm } = require('./_esm-vm.js');
    const mod = loadEsm(['js/app/components/deck-status.js'], { Math, Object, Array, JSON, console });
    expect(mod._iconKeyForCriterion(4, 'DefaultConfigurationIsPerformant')).toBe('verified');
    expect(mod._iconKeyForCriterion(3, 'ControllerGlyphsDoNotMatchDevice')).toBe('playable');
  });

  test('_iconKeyForCriterion infers unknown tokens by name, then display_type', () => {
    const { loadEsm } = require('./_esm-vm.js');
    const mod = loadEsm(['js/app/components/deck-status.js'], { Math, Object, Array, JSON, console });
    // hard failure token
    expect(mod._iconKeyForCriterion(2, 'GameStartupNotFunctional')).toBe('unsupported');
    // unknown caveat token by name
    expect(mod._iconKeyForCriterion(3, 'SomethingIsNotGreat')).toBe('playable');
    // unknown positive token by name
    expect(mod._iconKeyForCriterion(4, 'BrandNewPositiveThing')).toBe('verified');
  });
});
