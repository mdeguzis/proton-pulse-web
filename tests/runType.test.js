/**
 * Tests for js/shared/run-type.js -- the canonical runtime taxonomy.
 *
 * Both the submit form and (soon) the pipeline call these helpers to
 * normalize raw signals (form input, launch options, ProtonDB notes) into
 * a stable vocabulary. Regressions here would let 'lsfg' / 'LSFG-VK' /
 * 'lossless-scaling' land as three distinct run_type rows in stats.
 */

const { RUN_TYPES, RUN_TYPE_KEYS, normalizeRunType, uniqueRunTypes, runTypeLabel, validateRuntimeVersion } =
  require('../js/shared/run-type.js');

describe('RUN_TYPES canonical taxonomy', () => {
  test('exposes the built-in keys with labels', () => {
    expect(RUN_TYPE_KEYS).toEqual([
      'native',
      'proton',
      'proton-experimental',
      'proton-ge',
      'proton-cachyos',
      'proton-tkg',
      'proton-lsfg',
    ]);
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

  test('routes specific Proton flavors to their canonical key', () => {
    // GE
    expect(normalizeRunType('GE-Proton9-27')).toBe('proton-ge');
    expect(normalizeRunType('Proton-GE')).toBe('proton-ge');
    expect(normalizeRunType('glorious eggroll')).toBe('proton-ge');
    // Experimental
    expect(normalizeRunType('Proton Experimental')).toBe('proton-experimental');
    expect(normalizeRunType('proton-experimental')).toBe('proton-experimental');
    // CachyOS
    expect(normalizeRunType('cachyos-proton')).toBe('proton-cachyos');
    expect(normalizeRunType('CachyProton')).toBe('proton-cachyos');
    // TKG
    expect(normalizeRunType('Proton-TKG')).toBe('proton-tkg');
    expect(normalizeRunType('tkg_proton')).toBe('proton-tkg');
    // Fallback: any other Proton flavor collapses to the generic key.
    expect(normalizeRunType('Proton 9.0-4')).toBe('proton');
    expect(normalizeRunType('Proton Hotfix')).toBe('proton');
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
    // Insertion order (post-normalize): proton-lsfg (LSFG), proton (proton),
    // native (Native), then Proton Experimental promotes to its own key.
    const raw = ['LSFG', 'proton', 'Native', 'lsfg-vk', 'Proton Experimental', 'linux native'];
    expect(uniqueRunTypes(raw)).toEqual(['proton-lsfg', 'proton', 'native', 'proton-experimental']);
  });

  test('drops nulls (unclassified signals) instead of surfacing them', () => {
    expect(uniqueRunTypes(['native', '', null, 'proton', undefined])).toEqual(['native', 'proton']);
  });
});

describe('validateRuntimeVersion', () => {
  test('empty version always returns ok=null so callers handle "required" separately', () => {
    expect(validateRuntimeVersion('proton', '').ok).toBeNull();
    expect(validateRuntimeVersion('proton', '   ').ok).toBeNull();
    expect(validateRuntimeVersion('proton', null).ok).toBeNull();
  });

  test('native has no pattern -> ok=null (no runtime version applies)', () => {
    expect(validateRuntimeVersion('native', 'anything').ok).toBeNull();
  });

  test('proton accepts stable, hotfix, experimental, and next branches', () => {
    expect(validateRuntimeVersion('proton', 'Proton 9.0-4').ok).toBe(true);
    expect(validateRuntimeVersion('proton', 'Proton 8.0-5c').ok).toBe(true);
    expect(validateRuntimeVersion('proton', 'Proton Hotfix').ok).toBe(true);
    // Valve ships Experimental and Next under the same "Proton" umbrella
    // in Steam. The plain "Proton" runType should accept them without
    // firing a fake "does not look like Proton" warning.
    expect(validateRuntimeVersion('proton', 'Proton Experimental').ok).toBe(true);
    expect(validateRuntimeVersion('proton', 'proton experimental').ok).toBe(true);
    expect(validateRuntimeVersion('proton', 'Proton Next').ok).toBe(true);
    // Rejects unrelated strings
    expect(validateRuntimeVersion('proton', 'GE-Proton9-27').ok).toBe(false);
    expect(validateRuntimeVersion('proton', 'wine 9.0').ok).toBe(false);
  });

  test('proton-ge accepts GE variants incl. rc/beta suffixes', () => {
    expect(validateRuntimeVersion('proton-ge', 'GE-Proton9-27').ok).toBe(true);
    expect(validateRuntimeVersion('proton-ge', 'GE-Proton10-15').ok).toBe(true);
    expect(validateRuntimeVersion('proton-ge', 'ge-proton 10-4').ok).toBe(true);
    // Real GE tags ship rc/beta/letter suffixes; those must not warn.
    expect(validateRuntimeVersion('proton-ge', 'GE-Proton9-27-rc1').ok).toBe(true);
    expect(validateRuntimeVersion('proton-ge', 'GE-Proton9-27b').ok).toBe(true);
    // Still guards obvious mismatches.
    expect(validateRuntimeVersion('proton-ge', 'Proton 9.0-4').ok).toBe(false);
  });

  test('proton-experimental matches Proton Experimental, bleeding-edge, or bare Experimental', () => {
    expect(validateRuntimeVersion('proton-experimental', 'Proton Experimental').ok).toBe(true);
    expect(validateRuntimeVersion('proton-experimental', 'bleeding-edge').ok).toBe(true);
    // Bare "Experimental" is unambiguous once the runtime type is already picked.
    expect(validateRuntimeVersion('proton-experimental', 'Experimental').ok).toBe(true);
    expect(validateRuntimeVersion('proton-experimental', 'Proton 9.0-4').ok).toBe(false);
  });

  test('proton-cachyos matches CachyOS mentions incl. bare CachyOS', () => {
    expect(validateRuntimeVersion('proton-cachyos', 'CachyOS Proton 9.0-4').ok).toBe(true);
    expect(validateRuntimeVersion('proton-cachyos', 'cachy-proton').ok).toBe(true);
    // Bare "CachyOS" is unambiguous once the runtime type is already picked.
    expect(validateRuntimeVersion('proton-cachyos', 'CachyOS').ok).toBe(true);
    expect(validateRuntimeVersion('proton-cachyos', 'Proton 9.0-4').ok).toBe(false);
  });

  test('proton-tkg matches TKG mentions incl. bare TKG', () => {
    expect(validateRuntimeVersion('proton-tkg', 'Proton-TKG 9.0-4').ok).toBe(true);
    expect(validateRuntimeVersion('proton-tkg', 'tkg proton').ok).toBe(true);
    // Bare "TKG" is unambiguous once the runtime type is already picked.
    expect(validateRuntimeVersion('proton-tkg', 'TKG').ok).toBe(true);
    expect(validateRuntimeVersion('proton-tkg', 'Proton 9.0-4').ok).toBe(false);
  });

  test('proton-lsfg accepts LSFG marker OR the wrapped Proton version', () => {
    expect(validateRuntimeVersion('proton-lsfg', 'LSFG-VK').ok).toBe(true);
    expect(validateRuntimeVersion('proton-lsfg', 'Proton 9.0-4 + LSFG').ok).toBe(true);
    expect(validateRuntimeVersion('proton-lsfg', 'Proton 9.0-4').ok).toBe(true);
    expect(validateRuntimeVersion('proton-lsfg', 'notepad').ok).toBe(false);
  });

  test('mismatch returns a helpful hint pointing at the runtime example', () => {
    const v = validateRuntimeVersion('proton-ge', 'Proton 9.0-4');
    expect(v.ok).toBe(false);
    expect(v.hint).toMatch(/GE-Proton/);
  });

  test('unknown runtime returns ok=null (never surface a false failure)', () => {
    expect(validateRuntimeVersion('mystery-runtime', 'anything').ok).toBeNull();
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
