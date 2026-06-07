// deck-status module for the app page. Relocated from app.js.

import { esc } from './utils.js';

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

// Steam's resolved_category values: 0=unknown, 1=unsupported, 2=playable, 3=verified
export const DECK_CAT_MAP = { 0: 'unknown', 1: 'unsupported', 2: 'playable', 3: 'verified' };
// display_type in resolved_items: 2=fail, 3=info/caveat, 4=pass
export const DECK_DISPLAY_MAP = { 4: true, 3: null, 2: false };

// cache fetched deck compat so we dont re-fetch on every render
export const _deckCache = {};

export async function fetchDeckStatusForApp(appId) {
  if (!appId) return { status: 'unknown', criteria: null };
  if (_deckCache[appId]) return _deckCache[appId];
  try {
    const r = await fetch(`https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appId}`);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (!d.success) throw new Error('no data');
    const cat = d.results?.resolved_category ?? 0;
    const status = DECK_CAT_MAP[cat] || 'unknown';
    // map each resolved_item to a true/false/null criterion result
    const items = d.results?.resolved_items || [];
    const criteria = items.length >= 4
      ? items.slice(0, 4).map(i => DECK_DISPLAY_MAP[i.display_type] ?? null)
      : null;
    const ret = { status, criteria };
    _deckCache[appId] = ret;
    return ret;
  } catch {
    const ret = { status: 'unknown', criteria: null };
    _deckCache[appId] = ret;
    return ret;
  }
}

// synchronous fallback used for initial render before the async fetch returns
export function getDeckStatusForApp(appId) {
  return _deckCache[appId] || { status: 'unknown', criteria: null };
}

// cache fetched system requirements
export const _reqsCache = {};

export async function fetchMinRequirements(appId) {
  if (!appId) return null;
  if (_reqsCache[appId] !== undefined) return _reqsCache[appId];
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const app = d?.[appId]?.data;
    if (!app) { _reqsCache[appId] = null; return null; }
    const reqs = app.pc_requirements;
    if (!reqs || (typeof reqs === 'object' && !reqs.minimum)) {
      _reqsCache[appId] = null;
      return null;
    }
    const ret = {
      minimum: reqs.minimum || null,
      recommended: reqs.recommended || null,
    };
    _reqsCache[appId] = ret;
    return ret;
  } catch {
    _reqsCache[appId] = null;
    return null;
  }
}

// Inline SVGs for Deck status icons. All 24x24 viewBox + currentColor so a
// single CSS color rule paints them.
export const DECK_STATUS_ICON_SVG = {
  verified:    '<circle cx="12" cy="12" r="10" fill="#5ba32b"/><path d="M8 12.5 11 15.5 16 9.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  playable:    '<circle cx="12" cy="12" r="10" fill="#d4a72c"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" fill="#0a0c10" font-family="serif">i</text>',
  unsupported: '<circle cx="12" cy="12" r="10" fill="#c84a4a"/><path d="M8 8 16 16 M16 8 8 16" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  unknown:     '<circle cx="12" cy="12" r="10" fill="rgba(120,120,120,0.45)" stroke="rgba(255,255,255,0.25)" stroke-width="1"/><text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="serif">?</text>',
};

export function renderDeckStatusButton(appId) {
  const { status } = getDeckStatusForApp(appId);
  const label = DECK_STATUS_LABELS[status] || 'Unknown';
  // Unsupported has no deeper modal content to surface beyond the criteria
  // list - keep the button clickable so users still see the explanation, but
  // tag it visually so it reads as "definitively negative"
  const disabledClass = status === 'unsupported' ? ' deck-status-btn-unsupported' : '';
  // Button label is just "Steam Deck" - the colored icon already encodes
  // the status (green check, yellow i, red x, gray ?). Full "Steam Deck:
  // Verified" string lives in the modal heading + the title-attr tooltip
  return `<button class="info-btn info-btn-labeled deck-status-btn${disabledClass}" id="deck-status-btn" title="Steam Deck: ${label} (click for details)">
    <svg width="16" height="16" viewBox="0 0 24 24">${DECK_STATUS_ICON_SVG[status] || DECK_STATUS_ICON_SVG.unknown}</svg>
    <span>Steam Deck</span>
  </button>`;
}

// Modal body for the Deck-status popup. Mirrors the Steam Store layout:
// title + summary sentence + per-criterion checklist
export function renderDeckStatusModalContent(appId) {
  const { status, criteria } = getDeckStatusForApp(appId);
  const label = DECK_STATUS_LABELS[status] || 'Unknown';
  const summaryByStatus = {
    verified:    `This game is <strong>Verified</strong> on Steam Deck. Fully functional, works great with the built-in controls and display.`,
    playable:    `This game is <strong>Playable</strong> on Steam Deck. Functional, but may require extra effort to interact with or configure.`,
    unsupported: `This game is <strong>not supported</strong> on Steam Deck. Will not run, or critical features are unavailable.`,
    unknown:     `Steam Deck compatibility for this game is <strong>Unknown</strong>. Valve has not yet evaluated it.`,
  };
  const rows = criteria
    ? criteria.map((pass, i) => {
        const iconKey = pass === true ? 'verified' : pass === false ? 'unsupported' : 'playable';
        return `<div class="deck-criterion">
          <span class="deck-criterion-icon"><svg width="18" height="18" viewBox="0 0 24 24">${DECK_STATUS_ICON_SVG[iconKey]}</svg></span>
          <span>${esc(DECK_CRITERIA_LABELS[i])}</span>
        </div>`;
      }).join('')
    : '<p style="color:var(--muted);font-size:0.84rem;margin:0">No per-criterion data available for this title.</p>';
  return `
    <h3 style="margin:0 0 8px;font-size:0.95rem;color:var(--strong)">
      Steam Deck Compatibility:
      <span class="deck-status-badge deck-status-${status}">${label}</span>
    </h3>
    <p style="color:var(--muted);font-size:0.84rem;margin:0 0 12px;line-height:1.5">${summaryByStatus[status] || ''}</p>
    <div class="deck-criteria-list">${rows}</div>
    <p style="color:var(--muted);font-size:0.7rem;margin:10px 0 0;font-style:italic">Sample data shown - real per-game status will land when the pipeline publishes Steam Deck compatibility (task #37).</p>`;
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
export function isSteamDeckHardware(r) {
  const haystack = `${r.cpu || ''} ${r.gpu || ''}`;
  return _DECK_LCD_RE.test(haystack) || _DECK_OLED_RE.test(haystack);
}

// SVG path data for each signal icon. Drawn at 24x24 viewBox. Currentcolor
// fills/strokes so we don't have to define per-icon color.
