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
