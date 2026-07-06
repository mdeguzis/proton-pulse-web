/**
 * Tests for js/shared/analytics-patterns.js (#205, umbrella #204).
 *
 * Every group gets shape checked (each entry has key, label, matchers) plus
 * one positive and one negative case per entry. Positive: text that MUST
 * match. Negative: text that must NOT match, chosen to catch the common
 * substring-vs-word-boundary bug (e.g. 'gamemode' matching 'gamemodeless').
 */

// Module has no imports beyond RegExp so babel-jest can require it directly.
const mod = require('../js/shared/analytics-patterns.js');
const {
  OPTIMIZATION_PATTERNS,
  FAULT_PATTERNS,
  TINKERING_PATTERNS,
  CONTROLLER_PATTERNS,
  ONLINE_NET_PATTERNS,
  matchGroup,
  matchReport,
  countReportsByPattern,
} = mod;
const GROUPS_MAP = {
  OPTIMIZATION_PATTERNS, FAULT_PATTERNS, TINKERING_PATTERNS,
  CONTROLLER_PATTERNS, ONLINE_NET_PATTERNS,
};

const GROUPS = [
  'OPTIMIZATION_PATTERNS',
  'FAULT_PATTERNS',
  'TINKERING_PATTERNS',
  'CONTROLLER_PATTERNS',
  'ONLINE_NET_PATTERNS',
];

// Positive/negative cases keyed by the group's key column. Every entry in
// every exported group MUST appear here so a new pattern without a test
// fails the sanity block below.
const CASES = {
  // OPTIMIZATION_PATTERNS
  'proton-ge':      { yes: 'Ran with Proton-GE 9-20', no: 'proton ge9' },
  'proton-tkg':     { yes: 'Using proton-tkg', no: 'proton tkgu' },
  'proton-cachyos': { yes: 'Proton-CachyOS 9', no: 'proton cachy' },
  'gamemode':       { yes: 'gamemoderun %command%', no: 'gamemodeless design' },
  'mangohud':       { yes: 'MangoHud=1 %command%', no: 'nomangohud' },
  'gamescope':      { yes: 'gamescope -w 1280', no: 'gamescoped' },
  'dxvk-async':     { yes: 'DXVK-async 1', no: 'dxvk works fine' /* plain dxvk without async marker */ },
  'vkbasalt':       { yes: 'enabled vkBasalt', no: 'basalt rock' },
  'nis':            { yes: 'NVIDIA image scaling on', no: 'nis boot' /* no nvidia/scale nearby */ },
  'dlss':           { yes: 'DLSS quality mode', no: 'dlssbench' },
  'fsr':            { yes: 'FSR 2.1 upscale', no: 'fsroot' },
  'xess':           { yes: 'XeSS on ultra', no: 'xessed on' },
  'protonup':       { yes: 'installed via protonup-qt', no: 'protonupdate' },
  'obs-capture':    { yes: 'OBS-Studio game capture', no: 'obscure' },

  // FAULT_PATTERNS
  'crash':          { yes: 'Crashes on boot', no: 'crashless build' },
  'hang':           { yes: 'hangs at loading', no: 'overhang bracket' },
  'stutter':        { yes: 'micro stutter every 30s', no: 'no problems here' },
  'artifact':       { yes: 'texture artifacts everywhere', no: 'artefaction' },
  'tearing':        { yes: 'screen tearing without vsync', no: 'tearingly' },
  'cutscene-hang':  { yes: 'cutscene hangs the game', no: 'cutscene played' },
  'audio-crackle':  { yes: 'audio crackles constantly', no: 'audiobook' },
  'audio-missing':  { yes: 'no audio at all', no: 'audio playing fine' },
  'mouse-jitter':   { yes: 'mouse jitter in menus', no: 'mouseover tooltip' },
  'controller-drift': { yes: 'controller drift on left stick', no: 'controller works' },

  // TINKERING_PATTERNS
  'launch-options': { yes: 'set launch options', no: 'no options here' },
  'winetricks':     { yes: 'winetricks vcrun2019', no: 'wine tricky' },
  'protonfixes':    { yes: 'protonfixes handled it', no: 'protonfix' /* no plural */ },
  'protontricks':   { yes: 'protontricks vcrun', no: 'proton tricks separated' /* space-separated should NOT match */ },
  'mf-install':     { yes: 'ran mf-install', no: 'mfg install' },
  'lutris-script':  { yes: 'lutris install script needed', no: 'lutris only' },
  'drop-in-dll':    { yes: 'drop-in dll fix worked', no: 'dropdown' },
  'proton-override': { yes: 'WINEDLLOVERRIDES=xaudio2_7=n', no: 'no overrides' },

  // CONTROLLER_PATTERNS
  'xbox':           { yes: 'xbox controller works', no: 'xboxlessly' },
  'dualshock':      { yes: 'DualShock 4 detected', no: 'shock absorber' },
  'dualsense':      { yes: 'DualSense native', no: 'dual sensor' /* space-separated should not match */ },
  'joycon':         { yes: 'joy-con pairing', no: 'joyfulcon' },
  'switch-pro':     { yes: 'switch pro controller', no: 'switchpro cable' /* smashed together should not match with word boundary */ },
  'trackpad':       { yes: 'trackpad works fine', no: 'tracker' },
  'gyro':           { yes: 'gyro aim helps', no: 'gyroscope-ish' /* -ish is fine, gyroscope shouldn't match either since word boundary is on gyro */ },

  // ONLINE_NET_PATTERNS
  'eac':            { yes: 'Easy Anti-Cheat prevents launch', no: 'each of these' },
  'battleye':       { yes: 'BattlEye blocks it', no: 'battle eye separated' /* space-separated shouldn't match */ },
  'denuvo':         { yes: 'denuvo layer complains', no: 'denuvos' /* would match, so make sure the negative is truly negative */ },
  'always-online':  { yes: 'always-online requirement', no: 'always offline' },
  'matchmaking':    { yes: 'matchmaking works', no: 'match making time' /* space-separated */ },
  'multiplayer':    { yes: 'multiplayer session', no: 'multiplayerless' },
};

describe('analytics-patterns module shape', () => {
  test.each(GROUPS)('%s is an array of well-formed entries', (name) => {
    const group = GROUPS_MAP[name];
    expect(Array.isArray(group)).toBe(true);
    expect(group.length).toBeGreaterThan(0);
    for (const entry of group) {
      expect(typeof entry.key).toBe('string');
      expect(entry.key.length).toBeGreaterThan(0);
      expect(typeof entry.label).toBe('string');
      expect(Array.isArray(entry.matchers)).toBe(true);
      expect(entry.matchers.length).toBeGreaterThan(0);
      for (const m of entry.matchers) expect(m).toBeInstanceOf(RegExp);
    }
  });

  test('every group key has a positive+negative case defined', () => {
    for (const name of GROUPS) {
      for (const { key } of GROUPS_MAP[name]) {
        expect(CASES).toHaveProperty(key);
        expect(typeof CASES[key].yes).toBe('string');
        expect(typeof CASES[key].no).toBe('string');
      }
    }
  });
});

describe('matchGroup positive/negative per pattern', () => {
  // Flatten every (group, pattern-key) pair with its positive+negative case.
  const rows = [];
  for (const name of GROUPS) {
    for (const { key } of GROUPS_MAP[name]) {
      rows.push([name, key, CASES[key].yes, CASES[key].no]);
    }
  }
  test.each(rows)('%s / %s positive+negative', (name, key, yes, no) => {
    const group = GROUPS_MAP[name];
    const yesHits = matchGroup(yes, group);
    const noHits  = matchGroup(no, group);
    expect(yesHits.has(key)).toBe(true);
    expect(noHits.has(key)).toBe(false);
  });
});

describe('matchReport unions across free-text fields', () => {
  test('sweeps notes, launch_options, and *Notes form_responses', () => {
    const report = {
      notes: 'crashes without gamemode',
      launchOptions: 'MANGOHUD=1 gamemoderun %command%',
      formResponses: {
        generalNotes: 'DXVK-async helped a lot',
        performanceFaultsNotes: 'small stutters every minute',
      },
    };
    const opt = matchReport(report, OPTIMIZATION_PATTERNS);
    expect(opt.has('gamemode')).toBe(true);
    expect(opt.has('mangohud')).toBe(true);
    expect(opt.has('dxvk-async')).toBe(true);
    const fault = matchReport(report, FAULT_PATTERNS);
    expect(fault.has('crash')).toBe(true);
    expect(fault.has('stutter')).toBe(true);
  });

  test('supports snake_case fields from the raw REST shape', () => {
    const report = {
      notes: '',
      launch_options: 'protontricks vcrun',
      form_responses: { general_notes: 'no problems' },
    };
    const tink = matchReport(report, TINKERING_PATTERNS);
    expect(tink.has('protontricks')).toBe(true);
  });

  test('empty / missing report yields empty set', () => {
    expect(matchReport(null, FAULT_PATTERNS).size).toBe(0);
    expect(matchReport({}, FAULT_PATTERNS).size).toBe(0);
  });
});

describe('countReportsByPattern aggregation', () => {
  test('counts each pattern once per report', () => {
    const reports = [
      { notes: 'gamemoderun and mangohud both help' },
      { notes: 'gamemoderun again' },
      { notes: 'no tweaks' },
    ];
    const counts = countReportsByPattern(reports, OPTIMIZATION_PATTERNS);
    expect(counts.get('gamemode')).toBe(2);
    expect(counts.get('mangohud')).toBe(1);
    expect(counts.get('gamescope')).toBe(0);
  });

  test('initialises all keys to 0 even when no report mentions them', () => {
    const counts = countReportsByPattern([], OPTIMIZATION_PATTERNS);
    for (const { key } of OPTIMIZATION_PATTERNS) {
      expect(counts.get(key)).toBe(0);
    }
  });
});
