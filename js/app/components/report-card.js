// report-card (components) for the app page. Relocated from app.js.

import { estimateScore } from '../../shared/scoring.js?v=852c9d97';
import { detectGpuArch } from '../../lib/gpu-arch-detector.js?v=b4fbb7ef';
import { renderAuthorBlock } from './author.js?v=3a8cb3c7';
import { buildFormRows } from './config-cards.js?v=c67740f8';
import { renderSignalStrip } from './signals.js?v=ff2ad4c9';
import { RATING_COLORS, RATING_TEXT } from '../config.js?v=a75604f5';
import { confColor, confTextColor, configKey, daysAgo, esc, renderNotes, fmtDuration, fmtMinutes, hashReportKey, reportKey } from '../utils.js?v=4630c3d5';

export function renderPermalink(r) {
  let id = r.reportId != null ? `r${r.reportId}` : (r.clientId ? `c${r.clientId.slice(0, 8)}` : '');
  if (!id && r.timestamp) id = hashReportKey(reportKey(r));
  if (!id || !r.appId) return '';
  const anchor = `report-${id}`;
  const safeAppId = String(r.appId).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const safeAnchor = anchor.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const fn = `(function(b){const u=location.origin+location.pathname+'#/app/${safeAppId}#${safeAnchor}';navigator.clipboard?.writeText(u);b.classList.add('copied');setTimeout(()=>b.classList.remove('copied'),900);return false;})(this)`;
  return `<button class="permalink-btn" type="button" title="Copy permalink to this report" onclick="${fn}">
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M3.9 12c0-1.7 1.4-3.1 3.1-3.1h4V7H7c-2.8 0-5 2.2-5 5s2.2 5 5 5h4v-1.9H7c-1.7 0-3.1-1.4-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.7 0 3.1 1.4 3.1 3.1s-1.4 3.1-3.1 3.1h-4V17h4c2.8 0 5-2.2 5-5s-2.2-5-5-5z"/></svg>
  </button>`;
}

// #405: surface the reporter's overall verdict ("would you recommend this to
// others?") on the card face instead of burying it behind Show Report
// Responses. Pulse reports carry form_responses.verdict = 'yes' | 'no';
// ProtonDB mirror rows and old reports have none and render no line at all.
export function renderRecommendLine(r) {
  const verdict = String(r.formResponses?.verdict || '').toLowerCase();
  if (verdict !== 'yes' && verdict !== 'no') return '';
  const yes = verdict === 'yes';
  const thumb = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"${yes ? '' : ' style="transform:scaleY(-1)"'}><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>`;
  return `<div class="rec-verdict rec-verdict--${yes ? 'yes' : 'no'}" title="The reporter's answer to: would you recommend this to others?">${thumb} ${yes ? 'Would recommend' : 'Would not recommend'}</div>`;
}

// #410 variant B: FPS detail row. The aggregate min/avg/max is always
// visible as a normal card row; when the report carries per-run MangoHud
// captures (form_responses.fpsRuns from multi-upload) a "N runs" chip
// expands up to 5 rows inline. Overflow beyond 5 (and graphs, filters,
// the interactive table) lives on the per-report All stats page --
// game-stats.html?app=X&report=Y, a filtered slice of the game stats.
const FPS_RUNS_INLINE_CAP = 5;

export function renderFpsRow(r) {
  const hasAgg = r.fpsMin != null || r.fpsAvg != null || r.fpsMax != null;
  const runs = Array.isArray(r.formResponses?.fpsRuns) ? r.formResponses.fpsRuns.filter(x => x && typeof x === 'object') : [];
  if (!hasAgg && !runs.length) return '';
  const fmt = v => (v != null ? Number(v).toFixed(1) : '-');
  const chip = runs.length
    ? `<button type="button" class="fps-runs-chip" onclick="const p=this.closest('.card-summary').querySelector('.fps-runs-panel');p.hidden=!p.hidden;this.classList.toggle('open',!p.hidden)">${runs.length} run${runs.length !== 1 ? 's' : ''} <span class="fps-runs-caret">&#9662;</span></button>`
    : '';
  const statsHref = r.appId != null
    ? `game-stats.html?app=${encodeURIComponent(String(r.appId))}${r.reportId != null ? `&report=${encodeURIComponent(String(r.reportId))}` : ''}`
    : '';
  const allStatsBtn = statsHref && runs.length
    ? `<a class="fps-allstats-link" href="${statsHref}" onclick="event.stopPropagation()" title="Full stats for this report: graphs, per-run table, filters">All stats</a>`
    : '';
  const shown = runs.slice(0, FPS_RUNS_INLINE_CAP);
  const overflow = runs.length - shown.length;
  const panel = runs.length ? `
    <div class="fps-runs-panel" hidden>
      ${shown.map(run => `<div class="fps-run-line"><span class="fps-run-line-name" title="${esc(String(run.name || ''))}">${esc(String(run.name || 'run'))}</span><span class="fps-run-line-vals">${fmt(run.fpsMin)} / ${fmt(run.fpsAvg)} / ${fmt(run.fpsMax)}</span><span class="fps-run-line-samples">${Number(run.sampleCount || 0).toLocaleString()} samples</span></div>`).join('')}
      ${overflow > 0 ? `<a class="fps-run-line-more" href="${statsHref}">+${overflow} more run${overflow !== 1 ? 's' : ''} on the All stats page -&gt;</a>` : ''}
    </div>` : '';
  return `<div class="row fps-row"><span class="label">FPS (min / avg / max)</span><span class="fps-values" title="Reported frames-per-second measurements">${fmt(r.fpsMin)} / ${fmt(r.fpsAvg)} / ${fmt(r.fpsMax)}${chip}${allStatsBtn}</span></div>${panel}`;
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
  // Anchor id wraps the whole report (header card + summary body) so
  // scrolling to a permalink lands on the top of the visible block, not
  // partway through where the .card header used to carry the id. Header
  // and body keep their existing classes/styling.
  const _anchorId = (() => {
    const id = r.reportId != null ? `r${r.reportId}` : (r.clientId ? `c${r.clientId.slice(0, 8)}` : '');
    return id ? `report-${id}` : '';
  })();
  return `
    <div class="report-block"${_anchorId ? ` id="${_anchorId}"` : ''}>
    <div class="card">
      ${renderAuthorBlock(r)}
      <div class="card-body">
        <div class="proton">${(() => {
          if (r.runType === 'native') {
            return '<span class="run-type-pill run-type-pill--native" title="Native Linux build (no Proton)">Native Linux</span>';
          }
          const RT_PILL = {
            'proton-lsfg':         { cls: 'lsfg',  label: 'Proton + LSFG', title: 'Proton with Lossless Scaling FrameGen wrapper' },
            'proton-ge':           { cls: 'plain', label: 'Proton GE',     title: 'GloriousEggroll community fork' },
            'proton-experimental': { cls: 'plain', label: 'Proton Experimental', title: 'Valve bleeding-edge Proton branch' },
            'proton-cachyos':      { cls: 'plain', label: 'CachyOS Proton', title: 'CachyOS-tuned Proton' },
            'proton-tkg':          { cls: 'plain', label: 'Proton-TKG',    title: 'TKG custom Proton build' },
          };
          const pill = RT_PILL[r.runType];
          return pill
            ? `<span class="run-type-pill run-type-pill--${pill.cls}" title="${pill.title}">${pill.label}</span> ${esc(r.protonVersion || 'Unknown')}`
            : esc(r.protonVersion || 'Unknown');
        })()}</div>
        <div class="hw">${esc([r.gpu, r.os].filter(Boolean).join(' / ') || 'Hardware unavailable')}</div>
        <div class="age">
          ${daysAgo(r.timestamp)}
          ${(r.durationMinutes != null || fmtDuration(r.duration)) ? `<span class="hours-inline" title="Steam playtime when the reporter submitted this report">  &middot;  ${r.durationMinutes != null ? fmtMinutes(r.durationMinutes) : fmtDuration(r.duration)} played</span>` : ''}
        </div>
        ${renderRecommendLine(r)}
        ${renderSignalStrip(r)}
      </div>
      <div class="right">
        <div class="card-rating-row">
          <a class="confidence-pill conf-link" href="confidence.html?app=${r.appId}${r.reportId != null ? '&report=' + r.reportId : '&ts=' + (r.timestamp || '')}" onclick="event.stopPropagation()" title="See the factor-by-factor breakdown of how this confidence was computed" style="background:${confColor(confPct / 10)};color:${confTextColor(confPct / 10)}">Confidence: ${confPct}%</a>
          <span class="rating" style="background:${rc};color:${rt}">${r.rating || '?'}</span>
        </div>
        <div class="vote-btns" data-author-id="${esc(r.clientId || '')}" data-author-ppid="${esc(r.protonPulseUserId || '')}">
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
      ${renderFpsRow(r)}
      ${(() => { const pt = r.configKey && configPlaytimeTotals.find(t => t.config_key === r.configKey); return pt ? `<div class="row"><span class="label">Config playtime</span><span title="${pt.session_count} session${pt.session_count !== 1 ? 's' : ''}">${fmtMinutes(pt.total_minutes)}</span></div>` : ''; })()}
      ${r.notes ? `<div class="row"><span class="label">Notes</span><div class="notes-full">${renderNotes(r.notes)}</div></div>` : ''}
      ${r.launchOptions ? `<div class="row"><span class="label">Launch Options</span><span class="launch-options-value">${esc(r.launchOptions)}</span></div>` : ''}
      <div class="all-details-panel hw-details-panel">
        ${arch ? `<div class="row"><span class="label">GPU Arch</span><span>${esc(arch)}</span></div>` : ''}
        <div class="row"><span class="label">RAM</span><span>${na(esc(r.ram))}</span></div>
        ${r.vramMb ? `<div class="row"><span class="label">VRAM</span><span>${r.vramMb >= 1024 ? (r.vramMb/1024).toFixed(1)+' GB' : r.vramMb+' MB'}</span></div>` : ''}
        <div class="row"><span class="label">GPU Driver</span><span>${na(esc(r.gpuDriver))}</span></div>
        <div class="row"><span class="label">Kernel</span><span>${na(esc(r.kernel))}</span></div>
        ${r.reportId != null ? `<div class="row"><span class="label">Report ID</span><span style="font-family:monospace;font-size:0.8em;color:var(--muted)">#${r.reportId}</span></div>` : ''}
        <div class="row"><span class="label">Source</span><span>${isProtonDb ? 'ProtonDB' : isWeb ? 'Web submission' : 'Decky Proton Pulse'}</span></div>
        ${!isProtonDb && r.timestamp ? `<div class="row"><span class="label">Submitted</span><span>${new Date(r.timestamp * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span></div>` : ''}
        ${!isProtonDb && r.updatedAt && r.updatedAt !== r.timestamp ? `<div class="row"><span class="label">Edited</span><span>${new Date(r.updatedAt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span></div>` : ''}
      </div>
      ${(() => { const fr = buildFormRows(r); return fr ? `<div class="all-details-panel fr-panel"><div class="fr-section">${fr}</div></div>` : ''; })()}
      <!-- All action buttons live in the footer in one uniform blue style:
           Show Report Responses (if there are any), All Hardware Details,
           Permalink, JSON. Deleting your own report lives on the profile
           page only (#405). -->
      <div class="card-footer">
        ${(() => { const fr = buildFormRows(r); return fr ? `<button class="action-btn" onclick="const p=this.closest('.card-summary').querySelector('.fr-panel');const open=p.classList.toggle('open');this.querySelector('.action-btn-verb').textContent=open?'Hide':'Show'"><span class="action-btn-verb">Show</span> Report Responses</button>` : ''; })()}
        <button class="action-btn" onclick="this.closest('.card-summary').querySelector('.hw-details-panel').classList.toggle('open');this.textContent=this.closest('.card-summary').querySelector('.hw-details-panel').classList.contains('open')?'Hide details':'All details'">All details</button>
        <button class="action-btn action-btn-icon" data-report-json='${JSON.stringify(r).replace(/'/g,"&#39;")}' title="Download as JSON"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zm-14 9v2h14v-2H5z"/></svg></button>
        <button class="action-btn action-btn-icon flag-report-btn${r.isFlagged ? ' flagged' : ''}" data-report-id="${r.reportId ?? ''}" data-app-id="${r.appId}" data-report-key="${esc(rKey)}" data-source="${esc(r.source || 'unknown')}" title="${r.isFlagged ? 'Flagged for review' : 'Flag this report'}"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg></button>
        ${renderPermalink(r)}
      </div>
    </div>
    </div>`;
}

// - Render: game page --------------------------------
