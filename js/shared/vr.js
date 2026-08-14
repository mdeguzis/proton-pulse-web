// vr.js -- canonical VR vocabulary for Pulse reports (#246).
//
// Two separate axes, easy to conflate:
//
//   play_mode      how the REPORTER played it: 'flat' | 'vr'
//   search_index.vr  what the GAME supports:   null | 'supported' | 'only'
//
// A game can support VR while the reporter played it flat, so a VR report
// must never be aggregated as if it were flatscreen -- "runs great" means
// something very different at 90Hz stereo.
//
// The runtime list matches VRDB (github.com/Respuit/VRDB), the community
// VR-on-Linux database the pipeline ingests for the game-page VR panel, so
// their reports and ours line up on the same axes rather than needing a
// translation table.
//
// Canonical values are lowercase, hyphen-separated, matching the DB CHECK
// regex on user_configs.vr_runtime. See
// supabase/migrations/20260814010000_add_play_mode_to_user_configs.sql.

/** How the reporter played. 'flat' is the default for every existing row. */
export const PLAY_MODES = Object.freeze({
  flat: { key: 'flat', label: 'Flatscreen', subtitle: 'Normal monitor / TV play' },
  vr:   { key: 'vr',   label: 'VR',         subtitle: 'Played in a headset' },
});

export const PLAY_MODE_KEYS = Object.freeze(Object.keys(PLAY_MODES));

/**
 * VR runtimes, ordered by how common they are in Linux VR reports. 'other'
 * is last and always available -- a new OpenXR implementation lands every
 * few months and a reporter should never be blocked on our list being stale.
 */
export const VR_RUNTIMES = Object.freeze({
  steamvr: { key: 'steamvr', label: 'SteamVR',  subtitle: "Valve's runtime" },
  wivrn:   { key: 'wivrn',   label: 'WiVRn',    subtitle: 'Standalone streaming (Monado-based)' },
  alvr:    { key: 'alvr',    label: 'ALVR',     subtitle: 'Air Light VR streaming' },
  monado:  { key: 'monado',  label: 'Monado',   subtitle: 'Open-source OpenXR runtime' },
  other:   { key: 'other',   label: 'Other',    subtitle: 'Anything else' },
});

export const VR_RUNTIME_KEYS = Object.freeze(Object.keys(VR_RUNTIMES));

/**
 * Canonical headsets for the report form, most common first (ordering taken
 * from the VRDB corpus). Not exhaustive by design -- the form pairs this with
 * an "Other" free-text box, and scripts/pipeline/vrdb.py maps VRDB's 61
 * free-text spellings onto exactly this list. A test asserts the two stay in
 * step; update both together.
 */
export const VR_HEADSETS = Object.freeze([
  'Meta Quest 3',
  'Meta Quest 3S',
  'Meta Quest 2',
  'Meta Quest Pro',
  'Meta Quest 1',
  'Valve Index',
  'HTC Vive',
  'HTC Vive Pro',
  'Pico 4',
  'HP Reverb G2',
  'Bigscreen Beyond',
  'Pimax',
  'Oculus Rift',
]);

/** Game-level VR capability, as stored on search_index.vr. */
export const VR_SUPPORT = Object.freeze({
  supported: { key: 'supported', label: 'VR Supported', badge: 'VR' },
  only:      { key: 'only',      label: 'VR Only',      badge: 'VR Only' },
});

/**
 * Normalize a raw play-mode signal into 'flat' | 'vr'.
 *
 * Returns null for empty / unrecognized input so callers can treat it as
 * unknown rather than silently claiming the report was flatscreen. Legacy
 * rows predate the field entirely and must stay unknown, not be backfilled
 * as flat -- a VR report submitted before this shipped would be mislabeled.
 *
 * @param {*} raw - User input, DB value, or plugin payload.
 * @returns {string|null}
 */
export function normalizePlayMode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (PLAY_MODE_KEYS.includes(s)) return s;
  if (/^(vr|virtual[-_\s]?reality|headset|hmd)$/.test(s)) return 'vr';
  if (/^(flat|flatscreen|flat[-_\s]screen|2d|desktop|monitor|normal|pancake)$/.test(s)) return 'flat';
  return null;
}

/**
 * Normalize a raw VR runtime signal into a canonical key.
 *
 * Unknown-but-clean values pass through lowercased (same escape hatch as
 * normalizeRunType in run-type.js) so a runtime we have not registered yet
 * can still be recorded rather than dropped.
 *
 * @param {*} raw - User input, DB value, or VRDB field name.
 * @returns {string|null}
 */
export function normalizeVrRuntime(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (VR_RUNTIME_KEYS.includes(s)) return s;
  if (/^steam\s*vr$/.test(s) || /\bsteamvr\b/.test(s)) return 'steamvr';
  if (/\bwivrn\b/.test(s)) return 'wivrn';
  if (/\balvr\b/.test(s)) return 'alvr';
  if (/\bmonado\b/.test(s)) return 'monado';
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length <= 32) return s;
  return null;
}

/** Human label for a play mode key. */
export function playModeLabel(key) {
  if (key == null) return 'Unknown';
  return PLAY_MODES[key]?.label || key;
}

/** Human label for a VR runtime key, falling back to the raw key. */
export function vrRuntimeLabel(key) {
  if (key == null) return 'Unknown';
  return VR_RUNTIMES[key]?.label || key;
}

/**
 * VRDB rates each runtime 1-5 where LOWER IS BETTER, the inverse of how a
 * Pulse tier reads. Nothing from VRDB feeds Pulse scoring; this exists so the
 * VR panel can label their numbers with their own words.
 * Mirrors _data/ratings.json upstream and VRDB_RATINGS in pipeline/vrdb.py.
 */
export const VRDB_RATINGS = Object.freeze({
  1: 'Perfect',
  2: 'Requires manual configuration',
  3: 'Playable with graphical/controller issues',
  4: 'Unplayable because of graphical/controller issues',
  5: "Crashes or won't start",
});

/**
 * Colour band for a VRDB rating, reusing the tier palette so 1 reads as
 * "good" at a glance the same way platinum does. Returns a CSS colour.
 * @param {number} rating - VRDB 1-5 rating.
 * @returns {string}
 */
export function vrdbRatingColor(rating) {
  switch (Number(rating)) {
    case 1:  return '#b4c7dc'; // platinum
    case 2:  return '#c8a050'; // gold
    case 3:  return '#8fa0b0'; // silver
    case 4:  return '#b07040'; // bronze
    case 5:  return '#c85050'; // borked
    default: return 'var(--muted)';
  }
}
