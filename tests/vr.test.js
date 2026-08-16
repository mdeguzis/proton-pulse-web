/**
 * VR vocabulary + capability filtering (#246).
 *
 * Three separate concerns that are easy to conflate, so each is pinned here:
 *   play_mode        how the reporter played  ('flat' | 'vr')
 *   vr_runtime       which OpenXR runtime     ('steamvr' | 'wivrn' | ...)
 *   search_index.vr  what the GAME supports   (null | 'supported' | 'only')
 */

const {
  PLAY_MODES, PLAY_MODE_KEYS, VR_RUNTIMES, VR_RUNTIME_KEYS, VR_HEADSETS, VR_SUPPORT,
  VRDB_RATINGS, normalizePlayMode, normalizeVrRuntime, playModeLabel, vrRuntimeLabel,
  vrdbRatingColor,
} = require('../js/shared/vr.js');

const { vrForApp, matchesVrFilter } = require('../js/app/lib/vr-index.js');

describe('canonical vocabulary', () => {
  test('play modes are flat + vr with labels', () => {
    expect(PLAY_MODE_KEYS).toEqual(['flat', 'vr']);
    for (const k of PLAY_MODE_KEYS) {
      expect(PLAY_MODES[k].label).toBeTruthy();
      expect(PLAY_MODES[k].subtitle).toBeTruthy();
    }
  });

  test('every play mode key satisfies the DB CHECK vocabulary', () => {
    // user_configs_play_mode_chk: play_mode in ('flat', 'vr')
    for (const k of PLAY_MODE_KEYS) expect(['flat', 'vr']).toContain(k);
  });

  test('every VR runtime key satisfies the DB CHECK regex', () => {
    // user_configs_vr_runtime_chk: ^[a-z0-9]+(-[a-z0-9]+)*$ and <= 32 chars
    for (const k of VR_RUNTIME_KEYS) {
      expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(k.length).toBeLessThanOrEqual(32);
      expect(VR_RUNTIMES[k].label).toBeTruthy();
    }
  });

  test('other is offered last so a new runtime is never a blocker', () => {
    expect(VR_RUNTIME_KEYS[VR_RUNTIME_KEYS.length - 1]).toBe('other');
  });

  test('headsets fit the DB length cap', () => {
    expect(VR_HEADSETS.length).toBeGreaterThan(5);
    for (const h of VR_HEADSETS) expect(h.length).toBeLessThanOrEqual(64);
  });

  test('game capability vocabulary matches the search_index CHECK', () => {
    expect(Object.keys(VR_SUPPORT).sort()).toEqual(['only', 'supported']);
  });

  test('VRDB ratings mirror the upstream 1-5 table', () => {
    expect(Object.keys(VRDB_RATINGS)).toHaveLength(5);
    expect(VRDB_RATINGS[1]).toBe('Perfect');
    expect(VRDB_RATINGS[5]).toBe("Crashes or won't start");
  });
});

describe('normalizePlayMode', () => {
  test('passes canonical values through', () => {
    expect(normalizePlayMode('flat')).toBe('flat');
    expect(normalizePlayMode('vr')).toBe('vr');
  });

  test('accepts the spellings a plugin or user might send', () => {
    expect(normalizePlayMode('VR')).toBe('vr');
    expect(normalizePlayMode('Virtual Reality')).toBe('vr');
    expect(normalizePlayMode('headset')).toBe('vr');
    expect(normalizePlayMode('Flatscreen')).toBe('flat');
    expect(normalizePlayMode('flat screen')).toBe('flat');
    expect(normalizePlayMode('2D')).toBe('flat');
    expect(normalizePlayMode('pancake')).toBe('flat');
  });

  test('returns null for unknown / empty input rather than guessing flat', () => {
    // Legacy rows predate the field. Backfilling them as flat would mislabel
    // any VR report submitted before this shipped.
    expect(normalizePlayMode(null)).toBeNull();
    expect(normalizePlayMode('')).toBeNull();
    expect(normalizePlayMode('   ')).toBeNull();
    expect(normalizePlayMode('whatever')).toBeNull();
  });
});

describe('normalizeVrRuntime', () => {
  test('passes canonical values through', () => {
    for (const k of VR_RUNTIME_KEYS) expect(normalizeVrRuntime(k)).toBe(k);
  });

  test('normalizes the common spellings', () => {
    expect(normalizeVrRuntime('SteamVR')).toBe('steamvr');
    expect(normalizeVrRuntime('Steam VR')).toBe('steamvr');
    expect(normalizeVrRuntime('WiVRn')).toBe('wivrn');
    expect(normalizeVrRuntime('ALVR')).toBe('alvr');
    expect(normalizeVrRuntime('Monado')).toBe('monado');
  });

  test('lets an unregistered but clean runtime through', () => {
    expect(normalizeVrRuntime('openxr-next')).toBe('openxr-next');
  });

  test('rejects junk and empty input', () => {
    expect(normalizeVrRuntime(null)).toBeNull();
    expect(normalizeVrRuntime('')).toBeNull();
    expect(normalizeVrRuntime('not a runtime!')).toBeNull();
    expect(normalizeVrRuntime('x'.repeat(40))).toBeNull();
  });
});

describe('labels', () => {
  test('known keys get their label, unknown keys fall back to the key', () => {
    expect(playModeLabel('vr')).toBe('VR');
    expect(playModeLabel(null)).toBe('Unknown');
    expect(vrRuntimeLabel('wivrn')).toBe('WiVRn');
    expect(vrRuntimeLabel('openxr-next')).toBe('openxr-next');
    expect(vrRuntimeLabel(null)).toBe('Unknown');
  });

  test('rating colours run best to worst and are distinct', () => {
    const colors = [1, 2, 3, 4, 5].map(vrdbRatingColor);
    expect(new Set(colors).size).toBe(5);
    expect(vrdbRatingColor(0)).toBe('var(--muted)');
    expect(vrdbRatingColor(99)).toBe('var(--muted)');
  });
});

describe('vrForApp', () => {
  const map = { 620980: 'only', 275850: 'supported', 730: 'nonsense' };

  test('reads a capability by id, coercing to string', () => {
    expect(vrForApp(map, 620980)).toBe('only');
    expect(vrForApp(map, '275850')).toBe('supported');
  });

  test('unknown ids and junk values return null', () => {
    expect(vrForApp(map, 999999)).toBeNull();
    expect(vrForApp(map, 730)).toBeNull();
    expect(vrForApp(map, null)).toBeNull();
    expect(vrForApp(null, 620980)).toBeNull();
  });
});

describe('matchesVrFilter', () => {
  test('any lets everything through', () => {
    for (const vr of ['only', 'supported', null]) {
      expect(matchesVrFilter(vr, 'any')).toBe(true);
    }
  });

  test('vr keeps both VR flavours and drops non-VR', () => {
    expect(matchesVrFilter('only', 'vr')).toBe(true);
    expect(matchesVrFilter('supported', 'vr')).toBe(true);
    expect(matchesVrFilter(null, 'vr')).toBe(false);
  });

  test('only keeps headset-required titles', () => {
    expect(matchesVrFilter('only', 'only')).toBe(true);
    expect(matchesVrFilter('supported', 'only')).toBe(false);
    expect(matchesVrFilter(null, 'only')).toBe(false);
  });

  test('flat hides VR-only and keeps everything monitor-playable', () => {
    // The point of this filter: a flatscreen player wants VR-only OUT, but
    // still wants games that merely support VR.
    expect(matchesVrFilter('only', 'flat')).toBe(false);
    expect(matchesVrFilter('supported', 'flat')).toBe(true);
    expect(matchesVrFilter(null, 'flat')).toBe(true);
  });

  test('an unrecognized filter degrades to no filtering', () => {
    expect(matchesVrFilter('only', 'bogus')).toBe(true);
  });
});

describe('game page artwork badges (#246)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'), 'utf8');
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'css', 'app', 'game-header.css'), 'utf8');

  test('the overlay lives inside a positioned wrapper on the artwork', () => {
    expect(src).toContain('game-header-art-wrap');
    expect(src).toContain('id="game-art-badges"');
    expect(css).toMatch(/\.game-header-art-wrap\s*\{[^}]*position:\s*relative/);
  });

  test('badges pin top-right and are not driven by the store-pill preference', () => {
    const block = css.match(/\.game-header-art-badges\s*\{[^}]*\}/)[0];
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).toMatch(/top:\s*8px/);
    expect(block).toMatch(/right:\s*8px/);
    // The pref moves the store pill around browse cards; the detail page keeps
    // one predictable corner. Strip comments before checking -- the comment
    // above the rule names the attribute precisely to say it is NOT used, and
    // a raw scan matches that prose instead of a real selector.
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = noComments.match(/[^{}]+(?=\{)/g) || [];
    const badgeRules = rules.filter((sel) => sel.includes('.game-header-art-badges'));
    expect(badgeRules.length).toBeGreaterThan(0);
    expect(badgeRules.some((sel) => sel.includes('data-store-pill-pos'))).toBe(false);
  });

  test('the overlay carries ownership only, not VR', () => {
    // VR lives in the tag row under the artwork (and the banner when it is
    // VR-only). A chip on the art as well was the same fact twice, competing
    // with the box art.
    const overlay = src.slice(src.indexOf("querySelector('#game-art-badges')"), src.indexOf('parts.length'));
    expect(overlay).not.toContain('game-card-vr-chip');
    expect(src).toContain('game-card-owner-badge game-card-owner-badge--library');
    expect(src).toContain('game-card-owner-badge game-card-owner-badge--wishlist');
  });

  test('the library badge tooltip reads In Library', () => {
    expect(src).toContain('title="In Library" aria-label="In Library"');
  });

  test('VR renders for signed-out visitors; owner badges do not', () => {
    // VR capability is a property of the game, not the viewer. Gating it
    // behind a session would hide it from most visitors.
    // VR is resolved before the artwork host is even looked up, and well
    // before any session check, so a signed-out visitor still gets it.
    const block = src.slice(src.indexOf('const vr = vrForApp('));
    const sessionIdx = block.indexOf('SupaAuth?.getSession');
    const stripIdx = block.indexOf("game-vr-strip'");
    expect(stripIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(stripIdx);
  });

  test('the VR chip is sized to the 18px icon box, not the delisted chip em', () => {
    const cards = fs.readFileSync(
      path.join(__dirname, '..', 'css', 'shared', 'cards.css'), 'utf8');
    const chip = cards.match(/\.game-card-vr-chip\s*\{[^}]*\}/)[0];
    // 0.62em resolved against the store pill's 0.7rem rendered at ~0.43rem,
    // which read as a footnote next to the 18px icons beside it.
    expect(chip).not.toMatch(/font-size:\s*0\.62em/);
    expect(chip).toMatch(/line-height:\s*18px/);
  });
});

describe('VR chip is one variant, VR-only is a banner (#246 follow-up)', () => {
  const fs = require('fs');
  const path = require('path');
  const cardSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'lib', 'card.js'), 'utf8');
  const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'), 'utf8');
  const cardsCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'shared', 'cards.css'), 'utf8');

  test('cards render a single VR label, never VR Only', () => {
    // One badge fits a card, and "VR ONLY" doubled the strip width at the S
    // size. The requirement is stated on the detail page instead.
    expect(cardSrc).not.toContain('VR Only<');
    expect(cardSrc).toMatch(/>VR<\/span>/);
  });

  test('the only/supported distinction survives in the tooltip and the data', () => {
    // Dropping the second chip must not drop the information: the filter and
    // the banner both still depend on vr === 'only'.
    expect(cardSrc).toContain("vrKey === 'only' ? 'VR only: requires a headset'");
    expect(cardSrc).toContain("vr === 'only' || vr === 'supported'");
  });

  test('no VR chip colour variants remain in CSS', () => {
    expect(cardsCss).not.toContain('.game-card-vr-chip--only');
    expect(cardsCss).not.toContain('.game-card-vr-chip--supported');
  });

  test('the chip is amber so it does not merge with the store pill', () => {
    // Every store colour is blue/purple/grey: Steam #1689d0, GOG #7a3fcf,
    // PCGWiki #4d5f9c, Epic #555. The first version was a muted blue against
    // the Steam pill.
    const chip = cardsCss.match(/\.game-card-vr-chip\s*\{[^}]*\}/)[0];
    expect(chip).toMatch(/#e8a33d/i);
  });

  test('the game page carries a VR-only banner element', () => {
    expect(pageSrc).toContain('id="game-vr-banner"');
    expect(pageSrc).toContain('This game is VR only.');
    // Hidden by default so a non-VR game never renders an empty banner.
    expect(pageSrc).toMatch(/id="game-vr-banner" hidden/);
  });

  test('the banner only fires for VR-only games', () => {
    const block = pageSrc.slice(pageSrc.indexOf("const vr = vrForApp("));
    const onlyIdx = block.indexOf('if (only) {');
    const bannerIdx = block.indexOf("#game-vr-banner");
    expect(onlyIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeGreaterThan(onlyIdx);
  });
});

describe('VR chip caps the badge strip (#246 follow-up)', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'shared', 'cards.css'), 'utf8');
  const chip = css.match(/\.game-card-vr-chip\s*\{[^}]*\}/)[0];

  test('the chip carries no radius of its own', () => {
    // The container's radius caps the strip. A chip with its own corners sat
    // as a square block inside a curved badge and the leading end looked
    // uncapped where the badge curved away from it.
    expect(chip).toMatch(/border-radius:\s*0/);
  });

  test('badge containers clip their contents', () => {
    // Without overflow:hidden the bled chip escapes the rounded corner.
    for (const sel of ['.game-card-store-tag', '.game-card-store-pill',
                       '.game-card-corner-tag', '.game-card-strip-store']) {
      const re = new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*overflow:\\s*hidden`);
      expect(css).toMatch(re);
    }
  });

  test('every container that clips also declares its bleed', () => {
    // The chip bleeds out through the container padding by negative margin;
    // each variant has different padding, so a container that clips without
    // declaring --badge-pad-* leaves a gap at the leading edge.
    for (const sel of ['.game-card-store-tag', '.game-card-store-pill', '.game-card-corner-tag']) {
      const re = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*--badge-pad-x`);
      expect(css).toMatch(re);
    }
  });

  test('only the leading chip bleeds', () => {
    // A Delisted chip renders before VR; when present it owns the leading
    // edge, so VR must not pull itself out of the container there.
    expect(css).toMatch(/\.game-card-vr-chip:first-child\s*\{/);
  });

  test('the combo layout still renders the chip', () => {
    // combo hides store-tag / corner-tag / store-pill, so a chip that only
    // lived in those would vanish entirely in that layout.
    const cardSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'lib', 'card.js'), 'utf8');
    const combo = cardSrc.match(/game-card-combo-tag[\s\S]{0,400}/)[0];
    expect(combo).toContain('${vrChip}');
  });
});

describe('VR in the game-page tag row (#246 follow-up)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'app', 'game-header.css'), 'utf8');

  test('VR gets its own strip, not folded into the OS chips', () => {
    // .game-os-strip is aria-label="Supported operating systems"; VR is a
    // capability, not an OS, so folding it in makes that label wrong.
    expect(src).toContain('id="game-vr-strip"');
    expect(src).toContain('aria-label="VR support"');
    const osStrip = src.slice(src.indexOf('game-os-strip'), src.indexOf('game-vr-strip'));
    expect(osStrip).not.toContain('game-tag--vr');
  });

  test('the strip stays hidden for non-VR games', () => {
    expect(src).toMatch(/id="game-vr-strip" hidden/);
    expect(css).toContain('.game-vr-strip[hidden] { display: none; }');
  });

  test('it reuses the OS chip shape AND colour so the row reads as one thing', () => {
    // Deliberately NOT the card's amber: on a card the chip fights a store
    // pill, but this row answers a single question and three colours made it
    // look like three unrelated facts.
    expect(src).toContain('game-tag game-tag--vr');
    const rule = css.match(/\.game-tag\.game-tag--vr\s*\{[^}]*\}/)[0];
    expect(rule).toContain('--accent');
    const osRule = css.match(/\.game-os-chip--on\s*\{[^}]*\}/)[0];
    expect(osRule).toContain('--accent');
  });

  test('the tag-row chip always reads VR, never VR Only', () => {
    // Same call as the cards: "VR" means the game has VR. The headset
    // requirement is the banner's job, not a second label in a row of
    // platform chips.
    const block = src.slice(src.indexOf("game-vr-strip'"), src.indexOf('#game-vr-banner'));
    expect(block).toContain('<span>VR</span>');
    expect(block).not.toContain('VR Only');
    expect(css).not.toContain('.game-tag--vr[data-vr="only"]');
  });

  test('the tag-row chip is not gated on the artwork overlay', () => {
    // These shared an `if (!host) return` guard, so a missing
    // #game-art-badges silently took the tag-row chip down with it.
    const stripIdx = src.indexOf("game-vr-strip'");
    const guardIdx = src.indexOf("const host = el.querySelector('#game-art-badges')");
    expect(stripIdx).toBeGreaterThan(-1);
    expect(stripIdx).toBeLessThan(guardIdx);
  });

  test('the VRDB source deep-links to the game, not the site root', () => {
    expect(src).toContain('db.vronlinux.org/games/');
    expect(src).not.toMatch(/href="https:\/\/db\.vronlinux\.org\/"/);
  });
});

describe('VR on Linux as a compatibility tab (#246 follow-up)', () => {
  const fs = require('fs');
  const path = require('path');
  const deck = fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'components', 'deck-status.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'app', 'game-header.css'), 'utf8');

  test('the button says Compatibility, not Steam Deck', () => {
    // The modal covers four surfaces; naming it after one tab undersells the
    // rest and hides where the VR data lives.
    expect(deck).toContain('<span>Compatibility</span>');
    expect(deck).not.toContain('<span>Steam Deck</span>');
  });

  test('a fourth radio + panel exist for VR', () => {
    expect(deck).toContain('id="dt-vr"');
    expect(deck).toContain('dt-panel-vr');
    expect(css).toContain('#dt-vr:checked      ~ .dt-panel-vr { display: block; }');
  });

  test('the VR tab starts hidden so non-VR games keep three tabs', () => {
    expect(deck).toMatch(/id="dt-vr-tab" hidden/);
    // .dt-tab sets display:inline-flex, so [hidden] needs an explicit rule.
    expect(css).toContain('.dt-tab--vr[hidden] { display: none; }');
  });

  test('fillVrOnLinuxTab reveals the tab only when there are runtime reports', () => {
    const fn = deck.slice(deck.indexOf('export function fillVrOnLinuxTab'));
    expect(fn).toContain('if (!rows.length) return;');
    expect(fn.indexOf('tab.hidden = false')).toBeGreaterThan(fn.indexOf('if (!rows.length) return;'));
  });

  test('the panel is filled async so the modal opens without waiting on vrdb.json', () => {
    // renderDeckStatusModalContent is synchronous by design (renders off the
    // in-memory deck cache); VRDB is a separate fetch.
    expect(deck).toContain('export function fillVrOnLinuxTab');
    expect(page).toContain('fillVrOnLinuxTab(');
  });

  test('both modal render paths refill the tab', () => {
    // The deck fetch re-renders the modal body, which would wipe the tab.
    const calls = page.match(/fillVrOnLinuxTab\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test('the tab keeps the VRDB attribution and deep link', () => {
    const fn = deck.slice(deck.indexOf('export function fillVrOnLinuxTab'));
    expect(fn).toContain('db.vronlinux.org/games/');
    expect(fn).toContain('(MIT)');
    expect(fn).toMatch(/never mixed into our scoring|opposite way to a Pulse tier/);
  });
});

describe('tag row shows only what applies (#246 follow-up)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'app', 'game-header.css'), 'utf8');

  test('unsupported OS chips are hidden, not greyed out', () => {
    // A row of greyed chips for every OS the game does not support is noise;
    // the reader wants to know where it runs.
    expect(src).toContain('chip.hidden = !on;');
  });

  test('[hidden] actually hides a .game-tag', () => {
    // .game-tag sets display:inline-flex, which defeats the hidden attribute.
    expect(css).toContain('.game-tag[hidden] { display: none; }');
  });

  test('the VR chip beats .game-tag on specificity', () => {
    // A bare .game-tag--vr ties with .game-tag and lost to its
    // color: var(--muted), rendering the chip grey and indistinguishable
    // from an unsupported platform.
    expect(css).toContain('.game-tag.game-tag--vr');
    expect(css).not.toMatch(/^\.game-tag--vr\s*\{/m);
    const rule = css.match(/\.game-tag\.game-tag--vr\s*\{[^}]*\}/)[0];
    expect(rule).toContain('opacity: 1');
    expect(rule).toContain('--accent');
  });

  test('the VR chip only renders when the game has VR', () => {
    // So it is always its lit state -- there is no dim VR variant.
    const block = src.slice(src.indexOf('const vr = vrForApp('));
    const stripIdx = block.indexOf("game-vr-strip'");
    expect(block.slice(0, stripIdx)).toContain('if (vr) {');
  });
});
