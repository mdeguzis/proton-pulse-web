/**
 * Tests for js/shared/run-type.js -- the canonical runtime taxonomy.
 *
 * Both the submit form and (soon) the pipeline call these helpers to
 * normalize raw signals (form input, launch options, ProtonDB notes) into
 * a stable vocabulary. Regressions here would let 'lsfg' / 'LSFG-VK' /
 * 'lossless-scaling' land as three distinct run_type rows in stats.
 */

const { RUN_TYPES, RUN_TYPE_KEYS, normalizeRunType, uniqueRunTypes, runTypeLabel } =
  require('../js/shared/run-type.js');

describe('RUN_TYPES canonical taxonomy', () => {
  test('exposes the three built-in keys with labels', () => {
    expect(RUN_TYPE_KEYS).toEqual(['native', 'proton', 'proton-lsfg']);
    for (const k of RUN_TYPE_KEYS) {
      expect(RUN_TYPES[k].label).toBeTruthy();
      expect(RUN_TYPES[k].subtitle).toBeTruthy();
    }
  });

  test('every canonical key satisfies the DB CHECK regex', () => {
    const re = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const k of RUN_TYPE_KEYS) expect(k).toMatch(re);
  });
});

describe('normalizeRunType', () => {
  test('returns null for empty / non-string input', () => {
    expect(normalizeRunType(null)).toBeNull();
    expect(normalizeRunType(undefined)).toBeNull();
    expect(normalizeRunType('')).toBeNull();
    expect(normalizeRunType('   ')).toBeNull();
  });

  test('pass-through on already-canonical keys', () => {
    expect(normalizeRunType('native')).toBe('native');
    expect(normalizeRunType('proton')).toBe('proton');
    expect(normalizeRunType('proton-lsfg')).toBe('proton-lsfg');
  });

  test('collapses LSFG variants into proton-lsfg', () => {
    expect(normalizeRunType('lsfg')).toBe('proton-lsfg');
    expect(normalizeRunType('LSFG')).toBe('proton-lsfg');
    expect(normalizeRunType('lsfg-vk')).toBe('proton-lsfg');
    expect(normalizeRunType('lsfg_vk')).toBe('proton-lsfg');
    expect(normalizeRunType('lossless scaling')).toBe('proton-lsfg');
    expect(normalizeRunType('Lossless-Scaling')).toBe('proton-lsfg');
  });

  test('recognizes native / linux native variants', () => {
    expect(normalizeRunType('Native')).toBe('native');
    expect(normalizeRunType('linux native')).toBe('native');
    expect(normalizeRunType('Native-Linux')).toBe('native');
    expect(normalizeRunType('linux_only')).toBe('native');
    expect(normalizeRunType('linux build')).toBe('native');
  });

  test('recognizes any Proton flavor', () => {
    expect(normalizeRunType('Proton 9.0-4')).toBe('proton');
    expect(normalizeRunType('GE-Proton9-27')).toBe('proton');
    expect(normalizeRunType('Proton Experimental')).toBe('proton');
    expect(normalizeRunType('cachyos-proton')).toBe('proton');
  });

  test('passes through clean pipeline-discovered identifiers', () => {
    // pipeline may extract something we do not know about yet
    expect(normalizeRunType('cool-runtime-9')).toBe('cool-runtime-9');
    expect(normalizeRunType('COOL-RUNTIME')).toBe('cool-runtime');
  });

  test('rejects unknown strings that violate the DB regex', () => {
    // Semantic matchers still fire on strings that contain a recognized
    // keyword (so 'foo/bar-proton' becomes 'proton'), but pass-through only
    // accepts DB-shape identifiers.
    expect(normalizeRunType('foo bar baz')).toBeNull();       // spaces + unknown
    expect(normalizeRunType('foo/bar')).toBeNull();           // slash + unknown
    expect(normalizeRunType('a'.repeat(33))).toBeNull();      // over 32 chars
    expect(normalizeRunType('!!!')).toBeNull();               // punctuation
  });
});

describe('uniqueRunTypes', () => {
  test('empty / non-array input returns []', () => {
    expect(uniqueRunTypes(null)).toEqual([]);
    expect(uniqueRunTypes(undefined)).toEqual([]);
    expect(uniqueRunTypes([])).toEqual([]);
  });

  test('dedupes across matcher variants in stable insertion order', () => {
    const raw = ['LSFG', 'proton', 'Native', 'lsfg-vk', 'Proton Experimental', 'linux native'];
    expect(uniqueRunTypes(raw)).toEqual(['proton-lsfg', 'proton', 'native']);
  });

  test('drops nulls (unclassified signals) instead of surfacing them', () => {
    expect(uniqueRunTypes(['native', '', null, 'proton', undefined])).toEqual(['native', 'proton']);
  });
});

describe('runTypeLabel', () => {
  test('canonical keys return the registered label', () => {
    expect(runTypeLabel('native')).toBe('Native Linux');
    expect(runTypeLabel('proton')).toBe('Proton');
    expect(runTypeLabel('proton-lsfg')).toBe('Proton + LSFG');
  });

  test('unknown key returns the key itself so pipeline-only values still render', () => {
    expect(runTypeLabel('mystery-runtime')).toBe('mystery-runtime');
  });

  test('null returns "Unknown"', () => {
    expect(runTypeLabel(null)).toBe('Unknown');
  });
});
