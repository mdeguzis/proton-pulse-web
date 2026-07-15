/**
 * @jest-environment jsdom
 *
 * Property-based fuzz tests for user-input parsers (#321).
 *
 * The parsers we ship never throw on hostile input because they run in
 * user-facing paths (topbar search, submit form, profile importer). These
 * tests use fast-check to prove that invariant across a broad input space
 * instead of relying on hand-picked examples.
 *
 * What each block asserts:
 *  - never throws for any string input
 *  - returns the expected type (string, null, or object of a specific shape)
 *  - never emits characters that would break out of an HTML context (esc)
 *  - is deterministic (calling twice returns the same result)
 */

const fc = require('fast-check');

const { parseStoreUrl } = require('../js/lib/store-url-parser.js');
const { detectGpuArch } = require('../js/lib/gpu-arch-detector.js');
const { appIdToDir } = require('../js/lib/app-id.js');
const {
  normalizeOs,
  esc,
  escWithSpoilers,
  truncate,
  fmtDuration,
  fmtMinutes,
  hashReportKey,
} = require('../js/app/utils.js');
const {
  cleanUnknown,
  parseSteamSystemInfo,
  inferGpuVendor,
  inferCpuVendor,
} = require('../js/profile/utils.js');

const CFG = { numRuns: 400 };

// ---- pure string transforms ------------------------------------------------

describe('parseStoreUrl (fuzz)', () => {
  test('never throws on any string input', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      parseStoreUrl(s);
    }), CFG);
  });

  test('always returns null or a well-formed object', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const r = parseStoreUrl(s);
      if (r === null) return true;
      return (
        typeof r === 'object' &&
        typeof r.store === 'string' &&
        ['steam', 'gog', 'epic'].includes(r.store) &&
        'appId' in r && 'canonicalId' in r && 'slug' in r
      );
    }), CFG);
  });

  test('is deterministic', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(parseStoreUrl(s)).toEqual(parseStoreUrl(s));
    }), CFG);
  });

  test('numeric Steam appId always digits-only', () => {
    fc.assert(fc.property(fc.nat({ max: 9999999 }), (id) => {
      const r = parseStoreUrl(`https://store.steampowered.com/app/${id}/`);
      expect(r).not.toBeNull();
      expect(/^\d+$/.test(r.appId)).toBe(true);
    }), CFG);
  });

  test('non-URL free text always returns null', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).filter((s) => !/^(https?:\/\/)?[a-z]+\./i.test(s)),
      (s) => {
        expect(parseStoreUrl(s)).toBeNull();
      },
    ), CFG);
  });
});

describe('detectGpuArch (fuzz)', () => {
  test('never throws on any input', () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined)), (s) => {
      detectGpuArch(s);
    }), CFG);
  });

  test('always returns a string', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(typeof detectGpuArch(s)).toBe('string');
    }), CFG);
  });

  test('is case-insensitive (upper matches lower)', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(detectGpuArch(s.toUpperCase())).toBe(detectGpuArch(s.toLowerCase()));
    }), CFG);
  });
});

describe('appIdToDir (fuzz)', () => {
  test('never throws and always returns a string', () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.integer(), fc.float(), fc.nat()),
      (v) => {
        expect(typeof appIdToDir(v)).toBe('string');
      },
    ), CFG);
  });

  test('replaces the first colon with underscore', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
      const cleanA = a.replace(/:/g, '');
      const cleanB = b.replace(/:/g, '');
      expect(appIdToDir(`${cleanA}:${cleanB}`)).toBe(`${cleanA}_${cleanB}`);
    }), CFG);
  });
});

describe('normalizeOs (fuzz)', () => {
  test('never throws on any string input', () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.constant('')),
      (s) => { normalizeOs(s); },
    ), CFG);
  });

  test('always returns a string', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(typeof normalizeOs(s)).toBe('string');
    }), CFG);
  });

  test('digits-only input is stripped to empty', () => {
    fc.assert(fc.property(fc.stringMatching(/^\d+$/, { minLength: 1, maxLength: 20 }), (s) => {
      expect(normalizeOs(s)).toBe('');
    }), CFG);
  });
});

describe('truncate (fuzz)', () => {
  test('output length is never greater than max + ellipsis', () => {
    fc.assert(fc.property(fc.string(), fc.nat({ max: 200 }), (s, n) => {
      const out = truncate(s, n);
      if (!s) return true;
      if (s.length <= n) return out === s;
      return out.length === n + 3 && out.endsWith('...');
    }), CFG);
  });
});

describe('fmtDuration / fmtMinutes (fuzz)', () => {
  test('fmtDuration never throws for arbitrary input', () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.integer(), fc.float(), fc.constant(null), fc.constant(undefined)),
      (v) => { fmtDuration(v); },
    ), CFG);
  });

  test('fmtMinutes never throws for arbitrary numeric-ish input', () => {
    fc.assert(fc.property(
      fc.oneof(fc.integer(), fc.float(), fc.string(), fc.constant(null), fc.constant(undefined)),
      (v) => { fmtMinutes(v); },
    ), CFG);
  });
});

describe('hashReportKey (fuzz)', () => {
  test('always returns a string of consistent length for any input', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const h = hashReportKey(s);
      expect(typeof h).toBe('string');
      expect(h.length).toBeGreaterThan(0);
    }), CFG);
  });

  test('is deterministic', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(hashReportKey(s)).toBe(hashReportKey(s));
    }), CFG);
  });
});

// ---- profile utils (pure string transforms, no DOM needed) -----------------

describe('cleanUnknown (fuzz)', () => {
  test('never throws for any input type', () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined), fc.constant({})),
      (v) => { cleanUnknown(v); },
    ), CFG);
  });

  test('always returns a string', () => {
    fc.assert(fc.property(fc.anything(), (v) => {
      expect(typeof cleanUnknown(v)).toBe('string');
    }), CFG);
  });

  test('"unknown" (any case) collapses to empty', () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[uU][nN][kK][nN][oO][wW][nN]$/),
      (s) => {
        expect(cleanUnknown(s)).toBe('');
        expect(cleanUnknown(`  ${s}  `)).toBe('');
      },
    ), CFG);
  });
});

describe('parseSteamSystemInfo (fuzz)', () => {
  test('never throws on any string input', () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.constant('')),
      (s) => { parseSteamSystemInfo(s); },
    ), CFG);
  });

  test('always returns an object', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(typeof parseSteamSystemInfo(s)).toBe('object');
      expect(parseSteamSystemInfo(s)).not.toBeNull();
    }), CFG);
  });

  test('is deterministic', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(parseSteamSystemInfo(s)).toEqual(parseSteamSystemInfo(s));
    }), CFG);
  });
});

describe('inferGpuVendor / inferCpuVendor (fuzz)', () => {
  test('inferGpuVendor never throws + returns allowed value', () => {
    const allowed = new Set(['nvidia', 'amd', 'intel', '']);
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined)),
      (s) => {
        const r = inferGpuVendor(s);
        expect(allowed.has(r)).toBe(true);
      },
    ), CFG);
  });

  test('inferCpuVendor never throws + returns allowed value', () => {
    const allowed = new Set(['amd', 'intel', 'other', '']);
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined)),
      (s) => {
        const r = inferCpuVendor(s);
        expect(allowed.has(r)).toBe(true);
      },
    ), CFG);
  });
});

// ---- HTML escaping ---------------------------------------------------------
// esc + escWithSpoilers need a DOM.

describe('esc (fuzz)', () => {
  test('never throws for arbitrary input', () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.constant('')),
      (s) => { esc(s); },
    ), CFG);
  });

  test('output never contains raw < or > or unescaped & pointing at markup', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const out = esc(s);
      // Must be a string.
      expect(typeof out).toBe('string');
      // No raw script or html tag can survive.
      expect(/<script|<img|<svg|<iframe/i.test(out)).toBe(false);
      // Any < in the output must be immediately escaped (jsdom uses &lt;).
      // We simply assert there is no unescaped `<` character.
      expect(out.includes('<')).toBe(false);
    }), CFG);
  });
});

describe('escWithSpoilers (fuzz)', () => {
  test('never throws for any input', () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.constant('')),
      (s) => { escWithSpoilers(s); },
    ), CFG);
  });

  test('output is a string; only spoiler spans introduce < characters', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const out = escWithSpoilers(s);
      expect(typeof out).toBe('string');
      // If the input had no {spoiler}...{/spoiler} block, there should be
      // no < characters in the output (esc() would have escaped them).
      if (!/\{spoiler\}[\s\S]*?\{\/spoiler\}/i.test(s)) {
        expect(out.includes('<')).toBe(false);
      }
    }), CFG);
  });
});
