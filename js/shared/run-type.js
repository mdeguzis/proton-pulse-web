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
// Each canonical entry pairs the display metadata with a `versionPattern`
// used by the submit form to validate the free-text version string the
// user (or plugin) enters. Patterns are deliberately loose because
// runtimes ship variants ("Proton 9.0-4", "Proton 8.0-5c", "GE-Proton9-27",
// "Proton-TKG 9.0"), but strict enough that a Proton version pasted into
// the Native slot or vice-versa is caught before the row is written.
export const RUN_TYPES = Object.freeze({
  native: {
    key:      'native',
    label:    'Native Linux',
    subtitle: 'Linux build (no Proton)',
    versionPattern: null,        // native has no runtime version to record
    versionExample: 'not applicable',
  },
  proton: {
    key:      'proton',
    label:    'Proton',
    subtitle: 'Valve\'s official Proton (stable / hotfix)',
    // Also accepts the named branches Valve ships under the same "Proton"
    // umbrella in the Steam client (Experimental, Next, Hotfix) so the user
    // doesn't get a fake "does not look like Proton" warning when they pick
    // plain Proton but paste one of those variant strings.
    versionPattern: /^proton[\s-]?(\d+(?:\.\d+)*(?:[-_]\w+)?|hotfix|experimental|next)$/i,
    versionExample: 'e.g. Proton 9.0-4, Proton Hotfix, or Proton Experimental',
  },
  'proton-experimental': {
    key:      'proton-experimental',
    label:    'Proton Experimental',
    subtitle: 'Valve\'s bleeding-edge Proton branch',
    // Also accepts bare "Experimental" -- when the user already picked the
    // proton-experimental runtime, "Experimental" is unambiguous.
    versionPattern: /(proton[\s-]?experimental|bleeding[-\s]?edge|^\s*experimental\s*$)/i,
    versionExample: 'e.g. Proton Experimental',
  },
  'proton-ge': {
    key:      'proton-ge',
    label:    'Proton GE',
    subtitle: 'GloriousEggroll community fork',
    // Accepts alphanumeric suffixes (rc1, beta, "9-27b") since GE tags
    // ship those variants. \w in the trailing segments covers letters +
    // digits without breaking anchored matching.
    versionPattern: /^(ge[-_ ]?proton|proton[-_ ]?ge)[-_ ]?\d+([-_.]\w+)*$/i,
    versionExample: 'e.g. GE-Proton9-27',
  },
  'proton-cachyos': {
    key:      'proton-cachyos',
    label:    'CachyOS Proton',
    subtitle: 'CachyOS-tuned Proton',
    // Also accepts bare "CachyOS" when the user already picked cachyos.
    versionPattern: /(cachy(os)?[-\s]?proton|^\s*cachy(os)?\s*$)/i,
    versionExample: 'e.g. CachyOS Proton 9.0-4',
  },
  'proton-tkg': {
    key:      'proton-tkg',
    label:    'Proton-TKG',
    subtitle: 'TKG custom Proton build',
    // Also accepts bare "TKG" when the user already picked tkg.
    versionPattern: /(proton[-_ ]?tkg|tkg[-_ ]?proton|^\s*tkg\s*$)/i,
    versionExample: 'e.g. Proton-TKG 9.0-4',
  },
  'proton-lsfg': {
    key:      'proton-lsfg',
    label:    'Proton + LSFG',
    subtitle: 'Any Proton flavor with Lossless Scaling FrameGen wrapper',
    // LSFG wraps another Proton -- accept anything that mentions LSFG OR
    // the underlying Proton build so the user can enter either surface.
    versionPattern: /(lsfg|lossless[-\s]?scaling|proton)/i,
    versionExample: 'e.g. GE-Proton9-27 + LSFG',
  },
});

/**
 * Check whether a free-text version string plausibly matches the runtime
 * the user picked. Returns:
 *   { ok: true }                       if the pattern matches
 *   { ok: false, hint: '...' }         if it does not (soft warn UX)
 *   { ok: null }                       if we don't know how to validate
 *                                      (unknown runtime, or native)
 * Empty version strings always return { ok: null } so callers can decide
 * whether "required" is a separate concern.
 */
export function validateRuntimeVersion(runType, versionStr) {
  const key = runType || 'proton';
  const meta = RUN_TYPES[key];
  const trimmed = String(versionStr || '').trim();
  if (!trimmed) return { ok: null };
  if (!meta || !meta.versionPattern) return { ok: null };
  const ok = meta.versionPattern.test(trimmed);
  return ok ? { ok: true } : { ok: false, hint: meta.versionExample };
}

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
