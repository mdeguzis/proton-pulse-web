// Central pattern matchers for the stats/analytics surface (#205, umbrella #204).
//
// Every group below is { key, matchers, label }. matchers are word-boundary
// case-insensitive regexes -- 'gamemode' matches 'gamemoderun -O' but not
// 'gamemodeless'. Downstream code SHOULD NOT invent its own patterns for the
// same concept: import a group from here so 'crash on cutscene' counts the
// same everywhere.
//
// Nothing in this module touches the DOM or fetches; it's a pure text -> set
// mapping. Phases B/C/D/E/F consume it.

const RX = (source, flags = 'i') => new RegExp(source, flags);

// Optimization mentions in free-text (notes / launch_options / form_responses
// text answers). Presence is a signal for the Correlations tab (#207) and the
// My Library recommendations (#209).
export const OPTIMIZATION_PATTERNS = [
  { key: 'proton-ge',      label: 'Proton-GE',       matchers: [RX('\\bproton[-_ ]?ge\\b'), RX('\\bglorious[-_ ]?eggroll\\b'), RX('\\bge[-_ ]?proton\\b')] },
  { key: 'proton-tkg',     label: 'Proton-TKG',      matchers: [RX('\\bproton[-_ ]?tkg\\b'), RX('\\btkg[-_ ]?proton\\b')] },
  { key: 'proton-cachyos', label: 'Proton-CachyOS',  matchers: [RX('\\bproton[-_ ]?cachyos\\b'), RX('\\bcachyos[-_ ]?proton\\b')] },
  { key: 'gamemode',       label: 'GameMode',        matchers: [RX('\\bgamemode(?:run)?\\b'), RX('\\bferal[-_ ]?gamemode\\b')] },
  { key: 'mangohud',       label: 'MangoHud',        matchers: [RX('\\bmangohud\\b')] },
  { key: 'gamescope',      label: 'Gamescope',       matchers: [RX('\\bgamescope\\b')] },
  { key: 'dxvk-async',     label: 'DXVK async',      matchers: [RX('\\bdxvk[-_]async\\b'), RX('\\bdxvk_async\\b'), RX('\\bdxvk\\s+async\\b')] },
  { key: 'vkbasalt',       label: 'vkBasalt',        matchers: [RX('\\bvkbasalt\\b'), RX('\\bvk_basalt\\b')] },
  { key: 'nis',            label: 'NVIDIA NIS',      matchers: [RX('\\b(?:nvidia[-_ ]?)?image[-_ ]?scal(?:e|ing)\\b'), RX('\\bnvidia[-_ ]?nis\\b'), RX('\\bnis[-_ ]?scaling\\b')] },
  { key: 'dlss',           label: 'DLSS',            matchers: [RX('\\bdlss\\b')] },
  { key: 'fsr',            label: 'AMD FSR',         matchers: [RX('\\bfsr\\b'), RX('\\bfidelityfx\\b')] },
  { key: 'xess',           label: 'Intel XeSS',      matchers: [RX('\\bxess\\b')] },
  { key: 'protonup',       label: 'ProtonUp / Qt',   matchers: [RX('\\bprotonup(?:[-_ ]?qt)?\\b')] },
  { key: 'obs-capture',    label: 'OBS capture',     matchers: [RX('\\bobs(?:[-_ ]?studio)?\\b')] },
];

// Fault mentions: describe the shape of the failure. Distinct from the
// yes/no fault-category questions on the submit form -- these are text
// signals that let us drill into what actually went wrong.
export const FAULT_PATTERNS = [
  { key: 'crash',          label: 'Crash',           matchers: [RX('\\bcrash(?:es|ed|ing)?\\b'), RX('\\bsegfault\\b'), RX('\\baborts?\\b')] },
  { key: 'hang',           label: 'Hang / freeze',   matchers: [RX('\\bhang(?:s|ing|ed)?\\b'), RX('\\bfreez(?:e|es|ing|ed)\\b'), RX('\\block(?:s|ed|ing)? up\\b')] },
  { key: 'stutter',        label: 'Stutter / hitch', matchers: [RX('\\bstutter(?:s|ing|ed)?\\b'), RX('\\bhitch(?:es|ing|ed)?\\b'), RX('\\bmicro[-_ ]?stutter\\b')] },
  { key: 'artifact',       label: 'Graphics artifact', matchers: [RX('\\bartifacts?\\b'), RX('\\btexture[-_ ]?flicker(?:ing)?\\b'), RX('\\bcorrupt(?:ed|ion)?\\b')] },
  { key: 'tearing',        label: 'Screen tearing',  matchers: [RX('\\bscreen[-_ ]?tearing\\b'), RX('\\btearing\\b')] },
  { key: 'cutscene-hang',  label: 'Cutscene hang',   matchers: [RX('\\bcut[-_ ]?scene\\b.{0,20}(?:hang|freez|black)'), RX('\\bfmv\\b.{0,20}(?:hang|freez|black)')] },
  { key: 'audio-crackle',  label: 'Audio crackle',   matchers: [RX('\\baudio\\b.{0,15}(?:crackl|pop|hiss|stutter)'), RX('\\bcrackling\\b')] },
  { key: 'audio-missing',  label: 'Audio missing',   matchers: [RX('\\bno[-_ ]?(?:audio|sound)\\b'), RX('\\baudio\\b.{0,10}missing\\b')] },
  { key: 'mouse-jitter',   label: 'Mouse jitter',    matchers: [RX('\\bmouse\\b.{0,15}(?:jitter|acceleration|lag)\\b'), RX('\\braw[-_ ]?input\\b.{0,15}(?:missing|broken)\\b')] },
  { key: 'controller-drift', label: 'Controller drift', matchers: [RX('\\bcontroller\\b.{0,15}drift'), RX('\\bstick\\b.{0,15}drift')] },
];

// Tinkering method mentions -- what did the reporter actually do to get the
// game working. Overlaps with the tinkeringMethods checkbox on the submit
// form but this is text scanning so it can pull signal out of the notes.
export const TINKERING_PATTERNS = [
  { key: 'launch-options', label: 'Launch options',  matchers: [RX('\\blaunch[-_ ]?options?\\b'), RX('\\bset[-_ ]?launch\\b')] },
  { key: 'winetricks',     label: 'winetricks',      matchers: [RX('\\bwinetricks\\b')] },
  { key: 'protonfixes',    label: 'protonfixes',     matchers: [RX('\\bprotonfixes\\b')] },
  { key: 'protontricks',   label: 'protontricks',    matchers: [RX('\\bprotontricks\\b')] },
  { key: 'mf-install',     label: 'Media Foundation', matchers: [RX('\\bmf[-_ ]?install\\b'), RX('\\bmedia[-_ ]?foundation\\b')] },
  { key: 'lutris-script',  label: 'Lutris install script', matchers: [RX('\\blutris\\b.{0,15}script\\b')] },
  { key: 'drop-in-dll',    label: 'Drop-in DLL',     matchers: [RX('\\bdxvk\\b.{0,10}dll\\b'), RX('\\bd3d\\d+\\.dll\\b'), RX('\\bdrop[-_ ]?in\\b.{0,10}dll\\b')] },
  { key: 'proton-override', label: 'Proton override', matchers: [RX('\\bproton_use_wined3d\\b'), RX('\\bWINEDLLOVERRIDES\\b'), RX('\\bDXVK_HUD\\b')] },
];

// Controller mentions. Drives the input-compat panel and the deck-vs-desktop
// controller correlations in the Correlations tab.
export const CONTROLLER_PATTERNS = [
  { key: 'xbox',           label: 'Xbox / xinput',   matchers: [RX('\\bxbox\\b'), RX('\\bxinput\\b')] },
  { key: 'dualshock',      label: 'DualShock',       matchers: [RX('\\bdualshock\\b'), RX('\\bds4\\b'), RX('\\bps4[-_ ]?controller\\b')] },
  { key: 'dualsense',      label: 'DualSense',       matchers: [RX('\\bdualsense\\b'), RX('\\bps5[-_ ]?controller\\b')] },
  { key: 'joycon',         label: 'Joy-Con',         matchers: [RX('\\bjoy[-_ ]?con\\b')] },
  { key: 'switch-pro',     label: 'Switch Pro',      matchers: [RX('\\bswitch[-_ ]pro\\b')] },
  { key: 'trackpad',       label: 'Trackpad',        matchers: [RX('\\btrackpad\\b'), RX('\\btouchpad\\b')] },
  { key: 'gyro',           label: 'Gyro aim',        matchers: [RX('\\bgyro\\b')] },
];

// Online / networking signals. Anti-cheat + DRM are load-bearing for the
// Correlations tab (they're a leading cause of borked ratings).
export const ONLINE_NET_PATTERNS = [
  { key: 'eac',            label: 'Easy Anti-Cheat', matchers: [RX('\\beasy[-_ ]?anti[-_ ]?cheat\\b'), RX('\\beac\\b')] },
  { key: 'battleye',       label: 'BattlEye',        matchers: [RX('\\bbattl?eye\\b')] },
  { key: 'denuvo',         label: 'Denuvo',          matchers: [RX('\\bdenuvo\\b')] },
  { key: 'always-online',  label: 'Always-online',   matchers: [RX('\\balways[-_ ]?online\\b')] },
  { key: 'matchmaking',    label: 'Matchmaking',     matchers: [RX('\\bmatchmaking\\b')] },
  { key: 'multiplayer',    label: 'Multiplayer',     matchers: [RX('\\bmultiplayer\\b'), RX('\\bmp\\b')] },
];

// Reserved for phase E (My Library correlations). Hardware / driver / OS
// buckets are structural, not text-scanning: reports carry these as
// dedicated columns, but downstream code should still route through this
// module so the bucket labels stay consistent.
export const HARDWARE_ARCH_KEYS = ['nvidia', 'amd', 'intel'];
export const DRIVER_FAMILY_KEYS  = ['mesa', 'amdvlk', 'nvidia-driver', 'radv'];
export const OS_BASE_KEYS        = ['steamos', 'arch', 'fedora', 'ubuntu', 'nobara', 'debian', 'opensuse'];

/**
 * Match a single free-text string against a pattern group. Returns a Set of
 * keys whose matchers hit. Duplicate matcher hits for the same key collapse.
 * @param {string} text
 * @param {Array<{key:string, matchers:RegExp[]}>} group
 * @returns {Set<string>}
 */
export function matchGroup(text, group) {
  const hits = new Set();
  if (!text || !Array.isArray(group)) return hits;
  const s = String(text);
  for (const { key, matchers } of group) {
    for (const rx of (matchers || [])) {
      if (rx.test(s)) { hits.add(key); break; }
    }
  }
  return hits;
}

/**
 * Match a report's user-authored text fields against a pattern group. Pulls
 * notes, launch_options, and every text-typed form_responses field, unions
 * the matches. Keeps report normalisation here so phases B/C/E stay dumb.
 * @param {object} report
 * @param {Array} group
 * @returns {Set<string>}
 */
export function matchReport(report, group) {
  if (!report) return new Set();
  const parts = [
    report.notes,
    report.launchOptions,
    report.launch_options,
  ];
  const fr = report.formResponses || report.form_responses;
  if (fr && typeof fr === 'object') {
    for (const [k, v] of Object.entries(fr)) {
      if (typeof v === 'string' && /notes?$|summary$/i.test(k)) parts.push(v);
    }
  }
  return matchGroup(parts.filter(Boolean).join(' \n '), group);
}

/**
 * Small convenience for stats aggregation: given a list of reports and a
 * group, returns a Map<key, count> of how many reports mention each pattern.
 * @param {Array<object>} reports
 * @param {Array} group
 * @returns {Map<string, number>}
 */
export function countReportsByPattern(reports, group) {
  const counts = new Map();
  if (!Array.isArray(reports) || !Array.isArray(group)) return counts;
  for (const { key } of group) counts.set(key, 0);
  for (const r of reports) {
    for (const key of matchReport(r, group)) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}
