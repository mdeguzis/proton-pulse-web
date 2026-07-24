// signals (components) for the app page. Relocated from app.js.

import { isSteamDeckHardware, isSteamMachineHardware } from './deck-status.js?v=830efdfb';

export const SIGNAL_ICON_SVG = {
  install: '<path fill="currentColor" d="M5 20h14v-2H5v2zm7-2 5-5h-3V4h-4v9H7l5 5z"/>',
  start:   '<path fill="currentColor" d="M8 5v14l11-7z"/>',
  play:    '<path fill="currentColor" d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10.5 14H8v1.5H6V14H3.5v-2H6v-1.5h2V12h2.5v2zm5 .5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-3c-.83 0-1.5-.67-1.5-1.5S17.67 9 18.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>',
  verdict: '<path fill="currentColor" d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.3l.9-4.6.1-.3c0-.4-.2-.8-.4-1L14.2 1 7.6 7.6c-.4.4-.6.9-.6 1.4v10c0 1.1.9 2 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z"/>',
  verdict_no: '<g transform="matrix(1 0 0 -1 0 24)"><path fill="currentColor" d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.3l.9-4.6.1-.3c0-.4-.2-.8-.4-1L14.2 1 7.6 7.6c-.4.4-.6.9-.6 1.4v10c0 1.1.9 2 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z"/></g>',
  oob:     '<path fill="currentColor" d="M12 2 4 6v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V6l-8-4zm-1 14-4-4 1.4-1.4 2.6 2.6 5.6-5.6L18 9l-7 7z"/>',
  tinker:  '<path fill="currentColor" d="m22 8-3.5 3.5L15 8l3.5-3.5C16 3.6 13.3 4.4 11.4 6.3c-2 2-2.7 4.8-1.8 7.4l-7.4 7.4 2.8 2.8 7.4-7.4c2.6.9 5.4.2 7.4-1.8 1.9-1.9 2.7-4.6 1.8-7.1z"/>',
  // Steam Deck wordmark glyph (the iconic "D" - solid dot + half-arc). Mirrors
  // the official Deck logo, not a generic gamepad
  deck:    '<circle cx="8" cy="12" r="3.6" fill="currentColor"/><path d="M13 5.4 a7.5 7.5 0 0 1 0 13.2" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round"/>',
  // Steam Machine cube (Valve's late 2025 small-form-factor SteamOS box).
  // Traced from the launch photo: a squared body with a thin port-strip
  // base and a power-dot on the right (#255).
  machine: '<rect x="4" y="4" width="16" height="12" rx="1.2" fill="currentColor"/><rect x="4" y="17.5" width="13" height="2" rx="1" fill="currentColor"/><circle cx="18.5" cy="18.5" r="1.1" fill="currentColor"/>',
  owns:    '<path fill="currentColor" d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>',
  framegen:'<path fill="currentColor" d="M7 21h2v-6H7v6zm4 0h2V9h-2v12zm4 0h2v-9h-2v9zM5 3v18h2V5h12V3H5z"/>',
};

const SIGNAL_DESC = {
  install:   'Did the game install successfully through Steam?',
  start:     'Did the game launch without immediately crashing?',
  play:      'Was the game playable to a reasonable degree?',
  verdict:   'Would the reporter recommend this setup to others?',
  verdict_no:'Would the reporter recommend this setup to others?',
  oob:       'Did the game work without any tweaks or custom launch options?',
  tinker:    'Were launch options or workarounds needed to get it running?',
  deck:      'Was this report submitted from a Steam Deck?',
  machine:   'Was this report submitted from a Steam Machine?',
  owns:      'Did the reporter confirm they own this game on Steam?',
  framegen:  'Was frame generation required for smooth gameplay?',
};

// Build one signal icon square. value is 'yes' | 'no' | null/undefined.
export function renderSignalIcon(iconKey, value, label, opts = {}) {
  const negative = opts.negative || 'no';
  const resolvedKey = (value === negative && opts.iconKeyNegative) ? opts.iconKeyNegative : iconKey;
  const path = SIGNAL_ICON_SVG[resolvedKey];
  if (!path) return '';
  const positive = opts.positive || 'yes';
  let state = 'neutral';
  if (value === positive) state = opts.positiveState || 'good';
  else if (value === negative) state = opts.negativeState || 'bad';
  const yesLabel = opts.yesLabel || 'Yes';
  const noLabel  = opts.noLabel  || 'No';
  const neutralLabel = opts.neutralLabel || 'Not answered';
  const stateLabel = value === positive ? yesLabel : value === negative ? noLabel : neutralLabel;
  const desc = SIGNAL_DESC[iconKey] || '';
  const tipState = `${label}: ${stateLabel}`;
  return `<span class="signal-icon signal-${state}" data-tip-state="${tipState}" data-tip-desc="${desc}" onmouseenter="window.__showSignalTooltip(this)" onmouseleave="window.__hideSignalTooltip()">
    <svg viewBox="0 0 24 24">${path}</svg>
  </span>`;
}

// Build the signals strip for a report. Order matters - vital signs (install
// chain) first so the eye reads "did it run?" left-to-right before getting to
// the optional extras (Deck, owns, framegen).
export function renderSignalStrip(r) {
  const fr = r.formResponses || {};
  const isDeck = isSteamDeckHardware(r);
  const isMachine = isSteamMachineHardware(r);
  // For tinker indicator: verdictOob='no' means user said "did not work out
  // of the box without tweaks" - which equates to "tinker required". So we
  // remap the value: 'no' -> "Yes, required" (amber state) and 'yes' -> "No
  // tinker needed" (good state)
  const tinkerValue = fr.verdictOob === 'no' ? 'yes'
                    : fr.verdictOob === 'yes' ? 'no'
                    : null;
  // Owns + Deck don't come from form responses - they come from other report
  // fields. Synthesize a 'yes'/null value so the same renderer works
  const ownsValue = r.gameOwned ? 'yes' : null;
  const deckValue = isDeck ? 'yes' : null;
  const machineValue = isMachine ? 'yes' : null;

  // Form-response signals get "Responses not available" when null since the
  // question was never asked/answered. Hardware-detected signals (Deck, Owns)
  // get their own specific neutral labels because they're inferred, not asked
  const formNeutral = 'Responses not available or recorded';
  const icons = [
    renderSignalIcon('install', fr.canInstall, 'Installs',
      { neutralLabel: formNeutral }),
    renderSignalIcon('start',   fr.canStart,   'Starts',
      { neutralLabel: formNeutral }),
    renderSignalIcon('play',    fr.canPlay,    'Playable',
      { neutralLabel: formNeutral }),
    renderSignalIcon('verdict', fr.verdict,    'Would recommend',
      { neutralLabel: formNeutral, iconKeyNegative: 'verdict_no' }),
    renderSignalIcon('oob',     fr.verdictOob, 'Works out of the box',
      { neutralLabel: formNeutral }),
    renderSignalIcon('tinker',  tinkerValue,   'Tinker required',
      { positiveState: 'warn', negativeState: 'good', neutralLabel: formNeutral }),
    renderSignalIcon('deck',    deckValue,     'Steam Deck',
      { positiveState: 'info', neutralLabel: 'Not detected' }),
    renderSignalIcon('machine', machineValue,  'Steam Machine',
      { positiveState: 'info', neutralLabel: 'Not detected' }),
    renderSignalIcon('owns',    ownsValue,     'Reporter owns the game',
      { positiveState: 'info',
        yesLabel: 'Confirmed',
        neutralLabel: (r.source || '').toLowerCase() === 'protondb'
          ? 'Anonymous report - cannot be verified'
          : 'Not confirmed' }),
    // Framegen flips the usual yes=good convention: "yes, required" means the
    // game can't hold a frame rate on its own (bad), "no, not required" means
    // it runs smoothly without help (good). Matches how the user reads it.
    renderSignalIcon('framegen', fr.requiresFramegen, 'Framegen required for smooth play',
      { positiveState: 'bad', negativeState: 'good', neutralLabel: formNeutral }),
  ].filter(Boolean);
  return `<div class="signal-strip">${icons.join('')}</div>`;
}

// Author identity for a report. Returns { kind, displayName, subtitle }.
