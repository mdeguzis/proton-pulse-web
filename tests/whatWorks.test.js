/**
 * Aggregation tests for the per-game What Works? modal (#440).
 *
 * The aggregation is a pure function that takes the merged reports the
 * game page already has and returns three ranked lists (notes terms,
 * proton versions, launch options) with count + positive_ratio.
 * "Positive" = gold or platinum; silver counts as launch-option evidence.
 */

import { computeWhatWorks, normalizeProtonVersion, tokenizeLaunchOptions, CURATED_NOTE_TERMS } from '../js/app/lib/what-works.js';

const REP = (rating, extra = {}) => ({
  appId: '620', title: 'Portal 2', rating,
  ...extra,
});

describe('normalizeProtonVersion', () => {
  test('coarse GE-Proton buckets with major-minor version', () => {
    expect(normalizeProtonVersion('GE-Proton8-32')).toBe('GE-Proton 8.32');
    expect(normalizeProtonVersion('Proton-GE 8.32')).toBe('GE-Proton 8.32');
    expect(normalizeProtonVersion('Glorious Eggroll')).toBe('GE-Proton');
  });

  test('experimental + hotfix + default buckets', () => {
    expect(normalizeProtonVersion('Proton Experimental')).toBe('Proton Experimental');
    expect(normalizeProtonVersion('Proton Hotfix')).toBe('Proton Hotfix');
    expect(normalizeProtonVersion('Default')).toBe('Proton (default)');
  });

  test('standard Proton 9.x / 8.x parsing', () => {
    expect(normalizeProtonVersion('Proton 9.0-4')).toBe('Proton 9.0');
    expect(normalizeProtonVersion('Beta (3.16-6)')).toBe('Beta (3.16-6)'); // long-form fallback
    expect(normalizeProtonVersion('8.0-5')).toBe('Proton 8.0'); // bare numeric
  });

  test('empty / unknown short-circuits', () => {
    expect(normalizeProtonVersion('')).toBe('');
    expect(normalizeProtonVersion(null)).toBe('');
    expect(normalizeProtonVersion(undefined)).toBe('');
  });
});

describe('tokenizeLaunchOptions', () => {
  test('keeps NAME=value env vars and known wrapper commands', () => {
    expect(tokenizeLaunchOptions('MANGOHUD=1 gamemoderun %command% -novid')).toEqual([
      'MANGOHUD=1', 'gamemoderun', '-novid',
    ]);
  });

  test('lower-cases wrapper commands, strips %command% and single letters', () => {
    // -s / -w with a single letter after the dash is not a game arg
    expect(tokenizeLaunchOptions('gamescope -w 1280 -- %command%')).toEqual([
      'gamescope',
    ]);
  });

  test('handles single-quoted env values', () => {
    expect(tokenizeLaunchOptions(`DXVK_ASYNC='1' PROTON_USE_WINED3D=1`)).toEqual([
      'DXVK_ASYNC=1', 'PROTON_USE_WINED3D=1',
    ]);
  });

  test('empty / falsy input', () => {
    expect(tokenizeLaunchOptions('')).toEqual([]);
    expect(tokenizeLaunchOptions(null)).toEqual([]);
    expect(tokenizeLaunchOptions(undefined)).toEqual([]);
  });
});

describe('computeWhatWorks — notes terms', () => {
  test('curated terms match case-insensitive with word boundaries', () => {
    const reports = [
      REP('gold',     { notes: 'Runs great with proton-ge and mangohud enabled' }),
      REP('gold',     { notes: 'Proton-GE 8-32 + gamemoderun fix' }),
      REP('silver',   { notes: 'MangoHud is helpful for the overlay' }),
      REP('borked',   { notes: 'Crashes without dxvk_async' }),
      REP('platinum', { notes: 'Nothing special' }),
    ];
    const out = computeWhatWorks(reports);
    const terms = new Map(out.notesTerms.map(t => [t.term, t]));
    expect(terms.get('Proton-GE').count).toBe(2);
    expect(terms.get('Proton-GE').positive_ratio).toBe(1); // both were gold
    // 2 reports mention MangoHud (report 1 gold, report 3 silver).
    expect(terms.get('MangoHud').count).toBe(2);
    expect(terms.get('MangoHud').positive_ratio).toBe(0.5);
    expect(terms.get('DXVK_ASYNC').count).toBe(1);
    expect(terms.get('DXVK_ASYNC').positive_ratio).toBe(0); // only borked mentioned it
  });

  test('sorted by count then positive_ratio', () => {
    const reports = [
      REP('gold',   { notes: 'mangohud' }),
      REP('gold',   { notes: 'mangohud' }),
      REP('bronze', { notes: 'mangohud' }),
      REP('gold',   { notes: 'gamemoderun' }),
    ];
    const out = computeWhatWorks(reports);
    expect(out.notesTerms[0].term).toBe('MangoHud');
    expect(out.notesTerms[1].term).toBe('GameMode');
  });

  test('empty reports returns empty aggregations + zero totals', () => {
    const out = computeWhatWorks([]);
    expect(out.notesTerms).toEqual([]);
    expect(out.protonVersions).toEqual([]);
    expect(out.launchOptions).toEqual([]);
    expect(out.totals).toEqual({ reports: 0, positive: 0 });
  });

  test('non-array input tolerated', () => {
    expect(computeWhatWorks(null).totals.reports).toBe(0);
    expect(computeWhatWorks(undefined).totals.reports).toBe(0);
  });
});

describe('computeWhatWorks — proton versions', () => {
  test('folds noisy raw versions into stable buckets and computes positive_ratio', () => {
    const reports = [
      REP('gold',     { protonVersion: 'GE-Proton8-32' }),
      REP('platinum', { protonVersion: 'Proton-GE 8.32' }),
      REP('bronze',   { protonVersion: 'Proton 9.0-4' }),
      REP('borked',   { protonVersion: 'Default' }),
    ];
    const out = computeWhatWorks(reports);
    const byVer = new Map(out.protonVersions.map(v => [v.version, v]));
    expect(byVer.get('GE-Proton 8.32').count).toBe(2);
    expect(byVer.get('GE-Proton 8.32').positive_ratio).toBe(1);
    expect(byVer.get('Proton 9.0').count).toBe(1);
    expect(byVer.get('Proton 9.0').positive_ratio).toBe(0);
    expect(byVer.get('Proton (default)').count).toBe(1);
  });
});

describe('computeWhatWorks — launch options', () => {
  test('only silver-and-up reports contribute launch-option tokens', () => {
    const reports = [
      REP('borked', { launchOptions: 'MANGOHUD=1 gamemoderun %command%' }),
      REP('gold',   { launchOptions: 'MANGOHUD=1 gamemoderun %command%' }),
      REP('silver', { launchOptions: 'gamemoderun %command%' }),
    ];
    const out = computeWhatWorks(reports);
    const byTok = new Map(out.launchOptions.map(t => [t.token, t]));
    // borked report should NOT contribute
    expect(byTok.get('MANGOHUD=1').count).toBe(1);
    // gold + silver both contribute to gamemoderun
    expect(byTok.get('gamemoderun').count).toBe(2);
    // gold-only positive_ratio for MANGOHUD=1 is 1/1 = 1
    expect(byTok.get('MANGOHUD=1').positive_ratio).toBe(1);
    // gamemoderun mixed: 1 gold + 1 silver -> ratio = 1/2 (silver is not "positive")
    expect(byTok.get('gamemoderun').positive_ratio).toBe(0.5);
  });

  test('dedupes tokens within a single report so one report counts once per token', () => {
    // A malformed launchOptions string with duplicated wrappers must not
    // inflate the count for a single report.
    const reports = [
      REP('gold', { launchOptions: 'gamemoderun gamemoderun %command%' }),
    ];
    const out = computeWhatWorks(reports);
    const byTok = new Map(out.launchOptions.map(t => [t.token, t]));
    expect(byTok.get('gamemoderun').count).toBe(1);
  });
});

describe('CURATED_NOTE_TERMS', () => {
  test('every entry is [display, regex]', () => {
    for (const entry of CURATED_NOTE_TERMS) {
      expect(Array.isArray(entry)).toBe(true);
      expect(typeof entry[0]).toBe('string');
      expect(entry[1] instanceof RegExp).toBe(true);
    }
  });

  test('displays are unique so aggregation Map does not collide', () => {
    const displays = CURATED_NOTE_TERMS.map(([d]) => d);
    expect(new Set(displays).size).toBe(displays.length);
  });
});
