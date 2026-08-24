// deck-status (components) for the app page. Relocated from app.js.

import { getDeckStatusForApp } from '../api/deck-status.js?v=c941cca9';
import { esc } from '../utils.js?v=4630c3d5';
import { VRDB_RATINGS, vrRuntimeLabel, vrdbRatingColor } from '../../shared/vr.js?v=8759ee7d';

export const DECK_STATUS_LABELS = {
  verified:    'Verified',
  playable:    'Playable',
  unsupported: 'Unsupported',
  unknown:     'Unknown',
};
export const DECK_CRITERIA_LABELS = [
  'All functionality is accessible when using the default controller configuration',
  'This game shows Steam Deck controller icons',
  'In-game interface text is legible on Steam Deck',
  'This game\'s default graphics configuration performs well on Steam Deck',
];

// Human-readable labels for Steam Machine + SteamOS resolved_items (see #273
// follow-up). The pipeline strips the `#SteamMachine_TestResult_` /
// `#SteamOS_TestResult_` prefix before storing, so keys here are already
// short. Any token missing from the map falls back to camelCase-to-prose
// conversion via `_tokenToProse` so a new Valve token still reads reasonably
// even before we hand-tune its label.
export const CRITERIA_TOKEN_LABELS = {
  // Steam Machine
  DefaultControllerConfigNotFullyFunctional: 'Some functionality is not accessible when using the default controller configuration, requiring use of the touchscreen or virtual keyboard, or a community configuration',
  DefaultControllerConfigFullyFunctional: 'All functionality is accessible when using the default controller configuration',
  ControllerGlyphsDoNotMatchDevice: 'This game sometimes shows mouse, keyboard, or non-Steam controller icons',
  ControllerGlyphsMatchDevice: 'This game shows Steam Machine controller icons',
  DefaultConfigurationIsPerformant: "This game's default graphics configuration performs well on Steam Machine",
  DefaultConfigurationIsNotPerformant: "This game's default graphics configuration does not perform well on Steam Machine",
  ExternalControllersNotSupportedPrimaryPlayer: 'This game does not default to external Bluetooth/USB controllers, and may require manually switching the active controller',
  // SteamOS
  GameStartupFunctional: 'This game runs successfully on SteamOS',
  GameStartupNotFunctional: 'This game does not start successfully on SteamOS',
  InterfaceTextIsLegible: 'In-game interface text is legible',
  InterfaceTextIsNotLegible: 'Some in-game text is small and may be difficult to read',
};

export function _tokenToProse(tok) {
  if (!tok || typeof tok !== 'string') return '';
  // Split CamelCase on capital boundaries + digit runs, e.g.
  // "DefaultControllerConfigNotFullyFunctional" -> "Default controller config not fully functional"
  const words = tok
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function _criterionLabel(tok) {
  return CRITERIA_TOKEN_LABELS[tok] || _tokenToProse(tok);
}

// display_type → status key for the round icon: 4=pass, 3=info/caveat, 1/2=fail.
// Matches DECK_DISPLAY_MAP in the pipeline + api/deck-status.js. Used only as a
// last-resort fallback now -- see _iconKeyForCriterion for why the token wins.
export function _iconKeyForDisplayType(dt) {
  if (dt === 4) return 'verified';
  if (dt === 3) return 'playable';
  return 'unsupported';
}

// Per-criterion outcome by token. Valve's `display_type` is NOT consistent
// across the Deck / Machine / SteamOS reports: on SteamOS `GameStartupFunctional`
// comes back display_type=3 but reads as a pass (green check), and the two
// controller caveats come back display_type=1 but read as info ("i"), not
// failures. Deck/Machine use 4=pass, 3=info. So the token is the reliable
// signal for the icon; display_type is only a fallback. Values: pass | info | fail.
export const CRITERIA_TOKEN_OUTCOME = {
  DefaultControllerConfigFullyFunctional: 'pass',
  DefaultControllerConfigNotFullyFunctional: 'info',
  ControllerGlyphsMatchDevice: 'pass',
  ControllerGlyphsDoNotMatchDevice: 'info',
  DefaultConfigurationIsPerformant: 'pass',
  DefaultConfigurationIsNotPerformant: 'info',
  ExternalControllersNotSupportedPrimaryPlayer: 'info',
  GameStartupFunctional: 'pass',
  GameStartupNotFunctional: 'fail',
  InterfaceTextIsLegible: 'pass',
  InterfaceTextIsNotLegible: 'info',
};
const _OUTCOME_ICON = { pass: 'verified', info: 'playable', fail: 'unsupported' };

// Pick the round icon for one Machine/SteamOS criterion. Curated token map
// first (matches Valve's store modals exactly), then a name heuristic so a new
// token still reads sensibly ("...NotFunctional" fails, other "...Not..." /
// "DoNot..." caveats show info, anything else passes), then display_type.
export function _iconKeyForCriterion(displayType, tok) {
  const outcome = CRITERIA_TOKEN_OUTCOME[tok];
  if (outcome) return _OUTCOME_ICON[outcome];
  if (typeof tok === 'string' && tok) {
    if (/NotFunctional/i.test(tok)) return 'unsupported';
    if (/(?:^|[a-z])(?:DoNot|Not)[A-Z]/.test(tok) || /Not[A-Z]/.test(tok)) return 'playable';
    return 'verified';
  }
  return _iconKeyForDisplayType(displayType);
}

// Steam's resolved_category values: 0=unknown, 1=unsupported, 2=playable, 3=verified

export const DECK_STATUS_ICON_SVG = {
  verified:    '<circle cx="12" cy="12" r="10" fill="#5ba32b"/><path d="M8 12.5 11 15.5 16 9.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  playable:    '<circle cx="12" cy="12" r="10" fill="#d4a72c"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" fill="#0a0c10" font-family="serif">i</text>',
  compatible:  '<circle cx="12" cy="12" r="10" fill="#3a7fc8"/><path d="M8 12.5 11 15.5 16 9.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  unsupported: '<circle cx="12" cy="12" r="10" fill="#c84a4a"/><path d="M8 8 16 16 M16 8 8 16" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  unknown:     '<circle cx="12" cy="12" r="10" fill="rgba(120,120,120,0.45)" stroke="rgba(255,255,255,0.25)" stroke-width="1"/><text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="serif">?</text>',
};

// SteamOS uses Compatible instead of Deck's Verified/Playable scale (#273).
export const STEAMOS_STATUS_LABELS = {
  compatible: 'Compatible', unsupported: 'Unsupported', unknown: 'Unknown',
};
const _DEVICE_SUMMARY = {
  deck: {
    verified:    'This game is <strong>Verified</strong> on Steam Deck. Fully functional with the built-in controls and display.',
    playable:    'This game is <strong>Playable</strong> on Steam Deck. Functional, but may require extra effort to interact with or configure.',
    unsupported: 'This game is <strong>not supported</strong> on Steam Deck. Will not run, or critical features are unavailable.',
    unknown:     'Steam Deck compatibility is <strong>Unknown</strong>. Valve has not evaluated this title yet.',
    nodata:      'We do not have a Steam Deck verdict for this title yet. Check the store page for Valve\'s current rating.',
  },
  machine: {
    verified:    'This game is <strong>Verified</strong> on Steam Machine. Fully functional out of the box.',
    playable:    'This game is <strong>Playable</strong> on Steam Machine. Functional, but may require some configuration.',
    unsupported: 'This game is <strong>not supported</strong> on Steam Machine.',
    unknown:     'Steam Machine compatibility is <strong>Unknown</strong>. Valve has not evaluated this title yet.',
    nodata:      'We do not have a Steam Machine verdict for this title yet. Check the store page for Valve\'s current rating.',
  },
  steamos: {
    compatible:  'This game is <strong>Compatible</strong> with devices running SteamOS, based on Steam Deck verification results. Performance and input may vary by hardware.',
    unsupported: 'This game is <strong>not supported</strong> on SteamOS.',
    unknown:     'SteamOS compatibility is <strong>Unknown</strong>. Valve has not evaluated this title yet.',
    nodata:      'We do not have a SteamOS verdict for this title yet. Check the store page for Valve\'s current rating.',
  },
};

export function renderDeckStatusButton(appId) {
  const { status } = getDeckStatusForApp(appId);
  const label = DECK_STATUS_LABELS[status] || 'Unknown';
  // Unsupported has no deeper modal content to surface beyond the criteria
  // list - keep the button clickable so users still see the explanation, but
  // tag it visually so it reads as "definitively negative"
  const disabledClass = status === 'unsupported' ? ' deck-status-btn-unsupported' : '';
  // Label is "Compatibility", not "Steam Deck": the modal behind it covers
  // Steam Deck, Steam Machine, SteamOS and (when we have data) VR on Linux,
  // so naming it after one tab undersells the other three. The coloured icon
  // still encodes the DECK status, which is the headline verdict, and the
  // title attribute spells it out.
  return `<button class="info-btn info-btn-labeled deck-status-btn${disabledClass}" id="deck-status-btn" title="Steam Deck: ${label} (click for Deck, Machine, SteamOS and VR details)">
    <svg width="16" height="16" viewBox="0 0 24 24">${DECK_STATUS_ICON_SVG[status] || DECK_STATUS_ICON_SVG.unknown}</svg>
    <span>Compatibility</span>
  </button>`;
}

function _statusLabel(kind, status) {
  const labels = kind === 'steamos' ? STEAMOS_STATUS_LABELS : DECK_STATUS_LABELS;
  return labels[status] || 'Unknown';
}

function _tabLabel(id, iconId, name, status) {
  return `<label for="dt-${id}" class="dt-tab" title="${esc(name)}: ${esc(_statusLabel(id, status))}">
    <svg class="dt-tab-glyph" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><use href="#${iconId}"/></svg>
    <span class="dt-tab-name">${esc(name)}</span>
    <svg class="dt-tab-badge" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">${DECK_STATUS_ICON_SVG[status] || DECK_STATUS_ICON_SVG.unknown}</svg>
  </label>`;
}

// One device panel: heading + verdict badge + summary + per-criterion checklist.
// Steam Deck's checklist comes from the four-point boolean `criteria` array
// (fixed order, hand-wrote labels). Machine + SteamOS ship variable-length
// `[[display_type, short_token], ...]` arrays; we look up the token in
// CRITERIA_TOKEN_LABELS and fall back to camelCase-to-prose conversion so a
// new Valve token still reads reasonably even before we tune the label.
function _devicePanel(kind, name, status, criteria, tokenizedCriteria, hasData = true) {
  const label = _statusLabel(kind, status);
  // A missing entry is not a Valve verdict. Only claim Valve rated something
  // Unknown when the fetch actually returned that; otherwise say we have no
  // data and point at the store page.
  const summaryKey = (!hasData && status === 'unknown') ? 'nodata' : status;
  const summary = (_DEVICE_SUMMARY[kind] || {})[summaryKey] || '';
  let body = '';
  if (kind === 'deck' && Array.isArray(criteria)) {
    body = `<div class="deck-criteria-list">${criteria.map((pass, i) => {
      const iconKey = pass === true ? 'verified' : pass === false ? 'unsupported' : 'playable';
      return `<div class="deck-criterion"><span class="deck-criterion-icon"><svg width="18" height="18" viewBox="0 0 24 24">${DECK_STATUS_ICON_SVG[iconKey]}</svg></span><span>${esc(DECK_CRITERIA_LABELS[i])}</span></div>`;
    }).join('')}</div>`;
  } else if ((kind === 'machine' || kind === 'steamos') && Array.isArray(tokenizedCriteria) && tokenizedCriteria.length) {
    body = `<div class="deck-criteria-list">${tokenizedCriteria.map(([dt, tok]) => {
      const iconKey = _iconKeyForCriterion(dt, tok);
      return `<div class="deck-criterion"><span class="deck-criterion-icon"><svg width="18" height="18" viewBox="0 0 24 24">${DECK_STATUS_ICON_SVG[iconKey]}</svg></span><span>${esc(_criterionLabel(tok))}</span></div>`;
    }).join('')}</div>`;
  } else {
    const sourceNote = status !== 'unknown'
      ? "Source: Valve's official compatibility report."
      : hasData
        ? 'Valve has not published a verdict for this title yet.'
        : 'Not yet fetched by our pipeline. This is not a statement about how the game runs.';
    body = `<p class="dt-source">${sourceNote}</p>`;
  }
  return `
    <h3 style="margin:0 0 8px;font-size:0.95rem;color:var(--strong)">${esc(name)} Compatibility: <span class="deck-status-badge deck-status-${status}">${label}</span></h3>
    <p style="color:var(--muted);font-size:0.84rem;margin:0 0 12px;line-height:1.5">${summary}</p>
    ${body}`;
}

// Three-tab compatibility modal (Deck / Machine / SteamOS), like Valve's own
// (#273). Pure CSS tabs (radio-driven) so it needs no JS wiring and survives
// the re-render after the async deck fetch resolves.
export function renderDeckStatusModalContent(appId) {
  const d = getDeckStatusForApp(appId);
  const deckStatus = d.status || 'unknown';
  const machineStatus = d.machine || 'unknown';
  const osStatus = d.steamos || 'unknown';
  // #246: VR on Linux joins the device tabs. It is the same question the other
  // three answer ("will this run on my hardware"), and it was buried in the
  // Metadata modal where nobody looking for compatibility would find it.
  // The panel body fills in asynchronously -- vrdb.json is a separate fetch
  // and the modal must not wait on it to open.
  return `
    <div class="deck-tabs">
      <input type="radio" name="devtab" id="dt-deck" class="dt-radio" checked>
      <input type="radio" name="devtab" id="dt-machine" class="dt-radio">
      <input type="radio" name="devtab" id="dt-steamos" class="dt-radio">
      <input type="radio" name="devtab" id="dt-vr" class="dt-radio">
      <div class="dt-tabbar" role="tablist">
        ${_tabLabel('deck', 'icon-steam-deck', 'Steam Deck', deckStatus)}
        ${_tabLabel('machine', 'icon-steam-machine', 'Steam Machine', machineStatus)}
        ${_tabLabel('steamos', 'icon-steamos', 'SteamOS', osStatus)}
        <label for="dt-vr" class="dt-tab dt-tab--vr" title="VR on Linux" id="dt-vr-tab" hidden>
          <svg class="dt-tab-glyph" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 8h18a1 1 0 0 1 1 1v5a3 3 0 0 1-3 3h-3.2a2 2 0 0 1-1.7-.9l-1.3-2a1 1 0 0 0-1.6 0l-1.3 2a2 2 0 0 1-1.7.9H5a3 3 0 0 1-3-3V9a1 1 0 0 1 1-1z"/></svg>
          <span class="dt-tab-name">VR on Linux</span>
        </label>
      </div>
      <div class="dt-panel dt-panel-deck">${_devicePanel('deck', 'Steam Deck', deckStatus, d.criteria, null, d.hasData !== false)}</div>
      <div class="dt-panel dt-panel-machine">${_devicePanel('machine', 'Steam Machine', machineStatus, null, d.machine_criteria, d.hasData !== false)}</div>
      <div class="dt-panel dt-panel-steamos">${_devicePanel('steamos', 'SteamOS', osStatus, null, d.steamos_criteria, d.hasData !== false)}</div>
      <div class="dt-panel dt-panel-vr" id="dt-panel-vr"></div>
    </div>`;
}

/**
 * Fill the VR on Linux tab, and reveal it only when VRDB has reports.
 *
 * Kept out of renderDeckStatusModalContent because that function is
 * synchronous (it renders off the in-memory deck cache so the modal opens
 * instantly) while VRDB is a separate fetch. A game with no VRDB entry keeps
 * three tabs rather than showing an empty fourth.
 *
 * @param {Element} root - The rendered modal content.
 * @param {object|null} entry - VRDB game record, or null when we have none.
 * @param {string|number} appId - Steam app id, for the deep link.
 */
export function fillVrOnLinuxTab(root, entry, appId) {
  if (!root) return;
  const tab = root.querySelector('#dt-vr-tab');
  const panel = root.querySelector('#dt-panel-vr');
  if (!tab || !panel) return;
  const runtimes = entry && entry.runtimes && typeof entry.runtimes === 'object' ? entry.runtimes : null;
  const rows = runtimes ? Object.entries(runtimes) : [];
  if (!rows.length) return;   // no data: leave the tab hidden

  // Best rating first so the most promising runtime leads.
  rows.sort((a, b) => (Number(a[1]?.best) || 9) - (Number(b[1]?.best) || 9));
  const body = rows.map(([runtime, stats]) => {
    const best = Number(stats?.best);
    const count = Number(stats?.count) || 0;
    return `<div class="gm-vr-row">
      <span class="gm-vr-runtime">${esc(vrRuntimeLabel(runtime))}</span>
      <span class="gm-vr-rating" style="background:${vrdbRatingColor(best)}">${esc(VRDB_RATINGS[best] || 'Unrated')}</span>
      <span class="gm-mute">${count} report${count === 1 ? '' : 's'}</span>
    </div>`;
  }).join('');
  const devices = Array.isArray(entry.devices) && entry.devices.length
    ? `<div class="gm-chips" style="margin-top:8px">${entry.devices.slice(0, 8).map(dv => `<span class="gm-chip">${esc(dv)}</span>`).join('')}</div>`
    : '';
  const latest = entry.latest ? ` \u00b7 latest ${esc(String(entry.latest))}` : '';
  const url = `https://db.vronlinux.org/games/${encodeURIComponent(String(appId))}.html`;
  panel.innerHTML = `
    <h3 style="margin:0 0 8px;font-size:0.95rem;color:var(--strong)">VR on Linux</h3>
    <p style="color:var(--muted);font-size:0.84rem;margin:0 0 12px;line-height:1.5">
      Community reports per VR runtime. Their scale runs 1 = best, the opposite way to a Pulse tier, so it is shown with their own labels and never mixed into our scoring.
    </p>
    ${body}${devices}
    <p class="dt-source" style="margin-top:8px">Source: <a href="${esc(url)}" target="_blank" rel="noopener">VR on Linux DB</a> (MIT)${latest}</p>`;
  tab.hidden = false;
}

// - Author / signals / permalink helpers --------------
//
// New card chrome: a left "author" column with avatar + identity, a row of
// icon-square "signal" indicators inline with the report body (install /
// verdict / OOB / tinker / Deck / owns / framegen), and a permalink button
// on the right column. Phase 1 - no Steam profile fetch yet, so anonymous
// Decky-plugin reports get the Proton Pulse atom icon plus a "Plugin user"
// label with their truncated client_id.

// Inline atom SVG matching the topbar brand mark. currentColor inherits the
// surrounding text color so the same blob works at any size or hue.

export const _DECK_LCD_RE  = /\b(amd\s+custom\s+(apu|gpu)\s+0405|vangogh)\b/i;
export const _DECK_OLED_RE = /\b(amd\s+custom\s+(apu|gpu)\s+0932|sephiroth)\b/i;
// Steam Machine (#273): provisional fingerprint. The real APU/GPU revision
// string is unknown until the device ships, so match an explicit "Steam
// Machine" mention plus the semi-custom Zen 4 + RDNA 3 signature. Mirrors
// _STEAM_MACHINE in scripts/pipeline/stats.py -- keep in sync.
export const _STEAM_MACHINE_RE = /\bsteam\s+machine\b|amd\s+custom\s+(apu|gpu).*rdna\s*3/i;
export function isSteamDeckHardware(r) {
  const haystack = `${r.cpu || ''} ${r.gpu || ''}`;
  return _DECK_LCD_RE.test(haystack) || _DECK_OLED_RE.test(haystack);
}

// Steam Machine detection (#255 Phase 2). Valve's late-2025 SFF SteamOS box.
// Uses _STEAM_MACHINE_RE above -- the same pattern game-page.js filters on and
// the mirror of _STEAM_MACHINE in scripts/pipeline/stats.py, so all three
// surfaces answer this question identically (#496).
//
// This used to test a separate _MACHINE_APU_RE that matched only the literal
// words "steam machine", against a haystack that included `r.webSource`. Real
// APU strings do not contain those words -- a Deck reports "AMD Custom APU
// 0405", not "Steam Deck" -- and nothing ever set webSource: no column, no
// pipeline write, no submit-form dropdown, despite a comment here claiming
// one existed. So it could not return true for any real report, while the
// game page and the pipeline were already matching the RDNA 3 signature.
export function isSteamMachineHardware(r) {
  const haystack = `${r.cpu || ''} ${r.gpu || ''}`;
  return _STEAM_MACHINE_RE.test(haystack);
}

// SVG path data for each signal icon. Drawn at 24x24 viewBox. Currentcolor
// fills/strokes so we don't have to define per-icon color.
