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
});
