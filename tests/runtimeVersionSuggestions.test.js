/**
 * Runtime Version autocomplete ranking + filtering (js/shared/submit.js).
 *
 * Two bugs motivated these helpers. Picking "Proton GE" still suggested
 * Valve's Proton builds because the list was never filtered by runtime type.
 * And the suggestion list was insertion-ordered, so the fetched-later live
 * releases sat past the top-10 slice while the hardcoded fallback
 * (GE-Proton9-27) sat at the top long after GE-Proton11 shipped.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { RUN_TYPES } = require('../js/shared/run-type.js');

// submit.js is a browser ES module with side-effectful imports; pull just the
// pure helpers out the same way the other submit tests do.
function loadHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js/shared/submit.js'), 'utf8');
  const start = src.indexOf('export const VERSION_RANK');
  const end = src.indexOf('// lightweight sysinfo parser');
  const slice = src.slice(start, end).replace(/^export\s+(function|const)\s/gm, '$1 ');
  const sandbox = { RUN_TYPES, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(
    slice + '\nmodule.exports = { VERSION_RANK, protonTagToLabel, mergeVersionEntries, suggestionsForRunType };',
    sandbox,
  );
  return sandbox.module.exports;
}

const { VERSION_RANK, protonTagToLabel, mergeVersionEntries, suggestionsForRunType } = loadHelpers();

describe('protonTagToLabel', () => {
  test('accepts a stable tag', () => {
    expect(protonTagToLabel('proton-10.0-4')).toBe('Proton 10.0-4');
  });

  test('accepts the trailing revision letter Valve ships as current stable', () => {
    // proton-11.0-1b was the live stable while the old regex dropped it.
    expect(protonTagToLabel('proton-11.0-1b')).toBe('Proton 11.0-1b');
  });

  test('rejects beta tags so the dropdown only offers pickable builds', () => {
    expect(protonTagToLabel('proton-11.0-1-beta5')).toBeNull();
    expect(protonTagToLabel('proton-11.0-1-beta1')).toBeNull();
  });

  test('rejects non-Proton tags and junk input', () => {
    expect(protonTagToLabel('GE-Proton11-5')).toBeNull();
    expect(protonTagToLabel('')).toBeNull();
    expect(protonTagToLabel(null)).toBeNull();
  });
});

describe('mergeVersionEntries', () => {
  test('adds values with the given rank, preserving order', () => {
    const out = mergeVersionEntries([], ['Proton 10.0-4', 'Proton 9.0-4'], VERSION_RANK.fallback);
    expect(out).toEqual([
      { value: 'Proton 10.0-4', rank: VERSION_RANK.fallback },
      { value: 'Proton 9.0-4', rank: VERSION_RANK.fallback },
    ]);
  });

  test('does not mutate the input list', () => {
    const before = [{ value: 'Proton 9.0-4', rank: VERSION_RANK.fallback }];
    mergeVersionEntries(before, ['GE-Proton11-5'], VERSION_RANK.live);
    expect(before).toHaveLength(1);
  });

  test('upgrades an existing entry to the better rank', () => {
    let out = mergeVersionEntries([], ['GE-Proton11-5'], VERSION_RANK.harvested);
    out = mergeVersionEntries(out, ['GE-Proton11-5'], VERSION_RANK.live);
    expect(out).toEqual([{ value: 'GE-Proton11-5', rank: VERSION_RANK.live }]);
  });

  test('keeps the better rank when a worse one arrives later', () => {
    let out = mergeVersionEntries([], ['GE-Proton11-5'], VERSION_RANK.live);
    out = mergeVersionEntries(out, ['GE-Proton11-5'], VERSION_RANK.harvested);
    expect(out[0].rank).toBe(VERSION_RANK.live);
  });

  test('dedupes case-insensitively', () => {
    const out = mergeVersionEntries([], ['GE-Proton11-5', 'ge-proton11-5'], VERSION_RANK.live);
    expect(out).toHaveLength(1);
  });

  test('collapses the Experimental spelling variants the pipeline emits', () => {
    const out = mergeVersionEntries([], ['Proton - Experimental', 'Proton-Experimental', 'Proton Experimental'], VERSION_RANK.harvested);
    expect(out).toEqual([{ value: 'Proton Experimental', rank: VERSION_RANK.harvested }]);
  });

  test('skips empty and nullish values', () => {
    const out = mergeVersionEntries([], ['', '   ', null, undefined, 'Proton 9.0-4'], VERSION_RANK.live);
    expect(out).toEqual([{ value: 'Proton 9.0-4', rank: VERSION_RANK.live }]);
  });

  test('tolerates a missing entries argument', () => {
    expect(mergeVersionEntries(null, ['Proton 9.0-4'], VERSION_RANK.live)).toHaveLength(1);
  });
});

describe('suggestionsForRunType', () => {
  // Mirrors the real shape: fallback seeded first, live releases merged later.
  const entries = [
    { value: 'Proton Experimental', rank: VERSION_RANK.fallback },
    { value: 'Proton 10.0-4', rank: VERSION_RANK.fallback },
    { value: 'Proton 9.0-4', rank: VERSION_RANK.fallback },
    { value: 'GE-Proton9-27', rank: VERSION_RANK.fallback },
    { value: 'Proton 99.0-1', rank: VERSION_RANK.harvested },
    { value: 'Proton-GE-Latest', rank: VERSION_RANK.harvested },
    { value: 'CachyOS Proton 11', rank: VERSION_RANK.harvested },
    { value: 'GE-Proton11-5', rank: VERSION_RANK.live },
    { value: 'GE-Proton11-4', rank: VERSION_RANK.live },
    { value: 'Proton 11.0-1b', rank: VERSION_RANK.live },
  ];

  test('proton-ge offers only GE builds', () => {
    const out = suggestionsForRunType(entries, 'proton-ge');
    expect(out.every(v => /ge[-_ ]?proton/i.test(v))).toBe(true);
    expect(out).not.toContain('Proton 10.0-4');
    expect(out).not.toContain('CachyOS Proton 11');
  });

  test('proton-ge leads with the current live release, not the stale fallback', () => {
    const out = suggestionsForRunType(entries, 'proton-ge');
    expect(out[0]).toBe('GE-Proton11-5');
    expect(out.indexOf('GE-Proton11-5')).toBeLessThan(out.indexOf('GE-Proton9-27'));
  });

  test('proton offers Valve builds and not GE ones', () => {
    const out = suggestionsForRunType(entries, 'proton');
    expect(out).toContain('Proton 11.0-1b');
    expect(out).not.toContain('GE-Proton11-5');
    expect(out).not.toContain('CachyOS Proton 11');
  });

  test('a harvested joke version sorts below the real releases', () => {
    const out = suggestionsForRunType(entries, 'proton');
    expect(out.indexOf('Proton 11.0-1b')).toBeLessThan(out.indexOf('Proton 99.0-1'));
  });

  test('proton-cachyos offers only CachyOS builds', () => {
    expect(suggestionsForRunType(entries, 'proton-cachyos')).toEqual(['CachyOS Proton 11']);
  });

  test('native has no runtime version to suggest', () => {
    expect(suggestionsForRunType(entries, 'native')).toEqual([]);
  });

  test('the typed query narrows within the runtime filter', () => {
    const out = suggestionsForRunType(entries, 'proton-ge', '11-4');
    expect(out).toEqual(['GE-Proton11-4']);
  });

  test('a query matching another runtime returns nothing rather than crossing over', () => {
    expect(suggestionsForRunType(entries, 'proton-ge', 'cachyos')).toEqual([]);
  });

  test('respects the limit', () => {
    expect(suggestionsForRunType(entries, 'proton', '', 2)).toHaveLength(2);
  });

  test('defaults to proton when no run type is given', () => {
    expect(suggestionsForRunType(entries, '')).toContain('Proton 11.0-1b');
  });

  test('an unknown runtime falls back to offering everything', () => {
    // Pipeline discovery can widen the taxonomy without a code change; an
    // empty dropdown would be worse than an unfiltered one.
    const out = suggestionsForRunType(entries, 'proton-somethingnew');
    expect(out.length).toBeGreaterThan(0);
  });

  test('empty entries yield no suggestions', () => {
    expect(suggestionsForRunType([], 'proton-ge')).toEqual([]);
    expect(suggestionsForRunType(null, 'proton-ge')).toEqual([]);
  });

  test('every RUN_TYPES key is handled without throwing', () => {
    for (const key of Object.keys(RUN_TYPES)) {
      expect(Array.isArray(suggestionsForRunType(entries, key))).toBe(true);
    }
  });
});
