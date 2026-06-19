// report-card (components) for the app page. Relocated from app.js.

import { estimateScore } from '../../shared/scoring.js?v=0dae1257';
import { getWebClientId } from '../../shared/submit.js?v=c57cb3d6';
import { detectGpuArch } from '../../lib/gpu-arch-detector.js?v=1f02f4a6';
import { renderAuthorBlock } from './author.js?v=09a3a8a3';
import { buildFormRows } from './config-cards.js?v=2578d16a';
import { renderSignalStrip } from './signals.js?v=a1026433';
import { RATING_COLORS, RATING_TEXT } from '../config.js?v=4031c5fa';
import { confColor, confTextColor, configKey, daysAgo, esc, fmtDuration, fmtMinutes, hashReportKey, reportKey } from '../utils.js?v=f5dda5b6';

export function renderPermalink(r) {
  let id = r.reportId != null ? `r${r.reportId}` : (r.clientId ? `c${r.clientId.slice(0, 8)}` : '');
  if (!id && r.timestamp) id = hashReportKey(reportKey(r));
  if (!id || !r.appId) return '';
  const anchor = `report-${id}`;
  // Inline JS avoids needing a separate event delegate hook for now. Replace
  // with delegated handler when this lands in production
  const fn = `(function(b){const u=location.origin+location.pathname+'#/app/${r.appId}#${anchor}';navigator.clipboard?.writeText(u);b.classList.add('copied');setTimeout(()=>b.classList.remove('copied'),900);return false;})(this)`;
  return `<button class="permalink-btn" type="button" title="Copy permalink to this report" onclick="${fn}">
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M3.9 12c0-1.7 1.4-3.1 3.1-3.1h4V7H7c-2.8 0-5 2.2-5 5s2.2 5 5 5h4v-1.9H7c-1.7 0-3.1-1.4-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.7 0 3.1 1.4 3.1 3.1s-1.4 3.1-3.1 3.1h-4V17h4c2.8 0 5-2.2 5-5s-2.2-5-5-5z"/></svg>
  </button>`;
}

// - Render: report card ------------------------------

export function renderCard(r, votes, userVotes = {}, configPlaytimeTotals = []) {
  const v     = votes[reportKey(r)] || { up: 0, down: 0 };
  const rKey  = reportKey(r);
  const userVote = userVotes[rKey] || 0;
  // Raw score is already on a 0-100 scale internally; we used to divide by 10
  // and display X.X/10 - switched to direct % to match the plugin pill format
  const confRaw = Math.min(100, Math.max(0, r.score || estimateScore(r)));
  const confPct = Math.round(confRaw);
  const src = (r.source || '').toLowerCase();
  // Pulse-submitted reports land in user_configs with source='user' (plugin) or
  // 'proton-pulse' (legacy). ProtonDB mirror rows are tagged 'protondb'.
  // Anything starting with 'web' is the web submit flow, which is a Pulse path too
  const isProtonDb = src === 'protondb';
  const isWeb = src.startsWith('web');
  // When running a Windows game via Proton on Linux, label as Steam Play rather than Linux
  const webPlatformLabel = (src === 'web-linux' && r.protonVersion)
    ? 'Steam Play'
    : { 'web-steamdeck': 'Steam Deck', 'web-linux': 'Linux', 'web-windows': 'Windows', 'web-macos': 'macOS', 'web': 'Web' }[src] || 'Web';
  const rc    = RATING_COLORS[r.rating] || '#3a4a5a';
  const rt    = RATING_TEXT[r.rating]   || '#c8d4e0';
  const na = s => s || '<span style="color:#4a5f70;font-style:italic">Not available</span>';
  const arch = r.gpuArchitecture || detectGpuArch(r.gpu) || '';
  // Source badge used to render top-right of each card (Pulse / ProtonDB).
  // Removed - the same info already appears in the "Source" row at the bottom
  // of the card, so two pills said the same thing and crowded the right column.
  return `
    <div class="card" id="${(() => { const id = r.reportId != null ? `r${r.reportId}` : (r.clientId ? `c${r.clientId.slice(0, 8)}` : ''); return id ? `report-${id}` : ''; })()}">
      ${renderAuthorBlock(r)}
      <div class="card-body">
        <div class="proton">${esc(r.protonVersion || 'Unknown')}</div>
        <div class="hw">${esc([r.gpu, r.os].filter(Boolean).join(' / ') || 'Hardware unavailable')}</div>
        <div class="age">
          ${daysAgo(r.timestamp)}
          ${(r.durationMinutes != null || fmtDuration(r.duration)) ? `<span class="hours-inline" title="Steam playtime when the reporter submitted this report">  &middot;  ${r.durationMinutes != null ? fmtMinutes(r.durationMinutes) : fmtDuration(r.duration)} played</span>` : ''}
        </div>
        ${renderSignalStrip(r)}
      </div>
      <div class="right">
        <div class="card-rating-row">
          <a class="confidence-pill conf-link" href="confidence.html?app=${r.appId}${r.reportId != null ? '&report=' + r.reportId : '&ts=' + (r.timestamp || '')}" onclick="event.stopPropagation()" title="See the factor-by-factor breakdown of how this confidence was computed" style="background:${confColor(confPct / 10)};color:${confTextColor(confPct / 10)}">Confidence: ${confPct}%</a>
          <span class="rating" style="background:${rc};color:${rt}">${r.rating || '?'}</span>
        </div>
        <div class="vote-btns">
          <button class="vote-btn vote-up${userVote === 1 ? ' active' : ''}" data-vote="1" data-rkey="${esc(rKey)}" data-appid="${r.appId}" title="Helpful"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${v.up}</span></button>
          <button class="vote-btn vote-dn${userVote === -1 ? ' active' : ''}" data-vote="-1" data-rkey="${esc(rKey)}" data-appid="${r.appId}" title="Not helpful"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="transform:scaleY(-1)"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg><span class="vote-count">${v.down}</span></button>
        </div>
      </div>
    </div>
    <div class="card-summary">
      <div class="row"><span class="label">GPU</span><span>${na(esc(r.gpu))}</span></div>
      <div class="row"><span class="label">CPU</span><span>${na(esc(r.cpu))}</span></div>
      <div class="row"><span class="label">OS</span><span>${na(esc(r.os))}</span></div>
      <div class="row"><span class="label">Proton</span><span>${na(esc(r.protonVersion))}</span></div>
      ${(r.durationMinutes != null || fmtDuration(r.duration)) ? `<div class="row"><span class="label">Steam playtime</span><span>${r.durationMinutes != null ? fmtMinutes(r.durationMinutes) : fmtDuration(r.duration)}</span></div>` : ''}
      ${(() => { const pt = r.configKey && configPlaytimeTotals.find(t => t.config_key === r.configKey); return pt ? `<div class="row"><span class="label">Config playtime</span><span title="${pt.session_count} session${pt.session_count !== 1 ? 's' : ''}">${fmtMinutes(pt.total_minutes)}</span></div>` : ''; })()}
      ${r.notes ? `<div class="row"><span class="label">Notes</span><span class="notes-full">${esc(r.notes)}</span></div>` : ''}
      <div class="all-details-panel hw-details-panel">
        ${arch ? `<div class="row"><span class="label">GPU Arch</span><span>${esc(arch)}</span></div>` : ''}
        <div class="row"><span class="label">RAM</span><span>${na(esc(r.ram))}</span></div>
        ${r.vramMb ? `<div class="row"><span class="label">VRAM</span><span>${r.vramMb >= 1024 ? (r.vramMb/1024).toFixed(1)+' GB' : r.vramMb+' MB'}</span></div>` : ''}
        <div class="row"><span class="label">GPU Driver</span><span>${na(esc(r.gpuDriver))}</span></div>
        <div class="row"><span class="label">Kernel</span><span>${na(esc(r.kernel))}</span></div>
        ${r.launchOptions ? `<div class="row"><span class="label">Launch Options</span><span>${esc(r.launchOptions)}</span></div>` : ''}
      </div>
      ${(() => { const fr = buildFormRows(r); return fr ? `<div class="all-details-panel fr-panel"><div class="fr-section">${fr}</div></div>` : ''; })()}
      ${r.reportId != null ? `<div class="row"><span class="label">Report ID</span><span style="font-family:monospace;font-size:0.8em;color:var(--muted)">#${r.reportId}</span></div>` : ''}
      <div class="row"><span class="label">Source</span><span>${isProtonDb ? 'ProtonDB' : isWeb ? 'Web submission' : 'Decky Proton Pulse'}</span></div>
      ${!isProtonDb && r.timestamp ? `<div class="row"><span class="label">Submitted</span><span>${new Date(r.timestamp * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span></div>` : ''}
      ${!isProtonDb && r.updatedAt && r.updatedAt !== r.timestamp ? `<div class="row"><span class="label">Edited</span><span>${new Date(r.updatedAt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span></div>` : ''}
      <!-- All action buttons live in the footer in one uniform blue style:
           Show Report Responses (if there are any), All Hardware Details,
           Permalink, JSON. Delete only shows for the report owner. -->
      <div class="card-footer">
        ${(() => { const fr = buildFormRows(r); return fr ? `<button class="action-btn" onclick="const p=this.closest('.card-summary').querySelector('.fr-panel');p.classList.toggle('open');this.textContent=p.classList.contains('open')?'Hide Report Responses':'Show Report Responses'">Show Report Responses</button>` : ''; })()}
        <button class="action-btn" onclick="this.closest('.card-summary').querySelector('.hw-details-panel').classList.toggle('open');this.textContent=this.closest('.card-summary').querySelector('.hw-details-panel').classList.contains('open')?'Hide details':'All details'">All details</button>
        <button class="action-btn action-btn-icon" data-report-json='${JSON.stringify(r).replace(/'/g,"&#39;")}' title="Download as JSON"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zm-14 9v2h14v-2H5z"/></svg></button>
        <button class="action-btn action-btn-icon flag-report-btn${r.isFlagged ? ' flagged' : ''}" data-report-id="${r.reportId ?? ''}" data-app-id="${r.appId}" data-report-key="${esc(rKey)}" data-source="${esc(r.source || 'unknown')}" title="${r.isFlagged ? 'Flagged for review' : 'Flag this report'}"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg></button>
        ${renderPermalink(r)}
        ${r.clientId && r.clientId === getWebClientId() ? `<button class="action-btn action-btn-danger delete-report-btn" data-app-id="${r.appId || ''}" title="Delete your report">Delete</button>` : ''}
      </div>
    </div>`;
}

// - Render: game page --------------------------------
