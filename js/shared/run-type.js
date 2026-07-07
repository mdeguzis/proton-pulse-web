// run-type.js -- canonical runtime taxonomy for Pulse reports.
//
// The user picks native vs Proton on the submit form; the pipeline
// discovers additional runtimes from ProtonDB report text + launch
// options (e.g. lsfg-vk framegen wrappers) and normalizes them into the
// same canonical vocabulary. Both paths import this module so we never
// end up with 'lsfg', 'LSFG', 'lsfg-vk', 'lossless-scaling' as four
// distinct rows in stats.
//
// Canonical values are lowercase, hyphen-separated identifiers matching
// the DB CHECK regex `^[a-z0-9]+(-[a-z0-9]+)*$`. See
// supabase/migrations/20260707020500_relax_run_type_constraint.sql.

/**
 * Canonical run types. Keys match the DB column values; labels/subtitles
 * drive the submit-form toggle. Keep new entries lowercase + hyphenated.
 *
 * Order matters: it drives the render order of any filter modal that
 * iterates this map. Native first (it is the reference baseline for
 * comparisons); Proton next; wrappers after.
 */
export const RUN_TYPES = Object.freeze({
  native: {
    key:      'native',
    label:    'Native Linux',
    subtitle: 'Linux build (no Proton)',
  },
  proton: {
    key:      'proton',
    label:    'Proton',
    subtitle: 'Valve\'s official Proton (stable / hotfix)',
  },
  'proton-experimental': {
    key:      'proton-experimental',
    label:    'Proton Experimental',
    subtitle: 'Valve\'s bleeding-edge Proton branch',
  },
  'proton-ge': {
    key:      'proton-ge',
    label:    'Proton GE',
    subtitle: 'GloriousEggroll community fork',
  },
  'proton-cachyos': {
    key:      'proton-cachyos',
    label:    'CachyOS Proton',
    subtitle: 'CachyOS-tuned Proton',
  },
  'proton-tkg': {
    key:      'proton-tkg',
    label:    'Proton-TKG',
    subtitle: 'TKG custom Proton build',
  },
  'proton-lsfg': {
    key:      'proton-lsfg',
    label:    'Proton + LSFG',
    subtitle: 'Any Proton flavor with Lossless Scaling FrameGen wrapper',
  },
});

/** Ordered list of canonical keys for iteration. */
export const RUN_TYPE_KEYS = Object.freeze(Object.keys(RUN_TYPES));

/**
 * Normalize a raw runtime signal (user input, launch-option snippet,
 * ProtonDB note text) into a canonical key. Returns null when the input
 * looks empty or unknown so callers can treat it as "unclassified"
 * instead of guessing.
 *
 * Recognizes:
 *   native / linux native / linux-only / linux build     -> 'native'
 *   proton / GE-Proton / Proton-Experimental / etc.      -> 'proton'
 *   lsfg / lsfg-vk / lossless scaling                    -> 'proton-lsfg'
 *
 * Callers that already have a canonical key can pass it in; unknown
 * strings that match the DB regex are returned lowercased so pipeline
 * discovery can extend the taxonomy without a code change.
 */
export function normalizeRunType(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Pass-through: already a known canonical value.
  if (RUN_TYPE_KEYS.includes(s)) return s;

  // LSFG / Lossless Scaling FrameGen wrapper -- assume Proton underneath
  // since native LSFG is Windows-only. Detection wins over other Proton
  // matchers because the wrapper is the salient axis for stats.
  if (/\b(lsfg[-_]?vk|lsfg|lossless[-_ ]scaling)\b/.test(s)) return 'proton-lsfg';

  // Native Linux binary signals.
  if (/\b(native|linux[-_ ]?native|native[-_ ]linux|linux[-_ ]build|linux[-_ ]only)\b/.test(s)) return 'native';

  // Specific Proton flavors, in most-specific-wins order. Word boundaries
  // are omitted on the trailing side because MangoHud + ProtonDB text
  // often carries an appended digit sequence ("GE-Proton9-27",
  // "proton-tkg9.0") that breaks a `\b` after the flavor name.
  if (/(ge[-_]proton|proton[-_]ge|glorious[-_ ]?eggroll)/.test(s)) return 'proton-ge';
  if (/(cachyos[-_]?proton|proton[-_]?cachyos|cachy[-_]?proton)/.test(s)) return 'proton-cachyos';
  if (/(proton[-_]?tkg|tkg[-_]?proton)/.test(s)) return 'proton-tkg';
  if (/proton[-_ ]?experimental/.test(s)) return 'proton-experimental';

  // Any other Proton flavor (Proton 9.0-4, Proton Hotfix, etc.). Substring
  // rather than \bproton\b because trailing digit sequences (proton9,
  // proton-9.0-4) break the word boundary check.
  if (/proton/.test(s)) return 'proton';

  // Unknown but syntactically clean: let it through so pipeline
  // discovery can widen the taxonomy without shipping code.
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length <= 32) return s;

  return null;
}

/**
 * Deduplicate a list of raw run-type signals via normalizeRunType.
 * Returns a stable-order array of canonical keys with no repeats.
 * Nulls from the normalizer are dropped.
 */
export function uniqueRunTypes(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawList) {
    const key = normalizeRunType(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Human label for a canonical key. Falls back to the key itself for
 * pipeline-discovered values that we have not registered in RUN_TYPES yet.
 */
export function runTypeLabel(key) {
  if (key == null) return 'Unknown';
  return RUN_TYPES[key]?.label || key;
}
