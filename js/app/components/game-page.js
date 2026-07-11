// game-page (components) for the app page. Relocated from app.js.

import { detectGpuArch } from '../../lib/gpu-arch-detector.js?v=b4fbb7ef';
import { populateScoringTooltip, pulseTierFromReports, tierFromReports } from '../../shared/scoring.js?v=1b8ae722';
import { computeCompatTrend, RECENT_DAYS, PRIOR_WINDOW_DAYS } from '../../lib/scoring/gameStats.js?v=8dc92cf7';
import { getWebClientId } from '../../shared/submit.js?v=75603703';
import { fetchAppDepotInfo, fetchAppMetadata, fetchAppNews, fetchDeckStatusForApp, fetchMinRequirements, fetchLinuxNativeSupport } from '../api/deck-status.js?v=d39add5f';
import { fetchCdn, fetchProtonDbLive } from '../api/protondb.js?v=55a861cb';
import { fetchConfigPlaytimeTotals, fetchNativeReports, fetchSupabase, flagReport } from '../api/supabase.js?v=01961c8d';
import { castVote, fetchUserVotes, fetchVotes } from '../api/votes.js?v=aba6619f';
import { enhanceAuthorBlocks } from './author.js?v=3a8cb3c7';
import { renderConfigCard } from './config-cards.js?v=c67740f8';
import { DECK_STATUS_ICON_SVG, DECK_STATUS_LABELS, _DECK_LCD_RE, _DECK_OLED_RE, _STEAM_MACHINE_RE, renderDeckStatusButton, renderDeckStatusModalContent } from './deck-status.js?v=ff5d0c54';
import { renderCard } from './report-card.js?v=faa750d4';
import { loadSearchIndex, searchIndex } from './search.js?v=598aaad1';
import { showAdultAllowed, isAdultEntry } from '../../lib/adult-filter.js?v=e4e9d845';
import { loadGameHides } from '../lib/game-hides.js?v=2d7d7afe';
import { CDN, RATING_COLORS, RATING_TEXT, SB_KEY, SB_URL, SITE_ROOT, STEAM_IMG, dataFilesHref, storeLabelFromAppId } from '../config.js?v=f9591262';
import { loadSteamImg as _loadSteamImg } from '../lib/steam-img.js?v=ba0d7848';
import { configKey, daysAgo, downloadJson, esc, reportKey } from '../utils.js?v=c7e1268c';
import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';
import { getMyLibraryAppIds } from '../lib/user-library.js?v=1d8e72df';
import { getMyWishlistAppIds } from '../lib/user-wishlist.js?v=9c88bc65';
import { computeBadgesForAppId } from '../../lib/card-badges.js?v=5b71af11';

let _steamCatalogCache = null;
async function _fetchSteamCatalog() {
  if (_steamCatalogCache !== null) return _steamCatalogCache;
  try {
    // Route through dataUrl so the content hash invalidates the cache when
    // the catalog actually changes (#119). The bare name resolves to the
    // staging/local copy or the prod copy depending on USES_PROD_DATA.
    const bustedName = await dataUrl('steam-catalog.json');
    const resp = await fetch(`${SITE_ROOT}/${bustedName}`);
    _steamCatalogCache = resp.ok ? await resp.json() : {};
  } catch {
    _steamCatalogCache = {};
  }
  return _steamCatalogCache;
}

const DISCORD_URL = 'https://discord.gg/UdPaEsMtd';

// Report key used to match a ProtonDB mirror report against a suppression row.
// Must stay identical to the key the admin flag flow stores (api/flagged.js).
function _pdbReportKey(r) {
  return `${r.timestamp}:${(r.gpu || '').slice(0, 20)}:${(r.protonVersion || '').slice(0, 15)}`;
}

// Fetch the set of suppressed ProtonDB reports for an app (admin shadow ban /
// delete). Returns a Set of report_key strings to filter out at render time.
// Our site, our rules: we hide reports we have moderated regardless of source.
async function _fetchReportModeration(appId) {
  try {
    const url = `${SB_URL}/report_moderation?app_id=eq.${encodeURIComponent(appId)}&select=report_key`;
    const res = await fetch(url, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!res.ok) return new Set();
    const rows = await res.json();
    return new Set(rows.map(r => r.report_key));
  } catch {
    return new Set();
  }
}

function _showFlagModal(btn) {
  const existing = document.getElementById('flag-report-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'flag-report-modal';
  modal.className = 'flag-modal-overlay';
  modal.innerHTML = `
    <div class="flag-modal">
      <h3 class="flag-modal-title">Flag this report</h3>
      <label class="flag-modal-label" for="flag-category">Reason</label>
      <select id="flag-category" class="flag-modal-select">
        <option value="">Select a reason...</option>
        <option value="spam">Spam or test data</option>
        <option value="inaccurate">Inaccurate information</option>
        <option value="inappropriate">Inappropriate content</option>
        <option value="duplicate">Duplicate report</option>
        <option value="other">Other</option>
      </select>
      <label class="flag-modal-label" for="flag-notes">Additional notes (optional)</label>
      <textarea id="flag-notes" class="flag-modal-textarea" rows="3" placeholder="Describe the issue..."></textarea>
      <p class="flag-modal-discord">Have questions or want to dispute a moderation decision? Reach out on <a href="${DISCORD_URL}" target="_blank" rel="noopener">Discord</a>.</p>
      <div class="flag-modal-actions">
        <button id="flag-cancel-btn" class="action-btn">Cancel</button>
        <button id="flag-submit-btn" class="action-btn flag-modal-submit" disabled>Submit</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  const categoryEl = modal.querySelector('#flag-category');
  const submitEl = modal.querySelector('#flag-submit-btn');
  categoryEl.addEventListener('change', () => { submitEl.disabled = !categoryEl.value; });
  modal.querySelector('#flag-cancel-btn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  submitEl.addEventListener('click', async () => {
    submitEl.disabled = true;
    submitEl.textContent = 'Submitting...';
    const ok = await flagReport({
      reportId: btn.dataset.reportId ? Number(btn.dataset.reportId) : null,
      appId: btn.dataset.appId,
      reportKey: btn.dataset.reportKey,
      source: btn.dataset.source,
      reasonCategory: categoryEl.value,
      reasonText: modal.querySelector('#flag-notes').value.trim() || null,
      reporterClientId: getWebClientId(),
    });
    if (ok) {
      btn.classList.add('flagged');
      btn.title = 'Flagged for review';
      modal.remove();
      window.ppToast?.success('Report flagged for review. Thanks for the heads-up.');
    } else {
      submitEl.textContent = 'Failed - try again';
      submitEl.disabled = false;
      window.ppToast?.error('Could not flag the report. Please try again.');
    }
  });
}

// Per-runtime "when was it last tested" table opened by clicking the
// Native Linux hint on the game header. Renders a small modal listing
// every run_type observed for this game (native, proton, proton-lsfg,
// plus any pipeline-discovered variants), with the number of reports
// and the first-seen / last-seen dates. Reports without a run_type
// (legacy rows) get grouped under 'unknown' so viewers can spot the
// coverage gap.
function _openRuntimeHistoryModal(appId, combined) {
  const existing = document.getElementById('runtime-history-modal');
  if (existing) existing.remove();

  const rows = (combined || []).filter(r => r._kind === 'report' || r._kind === 'config');
  const byRuntime = new Map();
  for (const r of rows) {
    const key = r.runType || 'unknown';
    const ts = (r.timestamp || 0) * 1000;
    const upd = (r.updatedAt || r.timestamp || 0) * 1000;
    let entry = byRuntime.get(key);
    if (!entry) { entry = { count: 0, first: Infinity, last: 0 }; byRuntime.set(key, entry); }
    entry.count++;
    if (ts && ts < entry.first) entry.first = ts;
    if (upd && upd > entry.last) entry.last = upd;
  }

  const LABEL = {
    native:                'Native Linux',
    proton:                'Proton',
    'proton-experimental': 'Proton Experimental',
    'proton-ge':           'Proton GE',
    'proton-cachyos':      'CachyOS Proton',
    'proton-tkg':          'Proton-TKG',
    'proton-lsfg':         'Proton + LSFG',
    unknown:               'Unclassified',
  };
  const CANONICAL_ORDER = ['native', 'proton', 'proton-experimental', 'proton-ge', 'proton-cachyos', 'proton-tkg', 'proton-lsfg'];
  const ordered = [...byRuntime.entries()].sort(([a], [b]) => {
    const ai = CANONICAL_ORDER.indexOf(a);
    const bi = CANONICAL_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    if (a === 'unknown') return 1;
    if (b === 'unknown') return -1;
    return a.localeCompare(b);
  });

  const fmtDate = (ms) => Number.isFinite(ms) && ms > 0
    ? new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '-';

  const bodyRows = ordered.length === 0
    ? `<tr><td colspan="4" class="rh-empty">No reports on this game carry a runtime yet. New submissions will populate this table.</td></tr>`
    : ordered.map(([key, e]) => `
        <tr>
          <td><span class="run-type-pill run-type-pill--${key === 'native' ? 'native' : (key === 'proton-lsfg' ? 'lsfg' : 'plain')}" title="${esc(key)}">${esc(LABEL[key] || key)}</span></td>
          <td class="rh-num">${e.count}</td>
          <td class="rh-date">${fmtDate(e.first)}</td>
          <td class="rh-date">${fmtDate(e.last)}</td>
        </tr>`).join('');

  const modal = document.createElement('div');
  modal.id = 'runtime-history-modal';
  modal.className = 'flag-modal-overlay';
  modal.innerHTML = `
    <div class="flag-modal runtime-history-modal">
      <h3 class="flag-modal-title">Runtimes tested for this game</h3>
      <p class="rh-hint">One row per runtime observed across all reports on this app. Dates come from report timestamps.</p>
      <table class="runtime-history-table">
        <thead>
          <tr>
            <th>Runtime</th>
            <th class="rh-num">Reports</th>
            <th class="rh-date">First seen</th>
            <th class="rh-date">Last updated</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <div class="flag-modal-actions">
        <button class="action-btn" id="runtime-history-close">Close</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#runtime-history-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
}

// Metadata modal opened by the "Metadata" pill in the hub-links row.
// Formats the Steam appdetails payload the same way SteamDB does: one
// section per fact block (developer / publisher / systems / release
// date / genres / metacritic). Fields that Steam did not return simply
// omit their block so a partial response never looks like a bug.
async function _openMetadataModal(appId) {
  const existing = document.getElementById('game-metadata-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'game-metadata-modal';
  modal.className = 'flag-modal-overlay';
  modal.innerHTML = `
    <div class="flag-modal game-metadata-modal">
      <h3 class="flag-modal-title">Metadata</h3>
      <div id="game-metadata-body" class="game-metadata-body">
        <p class="rh-hint">Loading Steam metadata...</p>
      </div>
      <div class="flag-modal-actions">
        <button class="action-btn" id="game-metadata-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#game-metadata-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  const [meta, depotInfo, newsInfo] = await Promise.all([
    fetchAppMetadata(appId).catch(() => null),
    // Depot info from the PICS pipeline (#215). Populated nightly; may
    // not exist for this app yet.
    fetchAppDepotInfo(appId).catch(() => null),
    // ISteamNews fallback: even when PICS is empty for the app we can
    // still show a 'last patch note' date via a public HTTP endpoint.
    // Global (not per-OS) so it degrades gracefully alongside the OS
    // table.
    fetchAppNews(appId).catch(() => null),
  ]);
  const body = modal.querySelector('#game-metadata-body');
  if (!body) return;
  if (!meta) {
    body.innerHTML = '<p class="rh-hint">Steam did not return metadata for this app (it may be delisted or region-locked).</p>';
    return;
  }
  const section = (title, html) => html
    ? `<div class="gm-section"><div class="gm-section-title">${esc(title)}</div><div class="gm-section-body">${html}</div></div>`
    : '';
  const list = (items) => (items || []).length
    ? `<div class="gm-chips">${items.map(i => `<span class="gm-chip">${esc(i)}</span>`).join('')}</div>`
    : '';
  // Per-OS depot row. Steam does not publish per-depot last-updated dates
  // via appdetails (that lives in PICS / SteamDB), so we cache them via
  // steamcmd nightly (#215) into steam_depot_updates and observation
  // history into steam_depot_manifest_history. The edge fn returns:
  //   { found, os: { windows|mac|linux: { tracked_since, last_updated, depots } } }
  // Values are only populated when we have real observations -- we
  // deliberately do NOT fall back to app-wide release date or to the
  // branch timestamp for tracked_since. Better to show a dash than lie.
  const platformsRows = (p, releaseDate) => {
    if (!p) return '';
    const dOs = depotInfo?.found && depotInfo.os ? depotInfo.os : {};
    const fmtDate = (iso) => {
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    };
    // #237: brown package icon that deep-links to the per-game depots.json
    // we publish alongside latest.json. GitHub blob URL so users see the
    // raw JSON with syntax highlighting + a "Raw" download button.
    const DEPOT_FILE_URL = `https://github.com/mdeguzis/proton-pulse-web/blob/gh-pages/data/${esc(String(meta.appId))}/depots.json`;
    const row = (key, label) => {
      const on = !!p[key];
      const cached = dOs[key];
      const lastFmt = fmtDate(cached?.last_updated);
      const trackedFmt = fmtDate(cached?.tracked_since);
      let trackedCell, lastCell, depotsCell;
      if (!on) {
        trackedCell = '-';
        lastCell    = '-';
        depotsCell  = '<span class="gm-mute" title="No depot on this OS">-</span>';
      } else if (cached) {
        // Tracked-since is the honest floor: earliest first_observed_at we
        // recorded for this (app, os). It is NOT "when the OS build was
        // added" for existing games -- see the footer note.
        trackedCell = trackedFmt
          ? `<span class="gm-depot-date" title="Earliest observation date we recorded for this OS. Retroactive 'added on' isn't derivable from PICS (see footer).">${esc(trackedFmt)}</span>`
          : '<span class="gm-mute" title="No observation history yet. Once the nightly pipeline observes this depot a second time, we lock in a real tracked-since date.">-</span>';
        lastCell    = lastFmt
          ? `<span class="gm-depot-date" title="Branch-level timeupdated from PICS -- every OS depot on a shared branch inherits this value.">${esc(lastFmt)}</span>`
          : '-';
        // #237 (v2): depots column now icon-only. Count moves into the icon's
        // tooltip so we save a column on mobile. The icon links to the raw
        // depots.json we publish for this app.
        depotsCell = `<a class="gm-depot-file" href="${DEPOT_FILE_URL}#os=${esc(key)}" target="_blank" rel="noopener" title="${cached.depots} depot${cached.depots !== 1 ? 's' : ''} tracked -- click to open the raw depots.json this modal was built from">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M21 8V19a2 2 0 01-2 2H5a2 2 0 01-2-2V8"/>
            <path d="M1 5h22v3H1z"/>
            <path d="M10 12h4"/>
          </svg>
        </a>`;
      } else {
        trackedCell = '-';
        lastCell    = `<a class="gm-depot-link" href="https://steamdb.info/app/${esc(meta.appId)}/depots/" target="_blank" rel="noopener">SteamDB -&gt;</a>`;
        depotsCell  = '<span class="gm-mute" title="Not cached yet -- pipeline #215 populates this nightly">-</span>';
      }
      return `
        <tr>
          <td><span class="gm-plat${on ? ' gm-plat--on' : ''}">${esc(label)}</span></td>
          <td>${trackedCell}</td>
          <td>${lastCell}</td>
          <td class="gm-plat-depots">${depotsCell}</td>
        </tr>`;
    };
    return `<table class="gm-plat-table">
      <thead><tr><th>OS</th><th>Tracked since</th><th>Last update</th><th class="gm-plat-depots-th">Depots</th></tr></thead>
      <tbody>${row('windows','Windows')}${row('mac','macOS')}${row('linux','Linux')}</tbody>
      <tfoot><tr><td colspan="4" class="gm-plat-foot">
        <strong>Tracked since</strong> is the earliest observation we recorded for that OS -- not the historical date the OS build was added. Steam doesn't expose depot creation dates via PICS, so for games already shipping all three OSes when we started tracking, this is our observation floor. Newly-added OS builds for games we're already tracking WILL show an accurate add-date going forward.
        <br><strong>Last update</strong> is the branch-level PICS timestamp -- every depot on a shared branch inherits it.
        <br>The brown package icon opens the raw <code>depots.json</code> we publish for this game.
        ${newsInfo?.found && newsInfo.newest_ts
          ? `<br>App-wide 'Last patch note' (${esc(new Date(newsInfo.newest_ts * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }))}) below is the public-API fallback when a specific OS row shows 'pending'.`
          : ''}
      </td></tr></tfoot>
    </table>`;
  };
  // System requirements: fold into one collapsible block per OS. Text is
  // pre-stripped of Steam's inline HTML so we can safely render it.
  const reqsBlock = () => {
    const rows = [];
    for (const [os, pair] of [['Windows', meta.pcRequirements], ['macOS', meta.macRequirements], ['Linux', meta.linuxRequirements]]) {
      if (!pair) continue;
      if (!pair.minimum && !pair.recommended) continue;
      rows.push(`
        <div class="gm-reqs">
          <div class="gm-reqs-os">${esc(os)}</div>
          ${pair.minimum     ? `<div><strong>Min:</strong> ${esc(pair.minimum)}</div>`     : ''}
          ${pair.recommended ? `<div><strong>Rec:</strong> ${esc(pair.recommended)}</div>` : ''}
        </div>`);
    }
    return rows.join('');
  };
  const packages = () => {
    const bits = [];
    if (meta.packageIds.length) {
      bits.push(`<span>${meta.packageIds.length} package${meta.packageIds.length === 1 ? '' : 's'}: ${meta.packageIds.slice(0, 8).join(', ')}${meta.packageIds.length > 8 ? '...' : ''}</span>`);
    }
    if (meta.packageGroups.length) {
      const g = meta.packageGroups.map(x => `${esc(x.title || x.name || 'group')} (${x.subCount})`).join(', ');
      bits.push(`<div class="gm-mute" style="margin-top:2px">Groups: ${g}</div>`);
    }
    return bits.join('');
  };
  const fullgameLink = () => {
    if (!meta.fullgame?.appid) return '';
    const t = meta.fullgame.name || `App ${meta.fullgame.appid}`;
    return `<a href="#/app/${esc(String(meta.fullgame.appid))}">${esc(t)}</a>`;
  };
  body.innerHTML = [
    section('Name',          meta.name ? `<strong>${esc(meta.name)}</strong>` : ''),
    section('App ID',        `<code>${esc(meta.appId)}</code>`),
    section('Type',          meta.type ? `<code>${esc(meta.type)}</code>` : ''),
    section('Parent game',   fullgameLink()),
    section('Free to play',  meta.isFree ? '<span class="gm-plat gm-plat--on">Free</span>' : ''),
    section('Age gate',      meta.requiredAge && Number(meta.requiredAge) > 0 ? `<code>${esc(String(meta.requiredAge))}+</code>` : ''),
    section('Developer',     list(meta.developers)),
    section('Publisher',     list(meta.publishers)),
    section('Release date',  meta.releaseDate
      ? `<span>${esc(meta.releaseDate)}${meta.comingSoon ? ' <em>(coming soon)</em>' : ''}</span>` : ''),
    section('Supported systems', platformsRows(meta.platforms, meta.releaseDate)),
    section('System requirements', reqsBlock()),
    section('Genres',        list(meta.genres)),
    section('Categories',    list(meta.categories)),
    section('Achievements',  meta.hasAchievements
      ? `<span>${meta.achievementCount.toLocaleString()} total</span>` : ''),
    section('DLC',           meta.dlcCount ? `<span>${meta.dlcCount.toLocaleString()} entries</span>` : ''),
    section('Metacritic',    meta.metacriticScore != null
      ? `<a href="${esc(meta.metacriticUrl || '#')}" target="_blank" rel="noopener">${meta.metacriticScore} / 100 -&gt;</a>`
      : ''),
    section('Review summary', meta.reviewsSummary ? `<span>${esc(meta.reviewsSummary)}</span>` : ''),
    section('Languages',     meta.supportedLanguages ? `<span>${esc(meta.supportedLanguages)}</span>` : ''),
    section('Controller support', meta.controllerSupport ? `<code>${esc(meta.controllerSupport)}</code>` : ''),
    section('Packages',      packages()),
    section('Website',       meta.website
      ? `<a href="${esc(meta.website)}" target="_blank" rel="noopener">${esc(meta.website)} -&gt;</a>` : ''),
    section('Content notes', meta.contentDescriptors.length
      ? list(meta.contentDescriptors) : ''),
    section('Last patch note',
      newsInfo?.found && newsInfo.items?.length
        ? (() => {
            const it = newsInfo.items[0];
            const d = it.date ? new Date(it.date * 1000) : null;
            const dstr = d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            return `<span class="gm-depot-date" title="Most recent ISteamNews entry -- a public 'last updated' signal that works even when the PICS depot cache is empty">${esc(dstr)}</span>
                <div class="gm-mute" style="margin-top:2px">${esc(it.title || '')}</div>${it.url ? ` <a href="${esc(it.url)}" target="_blank" rel="noopener">news post -&gt;</a>` : ''}`;
          })()
        : ''),
  ].join('') + `
    <div class="gm-raw-wrap">
      <button type="button" class="gm-raw-toggle" id="gm-raw-toggle" aria-expanded="false">Show raw appdetails JSON</button>
      <pre class="gm-raw" id="gm-raw" hidden></pre>
    </div>`;

  // Wire raw-JSON toggle. Deferred so mobile does not chew memory pretty
  // printing 40KB of JSON until the user asks for it.
  const toggle = body.querySelector('#gm-raw-toggle');
  const raw    = body.querySelector('#gm-raw');
  toggle?.addEventListener('click', () => {
    const opening = raw.hidden;
    if (opening && !raw.dataset.filled) {
      try { raw.textContent = JSON.stringify(meta.raw, null, 2); }
      catch { raw.textContent = String(meta.raw); }
      raw.dataset.filled = '1';
    }
    raw.hidden = !opening;
    toggle.textContent = opening ? 'Hide raw appdetails JSON' : 'Show raw appdetails JSON';
    toggle.setAttribute('aria-expanded', String(opening));
  });
}

export function trendSummary(reps, appId) {
  if (!Array.isArray(reps) || reps.length < 2) return '';
  const now = Date.now() / 1000;
  const recent = reps.filter(r => r.timestamp && now - r.timestamp < RECENT_DAYS * 86400);
  const prior  = reps.filter(r => r.timestamp && now - r.timestamp >= RECENT_DAYS * 86400 && now - r.timestamp < PRIOR_WINDOW_DAYS * 86400);
  const t = computeCompatTrend(recent, prior);
  console.debug('[game-page] trendSummary', { dir: t.dir, delta: t.delta, recentCount: t.recentCount, priorCount: t.priorCount, source: 'computeCompatTrend' });
  // Insufficient data (e.g. a game with only a couple of old reports) shows
  // nothing rather than a misleading verdict off a tiny baseline. The trend is
  // playable-share based, so a platinum->gold drift reads as stable, not a
  // decline.
  if (t.dir === 'insufficient') return '';
  const counts = `${t.recentCount} recent vs ${t.priorCount} prior reports`;
  const word = t.dir === 'improving'
    ? '<strong style="color:var(--green)">improving</strong>'
    : t.dir === 'declining'
      ? '<strong style="color:var(--red)">declining</strong>'
      : '<strong>stable</strong>';
  // The whole line links to the stats page trend section, which explains how
  // the direction is computed (playable share, windows, min sample).
  const href = appId != null ? `game-stats.html?app=${encodeURIComponent(appId)}#trend` : '';
  const body = `Compatibility is ${word} - ${counts} <span class="trend-more">how this works &rarr;</span>`;
  return href
    ? `<div class="trend"><a class="trend-link" href="${href}" title="How the compatibility trend is calculated">${body}</a></div>`
    : `<div class="trend">${body}</div>`;
}

// - Deck Verified status helpers (stub for now) -------
//

export async function renderGamePage(appId) {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading reports...</div>';

  window._ppMyUserId = '';
  if (window.SupaAuth) {
    try { const s = await window.SupaAuth.getSession(); window._ppMyUserId = s?.user?.id || ''; } catch {}
  }

  // Admin-hidden game gate (#234 bug follow-up). The admin panel writes to
  // game_hides but nothing on the frontend consumed it, so a hidden game
  // could still be loaded via a direct #/app/<id> hash. Refuse to render
  // the page and point the user home instead.
  try {
    const hides = await loadGameHides();
    if (hides && hides.has(String(appId))) {
      el.innerHTML = `
        <div class="state-box" style="max-width:520px;margin:40px auto;text-align:center">
          <h2 style="margin-top:0">Game hidden</h2>
          <p style="color:var(--muted);margin:14px 0">This game has been removed from Proton Pulse by an admin. If you think this is a mistake, contact the maintainer.</p>
          <p style="color:var(--muted);font-size:0.85em">App ID: <code>${String(appId).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</code></p>
          <a href="index.html" class="submit-report-btn" style="display:inline-block;margin-top:12px">Back to home</a>
        </div>`;
      return;
    }
  } catch { /* if the fetch fails, fall through and render normally */ }

  // Adult-content gate: if the search-index flags this appId as adult
  // and the "Show adult games" preference is off, render a block page
  // instead of loading reports. The block page offers a one-click
  // reveal that turns the pref on and reloads.
  if (!showAdultAllowed()) {
    await loadSearchIndex();
    const entry = (searchIndex || []).find(row => String(row[0]) === String(appId));
    if (entry && isAdultEntry(entry)) {
      const title = String(entry[1] || `App ${appId}`).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
      el.innerHTML = `
        <div class="state-box" style="max-width:520px;margin:40px auto;text-align:center">
          <h2 style="margin-top:0">${title} is hidden</h2>
          <p style="color:var(--muted)">
            Steam has flagged this title as containing adult content. It is
            hidden by your "Show adult games" preference.
          </p>
          <p style="color:var(--muted)">
            You can turn this preference on to view the game. The setting is
            saved locally in this browser.
          </p>
          <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
            <button type="button" id="adult-reveal-btn" class="btn btn-primary">Show adult games and view</button>
            <a href="index.html" class="btn">Back to home</a>
          </div>
        </div>`;
      const revealBtn = document.getElementById('adult-reveal-btn');
      if (revealBtn) {
        revealBtn.addEventListener('click', () => {
          try { localStorage.setItem('pp:show-adult', 'on'); } catch {}
          location.reload();
        });
      }
      return;
    }
  }

  // Promise.all was hanging silently on Wukong (appId 2358720) when one of
  // the six fetches stalled -- the page sat on "Loading reports..."
  // forever. The individual fetch helpers already have try/catch + safe
  // fallbacks, but a fetch() that never resolves (network blip,
  // browser-level timeout much longer than user patience) would still
  // block Promise.all. Wrap each one in a 10s timeout race so the worst
  // case is a single missing data source, not a stuck page
  const safeFetch = async (fn, label, fallback) => {
    const TIMEOUT_MS = 10000;
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
      ]);
    } catch (e) {
      console.warn(`[renderGamePage] ${label} failed for app ${appId}:`, e);
      return fallback;
    }
  };
  const [cdnRaw, configs, nativeReports, votes, userVotes, playtimeTotals, suppressedKeys, liveFetched] = await Promise.all([
    safeFetch(() => fetchCdn(appId), 'fetchCdn', []),
    safeFetch(() => fetchSupabase(appId), 'fetchSupabase', []),
    safeFetch(() => fetchNativeReports(appId), 'fetchNativeReports', []),
    safeFetch(() => fetchVotes(appId), 'fetchVotes', {}),
    safeFetch(() => fetchUserVotes(appId), 'fetchUserVotes', {}),
    safeFetch(() => fetchConfigPlaytimeTotals(appId), 'fetchConfigPlaytimeTotals', []),
    safeFetch(() => _fetchReportModeration(appId), 'reportModeration', new Set()),
    // Auto-fetch the ProtonDB live summary on every page load so aggregate
    // stats (tier + total) stay accurate even when our CDN mirror is sparse
    // or missing entirely (#219). The proxy is cached per-appId per-session
    // so re-renders don't re-hit the network.
    safeFetch(() => fetchProtonDbLive(appId), 'fetchProtonDbLive', []),
  ]);

  // Drop ProtonDB mirror reports an admin has shadow-banned or deleted. Pulse
  // reports are filtered server-side by RLS (is_hidden), so they never arrive.
  const cdn = suppressedKeys.size
    ? cdnRaw.filter(r => !suppressedKeys.has(_pdbReportKey(r)))
    : cdnRaw;
  if (suppressedKeys.size && cdn.length !== cdnRaw.length) {
    console.debug('[game-page] filtered suppressed ProtonDB reports', { appId, removed: cdnRaw.length - cdn.length, source: 'report_moderation' });
  }

  // ProtonDB's public summaries API only returns an aggregate (tier + total),
  // not individual reports, so the live result is a single `_liveOnly` summary.
  // It must NOT be rendered as a report card (it has no hardware/date and shows
  // up as a broken "Unknown / NAN days ago" row); instead it drives the header
  // tier + ProtonDB count below.
  //
  // We auto-fetch the summary on every load (#219) so aggregate stats reflect
  // ProtonDB's real numbers even when our CDN mirror only carries a few reports.
  // `liveSummary` is populated whenever we got data; `liveOnly` means we have
  // ZERO cdn reports and are relying purely on the summary.
  const liveSummary = (liveFetched || []).find(r => r._liveOnly) || null;
  const liveOnly = !!liveSummary && !cdn.length;
  const cdnMiss = !cdn.length && !(liveFetched || []).length;

  const reports = [
    ...cdn.map(r => ({ ...r, source: 'protondb' })),
    ...nativeReports,
  ];

  // Hard miss: nothing in cache, nothing native, nothing from Pulse.
  // Check if we at least know this game from the search-index (title available)
  // so we can show a stub state instead of the generic mirror-miss message.
  if (!reports.length && !configs.length && !liveSummary) {
    await loadSearchIndex();
    const stubHit = (searchIndex || []).find(row => String(row[0]) === String(appId));
    let stubTitle = stubHit?.[1];
    if (!stubTitle) {
      const catalog = await _fetchSteamCatalog();
      stubTitle = catalog?.[String(appId)] || null;
    }
    if (stubTitle) {
      // Known game with no reports yet -- show a stub page with a submit CTA.
      const imgUrl = STEAM_IMG(appId);
      const store = storeLabelFromAppId(appId);
      el.innerHTML = `
        <div class="stub-page">
          <div class="stub-header">
            <img class="stub-img" src="${esc(imgUrl)}" data-appid="${esc(String(appId))}" alt="" loading="lazy"
              onerror="window.__steamImgLoad(this)">
            <div class="stub-meta">
              <h1 class="stub-title">${esc(stubTitle)}</h1>
              <div class="stub-pills">
                <span class="tier-badge tier-badge--pending">Not rated yet</span>
                <span class="game-card-store-pill game-card-store-pill--${store.toLowerCase()}">${store}</span>
              </div>
            </div>
          </div>
          <div class="stub-body">
            <p class="stub-message">No compatibility reports exist for this game yet. If you have played it on Steam Deck or Linux, your report helps other players know what to expect.</p>
            <a class="submit-report-btn" href="submit.html?app=${esc(String(appId))}&title=${encodeURIComponent(stubTitle)}" style="display:inline-block;margin-top:4px">Submit the first report</a>
          </div>
          <div class="stub-live-check" style="margin-top:20px">
            <button id="live-check-btn" class="live-check-pill">Check ProtonDB Live</button>
            <span id="live-check-status" style="margin-left:10px;font-size:0.85rem;color:var(--muted)"></span>
          </div>
        </div>`;
    } else {
      // Truly unknown game -- generic mirror-miss state.
      el.innerHTML = `
        <div class="state-box">
          <p style="margin:0 0 10px">This game (<strong>${esc(String(appId))}</strong>) is not in our cached ProtonDB mirror.</p>
          <p style="margin:0 0 14px;color:var(--muted);font-size:0.88rem">Our mirror updates periodically. You can check ProtonDB live, but please use this sparingly to avoid overloading their API.</p>
          <button id="live-check-btn" class="live-check-pill">Check ProtonDB Live</button>
          <span id="live-check-status" style="margin-left:10px;font-size:0.85rem;color:var(--muted)"></span>
        </div>`;
    }
    el.querySelector('#live-check-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const status = el.querySelector('#live-check-status');
      btn.disabled = true;
      btn.textContent = 'Checking...';
      if (status) status.textContent = '';
      const live = await fetchProtonDbLive(appId);
      if (live.length) {
        await renderGamePage(appId);
      } else {
        btn.disabled = false;
        btn.textContent = 'Check ProtonDB Live';
        if (status) status.textContent = 'Not found on ProtonDB either.';
      }
    });
    return;
  }

  // Resolve a human-readable title. Order, most specific first:
  //   1. report title (mirrored/local data carries it)
  //   2. config appName (Pulse Reports carry the user's chosen title)
  //   3. search-index hit (.[1] is the title column)
  //   4. steam-catalog lookup (covers live-only apps that are not in our
  //      search-index but still on Steam -- the #115 case)
  //   5. bare "App <id>" -- last resort when nothing else can resolve a name
  await loadSearchIndex();
  const indexHit = (searchIndex || []).find(row => String(row[0]) === String(appId));
  let resolvedTitle = reports[0]?.title || configs[0]?.appName || indexHit?.[1];
  if (!resolvedTitle && /^\d+$/.test(String(appId))) {
    const catalog = await _fetchSteamCatalog();
    resolvedTitle = catalog?.[String(appId)] || null;
  }
  const title = resolvedTitle || `App ${appId}`;
  // Steam returned success=false from appdetails for this app: it has been
  // pulled from the store. Reports remain valid (people still own it via
  // family share, backups, or regional accounts) -- we just flag it so the
  // visitor knows there is no Steam page to visit.
  const isDelisted = !!indexHit?.[7];
  // Column 10 (added by game_images.py + enrich_search_index_with_delisted):
  // Steam replaced this appid with a newer one (e.g. 5488 -> 45700 for Devil
  // May Cry 4, Hitman 1/2 -> World of Assassination). Powers a banner + card
  // badge so users see the current appid and new submits land there instead.
  const replacedBy = indexHit?.[10] ? String(indexHit[10]) : '';
  const replacedByTitle = replacedBy
    ? (searchIndex || []).find(row => String(row[0]) === replacedBy)?.[1] || `App ${replacedBy}`
    : '';
  // Effective ProtonDB report count: MAX of mirrored count and live aggregate
  // (#219). ProtonDB's mirror often lags -- Hollow Knight has thousands of
  // reports on ProtonDB but only a handful in our CDN. Take the higher number
  // so the confidence % + "N reports" text reflect ProtonDB's real breadth,
  // not just what we happen to have cached.
  const liveTotal = liveSummary ? (liveSummary.total || 0) : 0;
  const protonDbCount = Math.max(cdn.length, liveTotal);
  // Tier: prefer the mirrored sample when we have cards to back it up,
  // otherwise the live summary tier. Both use the same tier vocabulary.
  const protonDbTier = liveOnly
    ? String(liveSummary.tier || '').toLowerCase()
    : (tierFromReports(cdn) || String(liveSummary?.tier || '').toLowerCase());
  const pulseTier = pulseTierFromReports(nativeReports, protonDbCount);
  document.title = `${title} - Proton Pulse`;
  if (typeof window.ppTrack === 'function') window.ppTrack('game_view', { app_id: String(appId), title });

  const totalCommunityMinutes = playtimeTotals.reduce((s, r) => s + (r.total_minutes || 0), 0);
  const totalSessionCount = playtimeTotals.reduce((s, r) => s + (r.session_count || 0), 0);

  let sortMode = 'recent';
  // Filter state. Persisted to localStorage when the user ticks the "Save"
  // checkbox - same shape works whether signed in or not (profile sync can
  // layer on top later by mirroring this object to the user_configs row).
  const FILTER_STORAGE_KEY = 'proton-pulse:report-filters';
  const FILTER_PERSIST_KEY = 'proton-pulse:report-filters-persist';
  const persistedFilters = (() => {
    try {
      if (localStorage.getItem(FILTER_PERSIST_KEY) !== '1') return {};
      return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}') || {};
    } catch { return {}; }
  })();

  let filterGpu    = persistedFilters.gpu    || '';
  let filterArch   = persistedFilters.arch   || '';
  let filterOs     = persistedFilters.os     || '';
  let filterRating = persistedFilters.rating || '';
  // Native vs Proton (or a specific proton wrapper). '' == any. Reports
  // without a run_type value are treated as unknown so they never
  // accidentally match a specific selection.
  let filterRunType = persistedFilters.runType || '';
  // 'deck-lcd' / 'deck-oled' / 'deck-any' / 'desktop' / ''
  let filterDevice = persistedFilters.device || '';
  // Minimum reporter playtime in minutes (0 = any). Useful to skip "launched
  // it once" reports that don't reflect real-use compatibility
  let filterMinPlaytime = persistedFilters.minPlaytime || 0;
  let filterMine = false;
  let persistFilters = localStorage.getItem(FILTER_PERSIST_KEY) === '1';

  function saveFiltersIfEnabled() {
    if (!persistFilters) return;
    try {
      const snapshot = { gpu: filterGpu, arch: filterArch, os: filterOs, rating: filterRating, runType: filterRunType, device: filterDevice, minPlaytime: filterMinPlaytime, source: filterSource };
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(snapshot));
    } catch { /* quota / disabled - ignore */ }
  }
  // Unified source filter across configs + reports: 'pulse-config', 'pulse-report',
  // 'protondb', or '' for any
  let filterSource = (() => {
    const raw = persistedFilters.source || localStorage.getItem('proton-pulse:config-type') || '';
    if (raw === 'pulse-config' || raw === 'pulse-report') return 'pulse';
    if (raw === 'protondb-edited') return 'protondb';
    return raw;
  })();

  const gpuVendor = g => {
    if (!g) return '';
    const l = g.toLowerCase();
    if (/nvidia|geforce|rtx|gtx/.test(l)) return 'nvidia';
    if (/\bamd\b|radeon/.test(l)) return 'amd';
    if (/\bintel\b|iris|arc\b/.test(l)) return 'intel';
    return '';
  };
  const osBase = o => {
    if (!o) return '';
    return o.trim().split(/\s+/)[0];
  };

  // Tag each incoming item with the bucket it belongs to so we can render + filter
  // from one unified list. 'pulse-report' covers both plugin and web submissions,
  // 'protondb' is the upstream mirror, 'pulse-config' is a saved launch profile
  const taggedReports = reports.map((r) => {
    const src = (r.source || '').toLowerCase();
    const bucket = src === 'protondb' ? 'protondb' : 'pulse-report';
    return { ...r, _kind: 'report', _bucket: bucket };
  });
  const taggedConfigs = configs.map((c) => {
    const src = (c.source || '').toLowerCase();
    const bucket = src === 'protondb'
      ? (c.isEdited ? 'protondb-edited' : 'protondb')
      : 'pulse-config';
    return { ...c, _kind: 'config', _bucket: bucket };
  });
  const combined = [...taggedConfigs, ...taggedReports];

  // Resolve architecture: use stored gpuArchitecture field when available,
  // fall back to detecting from the gpu model string for older reports.
  const gpuArch = r => r.gpuArchitecture || detectGpuArch(r.gpu);

  const filtered = () => {
    let arr = [...combined];
    if (filterGpu)    arr = arr.filter(r => gpuVendor(r.gpu) === filterGpu);
    if (filterArch)   arr = arr.filter(r => gpuArch(r) === filterArch);
    if (filterOs)     arr = arr.filter(r => osBase(r.os) === filterOs);
    if (filterRunType) arr = arr.filter(r => (r.runType || '') === filterRunType);
    if (filterDevice) {
      arr = arr.filter(r => {
        const haystack = `${r.cpu || ''} ${r.gpu || ''}`;
        const isLcd  = _DECK_LCD_RE.test(haystack);
        const isOled = _DECK_OLED_RE.test(haystack);
        const isMachine = _STEAM_MACHINE_RE.test(haystack);
        if (filterDevice === 'deck-lcd')  return isLcd;
        if (filterDevice === 'deck-oled') return isOled;
        if (filterDevice === 'deck-any')  return isLcd || isOled;
        if (filterDevice === 'steam-machine') return isMachine;
        if (filterDevice === 'desktop')   return !isLcd && !isOled && !isMachine;
        return true;
      });
    }
    if (filterMinPlaytime > 0) {
      // Match against durationMinutes if present; otherwise translate the
      // bucketed duration enum to a coarse minute count so old reports still
      // get filtered consistently
      const DUR_MIN = { underOneHour: 0, oneToFourHours: 60, fourToTenHours: 240, overTenHours: 600 };
      arr = arr.filter(r => {
        if (r.durationMinutes != null) return r.durationMinutes >= filterMinPlaytime;
        const m = DUR_MIN[r.duration];
        return m != null && m >= filterMinPlaytime;
      });
    }
    // Rating filter only makes sense for reports. Configs don't carry a rating,
    // so drop them when the user explicitly narrows by rating
    if (filterRating) arr = arr.filter(r => r._kind === 'report' && r.rating === filterRating);
    if (filterSource === 'protondb') arr = arr.filter(r => r._bucket === 'protondb' || r._bucket === 'protondb-edited');
    else if (filterSource === 'pulse') arr = arr.filter(r => r._bucket === 'pulse-config' || r._bucket === 'pulse-report');
    else if (filterSource) arr = arr.filter(r => r._bucket === filterSource);
    if (filterMine) {
      const myCid = getWebClientId();
      const myPpid = window._ppMyUserId || '';
      arr = arr.filter(r => (myCid && r.clientId === myCid) || (myPpid && r.protonPulseUserId === myPpid));
    }
    return arr;
  };

  const sorted = () => {
    const arr = filtered();
    if (sortMode === 'recent') arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    else if (sortMode === 'votes') arr.sort((a, b) => {
      const aKey = a._kind === 'config' ? configKey(a) : reportKey(a);
      const bKey = b._kind === 'config' ? configKey(b) : reportKey(b);
      const va = votes[aKey] || { up:0, down:0 };
      const vb = votes[bKey] || { up:0, down:0 };
      return (vb.up - vb.down) - (va.up - va.down);
    });
    return arr;
  };

  function render() {
    const reps = sorted();
    const protonDbBadgeColor = RATING_COLORS[protonDbTier] || '#3a4a5a';
    const protonDbBadgeText = RATING_TEXT[protonDbTier] || '#c8d4e0';
    const pulseHasReports = nativeReports.length > 0;
    const pulseHasConfigs = configs.length > 0;
    const pulseSummaryBits = [];
    if (pulseHasReports) pulseSummaryBits.push(`${nativeReports.length} report${nativeReports.length !== 1 ? 's' : ''}`);
    if (pulseHasConfigs) pulseSummaryBits.push(`${configs.length} config${configs.length !== 1 ? 's' : ''}`);
    // Combined tile - Pulse + ProtonDB roll into one homogeneous "Community"
    // summary since the report list below mixes both sources too. pulseTier
    // already accepts a protonDbCount that weights both sources into one
    // overall rating + confidence, which is exactly what we want here
    const totalReports = nativeReports.length + protonDbCount;
    const hasAnyReports = totalReports > 0;
    // Use the combined-source tier when there are any reports; fall back to
    // protondb tier if only protondb reports exist; "pending" when nothing
    const overallTier = hasAnyReports
      ? (pulseHasReports ? pulseTier.tier : protonDbTier)
      : 'pending';
    const overallTileColor = hasAnyReports ? (RATING_COLORS[overallTier] || '#3a4a5a') : '#2a5a8c';
    // Confidence percent is the single source of truth -- the same value the
    // dial shows and confidence.html buckets. Prefer Pulse's computed
    // confidencePct (weights both sources) when there are Pulse reports;
    // otherwise a sample-size approximation against the ProtonDB count alone.
    const overallConfidencePct = pulseHasReports && pulseTier.confidencePct
      ? pulseTier.confidencePct
      : (protonDbCount > 0 ? Math.min(95, Math.round(30 + Math.log2(Math.max(1, protonDbCount)) * 18)) : 0);
    // Bucket the summary label off the SAME percent thresholds confidence.html
    // uses (>=80 high, >=50 moderate, else low) so the dial %, this line, and
    // the "why?" page never disagree (#187). The old code bucketed by report
    // COUNT, which said "medium" for a 14-report game the dial showed at 95%.
    const confBucket = !hasAnyReports ? '' : overallConfidencePct >= 80 ? 'high' : overallConfidencePct >= 50 ? 'moderate' : 'low';
    // "N reports" where N = pulse + protonDbCount (which is MAX(mirror, live)).
    // When the live total drives the count, tag the source so users understand
    // the summary is authoritative even when we mirror only a small slice (#219).
    const _fromLive = !!liveSummary && liveTotal > cdn.length;
    const overallTileSummary = hasAnyReports
      ? `${confBucket} confidence across ${totalReports.toLocaleString()} report${totalReports !== 1 ? 's' : ''}${_fromLive ? ' (via ProtonDB live)' : ''}${pulseHasConfigs ? ` / ${configs.length} config${configs.length !== 1 ? 's' : ''}` : ''}`
      : (pulseHasConfigs ? 'Community-submitted configs available' : 'No community data yet');
    // Rating distribution: one horizontal bar per tier, filled with the tier
    // color and scaled to the busiest tier so the shape reads at a glance.
    // Live-only games (ProtonDB summary) have no per-tier breakdown.
    const allReports = [...nativeReports, ...cdn];
    const ratingCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0 };
    for (const r of allReports) {
      if (ratingCounts[r.rating] != null) ratingCounts[r.rating]++;
    }
    const TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
    const TIER_FULL = { platinum: 'PLATINUM', gold: 'GOLD', silver: 'SILVER', bronze: 'BRONZE', borked: 'BORKED' };
    const maxTierCount = Math.max(1, ...TIER_ORDER.map((t) => ratingCounts[t]));
    // ProtonDB's summary API only exposes aggregate fields (no per-tier
    // counts), so we can never draw the 5-bar breakdown from a live-only
    // game. Keep the standard 5-bar layout no matter what, and prepend a
    // one-line note showing the ProtonDB rating + total when we have it so
    // users see "PLATINUM * 371 reports" alongside the (possibly empty) bars.
    const _liveTierKey = liveSummary ? String(liveSummary.tier || '').toLowerCase() : '';
    const _liveNote = liveSummary
      ? `<div class="grp-bars-note grp-bars-note--live">
          ProtonDB rating: <strong>${esc(String(liveSummary.tier || '').toUpperCase())}</strong> &middot; <strong>${liveTotal.toLocaleString()}</strong> report${liveTotal !== 1 ? 's' : ''}
        </div>`
      : '';
    const tierBars = `<div class="grp-bars">${_liveNote}${TIER_ORDER.map((t) => {
          const n = ratingCounts[t];
          const pct = Math.round((n / maxTierCount) * 100);
          return `<div class="grp-bar grp-bar-${t}" title="${n} ${t} report${n !== 1 ? 's' : ''}">
              <span class="grp-bar-label">${TIER_FULL[t]}</span>
              <span class="grp-bar-track"><span class="grp-bar-fill" style="width:${pct}%;background:${RATING_COLORS[t]}"></span></span>
              <span class="grp-bar-count">${n}</span>
            </div>`;
        }).join('')}</div>`;

    // Confidence gauge dial: ring fill = overall confidence %, with the tier
    // name and a "confidence" caption in the center.
    const _DIAL_R = 54;
    const _DIAL_C = 2 * Math.PI * _DIAL_R;
    const _dialPct = hasAnyReports ? Math.max(0, Math.min(100, Math.round(overallConfidencePct || 0))) : 0;
    const _dialOffset = _DIAL_C * (1 - _dialPct / 100);
    // Short labels match the tier bars on the right (PLAT/GOLD/SILV/BRON/BORK).
    // CSS shows the abbreviated form on narrow screens so PLATINUM doesn't
    // spill past the 118px dial diameter.
    const _dialInner = `
        <div class="grp-dial-verdict" style="color:${overallTileColor}">${overallTier}</div>
        <div class="grp-dial" title="Aggregate confidence: ${_dialPct}%">
          <svg viewBox="0 0 132 132" aria-hidden="true">
            <circle cx="66" cy="66" r="${_DIAL_R}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="12"></circle>
            <circle cx="66" cy="66" r="${_DIAL_R}" fill="none" stroke="${overallTileColor}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${_DIAL_C.toFixed(1)}" stroke-dashoffset="${_dialOffset.toFixed(1)}" transform="rotate(-90 66 66)"></circle>
          </svg>
          <div class="grp-dial-ctr">
            <span class="grp-dial-pct">${hasAnyReports ? _dialPct + '%' : '--'}</span>
            <span class="grp-dial-cap">confidence</span>
          </div>
        </div>`;
    // The whole dial links to the factor-by-factor breakdown (same target as the
    // "why?" link) so clicking the hero circle explains how the rating was reached.
    const gaugeDial = hasAnyReports
      ? `<a class="grp-dial-block grp-dial-link" href="confidence.html?app=${appId}&tier=${overallTier}" title="See how this ${overallTier} rating and its confidence were calculated">${_dialInner}</a>`
      : `<div class="grp-dial-block">${_dialInner}</div>`;

    // Panel footer: confidence summary (+ link to the scoring breakdown), then
    // App id / newest report on one meta line. The per-source split
    // (N Pulse / M ProtonDB) lives on the stats page now -- keeping it
    // out of the hero cuts the noise on small screens.
    const newestTs = allReports.length ? Math.max(...allReports.map((r) => r.timestamp || 0)) : 0;
    const _freshBit = newestTs ? `newest report: <strong>${daysAgo(newestTs)}</strong>` : '';
    const _metaBits = [`App ${esc(String(appId))}`, _freshBit].filter(Boolean).join(' &middot; ');
    const _confWhy = hasAnyReports
      ? ` <a class="grp-why conf-link" href="confidence.html?app=${appId}&tier=${overallTier}" title="See the factor-by-factor breakdown of this aggregate confidence">why?</a>`
      : '';
    const ratingPanel = `<div class="game-rating-panel">
        <div class="grp-row">${gaugeDial}${tierBars}</div>
        <div class="grp-foot">
          <div class="grp-conf">${overallTileSummary}${_confWhy}</div>
          <div class="grp-meta">${_metaBits}</div>
        </div>
      </div>`;

    // Flag button target: the Game Report GitHub issue template, prefilled with
    // the title, AppID, and a short starter body so the reporter just fills in
    // the details. Fields map to game_report.yml ids (game_name / app_id / description).
    const _flagStarter = 'What looks wrong:\n\nWhat I expected:\n\n';
    const flagUrl = `https://github.com/mdeguzis/proton-pulse-web/issues/new?template=game_report.yml&game_name=${encodeURIComponent(title)}&app_id=${encodeURIComponent(String(appId))}&description=${encodeURIComponent(_flagStarter)}`;

    // Replaced-by banner: this appid was superseded by a newer one. Point new
    // submits at the new appid so they land where users can find them, but
    // leave a fallback link for people who still play the exact old version.
    const replacedBanner = replacedBy
      ? `<div class="game-replaced-banner">
          <strong>This app has been replaced.</strong>
          Steam now sells this title as <a class="game-replaced-link" href="#/app/${esc(replacedBy)}">${esc(replacedByTitle)}</a>.
          Old app id: <code>${esc(String(appId))}</code>, new app id: <code>${esc(replacedBy)}</code>.
          New reports go to the new app automatically. Old reports on this page still apply if you're playing the original build.
        </div>`
      : '';
    const submitHref = replacedBy
      ? `submit.html?app=${esc(replacedBy)}&title=${encodeURIComponent(replacedByTitle || title)}`
      : `submit.html?app=${appId}&title=${encodeURIComponent(title)}`;
    const submitBtnTitle = replacedBy
      ? `Submit a report against the current appid (${replacedBy}) so it lands where users of the new version will find it`
      : '';
    const submitOldFallback = replacedBy
      ? ` <a class="submit-report-legacy" href="submit.html?app=${appId}&title=${encodeURIComponent(title)}" title="Submit a report against the original appid (${appId}) instead of the replacement">Old build?</a>`
      : '';

    el.innerHTML = `
      <div class="game-header">
        ${replacedBanner}
        <div class="game-title">${esc(title)} <span class="game-title-store" title="Storefront this entry maps to">(${esc(storeLabelFromAppId(appId) || 'Steam')})</span>${isDelisted ? ' <span class="game-detail-delisted" title="Removed from the Steam store. Reports still apply -- people still own this via family share, backups, or regional accounts.">DELISTED</span>' : ''}${replacedBy ? ` <span class="game-title-replaced-pill" title="Replaced by app ${esc(replacedBy)}: ${esc(replacedByTitle)}">REPLACED</span>` : ''}${/\bdemo\b/i.test(title) ? ' <span class="game-title-demo-pill" title="This entry looks like a demo based on the title. Reports may not reflect the full game.">DEMO</span>' : ''}</div>
        <div class="game-header-grid">
          <div class="game-header-art-col">
            <img class="game-header-art" src="${STEAM_IMG(appId)}" data-appid="${appId}" alt="" onerror="window.__steamImgLoad(this)">
          </div>
          ${ratingPanel}
          <!-- Uniform tag row under the artwork: OS chips + user-context
               tags (On wishlist / In library) share the same rounded-square
               shape as the Submit Report button. Placed in grid row 2 col 1
               (the previously empty cell to the left of the action buttons)
               so it sits snug under the artwork WITHOUT growing the left
               column height. Each group hides itself until its data resolves. -->
          <div class="game-header-art-tags" aria-label="Game tags">
            <div class="game-os-strip" id="game-os-strip" hidden aria-label="Supported operating systems">
              <button type="button" class="game-tag game-os-chip" data-os="windows" title="Windows">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 5.5L10 4.5V11H3V5.5zm8-1.2L21 3v8H11V4.3zM3 12h7v6.5L3 17.5V12zm8 0h10v9L11 19.5V12z"/></svg>
                <span>Win</span>
              </button>
              <button type="button" class="game-tag game-os-chip" data-os="mac" title="macOS">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M17.5 12.5c0-2.6 2.1-3.9 2.2-4-1.2-1.8-3.1-2-3.8-2.1-1.6-.2-3.1.9-3.9.9-.8 0-2.1-.9-3.4-.9-1.8 0-3.4 1-4.3 2.6-1.8 3.2-.5 7.9 1.3 10.5.9 1.3 2 2.7 3.4 2.6 1.4 0 1.9-.9 3.6-.9 1.7 0 2.1.9 3.5.9 1.5 0 2.4-1.3 3.3-2.6 1-1.5 1.4-2.9 1.4-3-.1 0-2.7-1-2.7-4zM14.5 4.7c.7-.9 1.2-2.1 1-3.3-1.1.1-2.4.8-3.1 1.6-.7.8-1.3 2-1.1 3.2 1.2.1 2.4-.6 3.2-1.5z"/></svg>
                <span>macOS</span>
              </button>
              <button type="button" class="game-tag game-os-chip" data-os="linux" title="Linux">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2c-1.66 0-3 1.34-3 3v3.5c-1.5 1-3 2.5-3 5.5 0 2.5 1 4.5 2 5.5.5.5 1 1 1 2v.5h6V21c0-1 .5-1.5 1-2 1-1 2-3 2-5.5 0-3-1.5-4.5-3-5.5V5c0-1.66-1.34-3-3-3zm-1.5 5c.28 0 .5.22.5.5s-.22.5-.5.5-.5-.22-.5-.5.22-.5.5-.5zm3 0c.28 0 .5.22.5.5s-.22.5-.5.5-.5-.22-.5-.5.22-.5.5-.5zM12 11l-1.5 2h3L12 11z"/></svg>
                <span>Linux</span>
              </button>
            </div>
            <div class="game-type-strip" id="game-type-strip" hidden aria-label="App type"></div>
            <div class="game-user-tags" id="game-user-tags" aria-label="Your Steam context"></div>
          </div>
          <div class="game-header-actions">
            <a class="info-btn" href="scoring.html" id="rating-info-btn" title="How scoring works (opens the canonical scoring page)"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="11" fill="#3b82f6"/><text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="serif">i</text></svg></a>
            <a class="info-btn info-btn-flag" id="flag-game-btn" href="${flagUrl}" target="_blank" rel="noopener" title="Flag a problem with this game entry (opens the Game Report template)"><svg width="17" height="17" viewBox="0 0 24 24" fill="#e0554f"><path d="M14.4 6l-.4-2H5v17h2v-7h5.6l.4 2h7V6z"/></svg></a>
            <a class="info-btn info-btn-labeled" id="stats-btn" href="game-stats.html?app=${appId}" title="Per-game compatibility stats: confidence factors, trend, Proton version success rates, launch option frequency, and proven launch options"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="4" height="18" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="17" y="12" width="4" height="9" rx="1"/></svg><span>Stats</span></a>
            ${renderDeckStatusButton(appId)}
            <a class="submit-report-btn" href="${submitHref}" title="${esc(submitBtnTitle)}">Submit Report</a>${submitOldFallback}
          </div>
        </div>
        <div class="info-tooltip" id="deck-status-tip">
          <div class="info-tooltip-inner" id="deck-status-content">${renderDeckStatusModalContent(appId)}</div>
        </div>
        <!-- External link footer lives inside the game-header banner so it
             reads as part of the game's metadata strip. The links flex to fill
             the row width and wrap responsively (no trailing caret). -->
        <div class="hub-links hub-links-in-banner">
          <a class="hub-link" href="https://store.steampowered.com/app/${appId}" target="_blank" rel="noopener">Steam</a>
          <a class="hub-link" href="https://steamdb.info/app/${appId}/" target="_blank" rel="noopener">SteamDB</a>
          <a class="hub-link" href="https://www.protondb.com/app/${appId}" target="_blank" rel="noopener">ProtonDB</a>
          <a class="hub-link" href="https://www.pcgamingwiki.com/w/index.php?search=${encodeURIComponent(title)}" target="_blank" rel="noopener">PCGamingWiki</a>
          <a class="hub-link" href="https://steamcharts.com/app/${appId}" target="_blank" rel="noopener">Steam Charts</a>
          <a class="hub-link" href="https://github.com/ValveSoftware/Proton/issues?q=${encodeURIComponent(title)}" target="_blank" rel="noopener">Proton Issues</a>
          <a class="hub-link" href="${dataFilesHref(appId)}" target="_blank" rel="noopener">Data Files</a>
          <button type="button" class="hub-link" id="hub-metadata-btn" title="Formatted Steam appdetails: developer, publisher, systems, release date, genres">Metadata</button>
        </div>
      </div>

      ${trendSummary(reports, appId)}

      <div class="reports-section-head" id="pulse-summary">
        <div class="reports-section-copy">
          <span class="reports-section-title">Community Configs &amp; Reports</span>
        </div>
      </div>

      <div class="reports-controls-row">
        <div class="filter-wrap">
        ${(() => {
          const GPU_LABEL = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };
          const RATING_LABEL = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked' };
          const RATING_ORDER = ['platinum','gold','silver','bronze','borked'];

          const availGpus    = [...new Set(combined.map(r => gpuVendor(r.gpu)).filter(Boolean))];
          const availArchs   = [...new Set(combined.map(r => gpuArch(r)).filter(Boolean))].sort();
          const availOs      = [...new Set(combined.map(r => osBase(r.os)).filter(Boolean))].sort();
          const availRatings = RATING_ORDER.filter(rt => taggedReports.some(r => r.rating === rt));

          const gpuSel = availGpus.length > 0 ? `
            <div class="filter-item">
              <label for="fGpu">GPU</label>
              <select id="fGpu">
                <option value="">Any</option>
                ${availGpus.map(v => `<option value="${v}" ${filterGpu===v?'selected':''}>${GPU_LABEL[v]||v}</option>`).join('')}
              </select>
            </div>` : '';
          const archSel = availArchs.length > 1 ? `
            <div class="filter-item">
              <label for="fArch">Architecture</label>
              <select id="fArch">
                <option value="">Any</option>
                ${availArchs.map(v => `<option value="${esc(v)}" ${filterArch===v?'selected':''}>${esc(v)}</option>`).join('')}
              </select>
            </div>` : '';
          const osSel = availOs.length > 0 ? `
            <div class="filter-item">
              <label for="fOs">OS</label>
              <select id="fOs">
                <option value="">Any</option>
                ${availOs.map(v => `<option value="${esc(v)}" ${filterOs===v?'selected':''}>${esc(v)}</option>`).join('')}
              </select>
            </div>` : '';
          const ratingSel = availRatings.length > 0 ? `
            <div class="filter-item">
              <label for="fRating">Rating</label>
              <select id="fRating">
                <option value="">Any</option>
                ${availRatings.map(v => `<option value="${v}" ${filterRating===v?'selected':''}>${RATING_LABEL[v]||v}</option>`).join('')}
              </select>
            </div>` : '';
          // Run-type filter: only show when this game has at least one report
          // carrying a run_type (legacy reports have null and would otherwise
          // clutter the modal with an "Any / Proton" toggle that does nothing).
          const RUN_TYPE_LABEL = {
            native:                'Native Linux',
            proton:                'Proton',
            'proton-experimental': 'Proton Experimental',
            'proton-ge':           'Proton GE',
            'proton-cachyos':      'CachyOS Proton',
            'proton-tkg':          'Proton-TKG',
            'proton-lsfg':         'Proton + LSFG',
          };
          const availRunTypes = [...new Set(combined.map(r => r.runType).filter(Boolean))].sort();
          const runTypeSel = availRunTypes.length > 0 ? `
            <div class="filter-item">
              <label for="fRunType">Runtime Type</label>
              <select id="fRunType">
                <option value="">Any</option>
                ${availRunTypes.map(v => `<option value="${esc(v)}" ${filterRunType===v?'selected':''}>${RUN_TYPE_LABEL[v]||v}</option>`).join('')}
              </select>
            </div>` : '';
          const srcSel = `
            <div class="filter-item">
              <label for="fSource">Source</label>
              <select id="fSource">
                <option value="">All</option>
                <option value="protondb" ${filterSource==='protondb'?'selected':''}>ProtonDB</option>
                <option value="pulse" ${filterSource==='pulse'?'selected':''}>Pulse</option>
              </select>
            </div>`;
          const hasDeck = combined.some(r => {
            const h = `${r.cpu || ''} ${r.gpu || ''}`;
            return _DECK_LCD_RE.test(h) || _DECK_OLED_RE.test(h);
          });
          const deviceSel = hasDeck ? `
            <div class="filter-item">
              <label for="fDevice">Device</label>
              <select id="fDevice">
                <option value="">Any</option>
                <option value="deck-any"  ${filterDevice==='deck-any'?'selected':''}>Steam Deck (any)</option>
                <option value="deck-lcd"  ${filterDevice==='deck-lcd'?'selected':''}>Steam Deck LCD</option>
                <option value="deck-oled" ${filterDevice==='deck-oled'?'selected':''}>Steam Deck OLED</option>
                <option value="steam-machine" ${filterDevice==='steam-machine'?'selected':''}>Steam Machine</option>
                <option value="desktop"   ${filterDevice==='desktop'?'selected':''}>Desktop / other</option>
              </select>
            </div>` : '';
          const playtimeSel = `
            <div class="filter-item">
              <label for="fPlaytime">Min playtime</label>
              <select id="fPlaytime">
                <option value="0"   ${filterMinPlaytime===0?'selected':''}>Any</option>
                <option value="60"  ${filterMinPlaytime===60?'selected':''}>1h+</option>
                <option value="120" ${filterMinPlaytime===120?'selected':''}>2h+</option>
                <option value="240" ${filterMinPlaytime===240?'selected':''}>4h+</option>
                <option value="600" ${filterMinPlaytime===600?'selected':''}>10h+</option>
              </select>
            </div>`;

          const activeCount = [filterGpu, filterArch, filterOs, filterRating, filterRunType, filterSource, filterDevice, filterMinPlaytime > 0 ? '1' : ''].filter(Boolean).length;
          const anyActive = activeCount > 0;

          return `
            <button class="filter-toggle-btn${activeCount > 0 ? ' has-filters' : ''}" id="filterToggle">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.72-4.8 5.74-7.39C20.25 4.95 19.8 4 18.95 4H5.04C4.2 4 3.74 4.95 4.25 5.61z"/></svg>
              Filters${activeCount > 0 ? ` <span class="filter-badge">${activeCount}</span>` : ''}
            </button>
            ${anyActive ? `<span class="filter-count">${reps.length} of ${combined.length} shown</span>` : ''}
            <div class="filter-panel" id="filterPanel">
              <div class="filter-panel-grid">
                ${gpuSel}${archSel}${osSel}${srcSel}${ratingSel}${runTypeSel}${deviceSel}${playtimeSel}
              </div>
              <div class="filter-panel-footer">
                <label class="filter-persist" title="Save these filters so they apply next time you visit a game page">
                  <input type="checkbox" id="fPersist" ${persistFilters ? 'checked' : ''}>
                  <span>Save filters</span>
                </label>
                ${anyActive ? '<button class="filter-clear-btn" id="filterClear">Clear all</button>' : ''}
              </div>
            </div>
          `;
        })()}
        </div>
        <div class="sort-bar">
          <button class="${sortMode==='recent'?'active':''}" data-sort="recent">Recent</button>
          <button class="${sortMode==='votes'?'active':''}" data-sort="votes">Top Voted</button>
          <button class="sort-mine-btn${filterMine?' active':''}" data-action="toggle-mine">Mine</button>
        </div>
      </div>

      <div class="cards">
        ${liveOnly && !reps.length
          ? `<div class="live-summary-note">
               ProtonDB rates this <strong>${esc(String(liveSummary.tier || '').toUpperCase())}</strong> from <strong>${protonDbCount.toLocaleString()}</strong> report${protonDbCount !== 1 ? 's' : ''} (checked live). Individual reports are not mirrored here yet, so there are no cards to show. <a href="https://www.protondb.com/app/${appId}" target="_blank" rel="noopener">View them on ProtonDB &gt;</a> or submit the first Proton Pulse report below.
             </div>`
          : (reps.length
            ? reps.map((r, i) => r._kind === 'config'
                ? renderConfigCard(r, i, votes, userVotes)
                : renderCard(r, votes, userVotes, playtimeTotals)
              ).join('')
            : '<div class="state-box" style="border:none">No configs or reports match filters</div>')}
      </div>
    `;

    el.querySelectorAll('.sort-bar button[data-sort]').forEach(b =>
      b.onclick = () => { sortMode = b.dataset.sort; render(); }
    );
    el.querySelector('.sort-mine-btn')?.addEventListener('click', () => {
      filterMine = !filterMine;
      render();
    });

    // rating-info-btn is now a plain <a href> to scoring.html - no JS needed.
    // populateScoringTooltip / #rating-info-tip kept around in case anything
    // else still references them (search/etc); safe to delete in a cleanup pass
    // #stats-btn now navigates to game-stats.html?app=ID via plain <a href>,
    // no click handler needed. The old inline tooltip flow is gone
    el.querySelector('#deck-status-btn')?.addEventListener('click', () => {
      // Deck status modal mirrors the Steam Store Deck Compatibility popup -
      // status badge + summary sentence + per-criterion checklist
      el.querySelector('#deck-status-tip')?.classList.toggle('open');
    });
    // Metadata hub link opens the SteamDB-style metadata modal.
    el.querySelector('#hub-metadata-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      void _openMetadataModal(appId);
    });
    el.querySelectorAll('.source-summary-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        const targetId = tile.getAttribute('data-target');
        const target = targetId ? el.querySelector(`#${targetId}`) : null;
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    el.querySelector('#scoring-info-btn')?.addEventListener('click', async () => {
      const tip = el.querySelector('#rating-info-tip');
      tip?.classList.toggle('open');
      if (tip?.classList.contains('open')) await populateScoringTooltip(el);
    });
    el.querySelector('#fGpu')?.addEventListener('change', e => { filterGpu    = e.target.value; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#fArch')?.addEventListener('change', e => { filterArch   = e.target.value; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#fOs')?.addEventListener('change',  e => { filterOs     = e.target.value; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#fRating')?.addEventListener('change', e => { filterRating = e.target.value; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#fRunType')?.addEventListener('change', e => { filterRunType = e.target.value; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#fSource')?.addEventListener('change', e => { filterSource = e.target.value; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#filterToggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      el.querySelector('#filterPanel')?.classList.toggle('open');
    });
    el.querySelector('#filterClear')?.addEventListener('click', () => {
      filterGpu = ''; filterArch = ''; filterOs = ''; filterRating = ''; filterRunType = '';
      filterSource = ''; filterDevice = ''; filterMinPlaytime = 0;
      saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open');
    });
    el.querySelector('#fDevice')?.addEventListener('change', e => { filterDevice = e.target.value; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#fPlaytime')?.addEventListener('change', e => { filterMinPlaytime = parseInt(e.target.value, 10) || 0; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#fPersist')?.addEventListener('change', e => {
      persistFilters = e.target.checked;
      try {
        localStorage.setItem(FILTER_PERSIST_KEY, persistFilters ? '1' : '0');
        if (persistFilters) saveFiltersIfEnabled();
        else localStorage.removeItem(FILTER_STORAGE_KEY);
      } catch { /* quota - ignore */ }
    });
    // Match both the legacy .cfg-dl-btn (Pulse config cards) and the new
    // unified .action-btn (report cards) so the JSON download click works
    // regardless of which renderer produced the button
    el.querySelectorAll('.cfg-dl-btn, .action-btn[data-report-json], .action-btn[data-cfg-json]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        // Cards embed their full payload in data-cfg-json or data-report-json.
        // Falling back to an index lookup broke after configs and reports were
        // merged into one list, so both kinds now carry the JSON inline
        if (b.dataset.cfgJson) downloadJson(JSON.parse(b.dataset.cfgJson), 'pulse-config');
        else if (b.dataset.reportJson) downloadJson(JSON.parse(b.dataset.reportJson), 'report');
      });
    });
    const myClientId = getWebClientId();
    const myPpid = window._ppMyUserId || '';
    el.querySelectorAll('.vote-btns').forEach(btns => {
      const authorId = btns.dataset.authorId;
      const authorPpid = btns.dataset.authorPpid;
      const isOwn = (authorId && authorId === myClientId)
        || (myPpid && authorPpid && authorPpid === myPpid);
      if (isOwn) {
        btns.querySelectorAll('.vote-btn').forEach(b => {
          b.disabled = true;
          b.title = 'You cannot vote on your own report';
        });
      }
    });
    el.querySelectorAll('.vote-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (btn.disabled) return;
        const vote  = parseInt(btn.dataset.vote);
        const rKey  = btn.dataset.rkey;
        const aId   = btn.dataset.appid;
        const btns  = btn.closest('.vote-btns');
        castVote(aId, rKey, vote, btns.querySelector('.vote-up'), btns.querySelector('.vote-dn'));
      });
    });

    el.querySelectorAll('.delete-report-btn').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete your report for this game?')) return;
        const clientId = getWebClientId();
        const r = await fetch(`${SB_URL}/user_configs?client_id=eq.${clientId}&app_id=eq.${appId}`, {
          method: 'DELETE',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'x-client-id': clientId },
        });
        if (r.ok) { b.textContent = 'Deleted'; setTimeout(render, 1000); }
        else { b.textContent = 'Failed'; }
      });
    });

    // Delete plugin config (user_proton_configs) — shown when voter_id matches this device's client ID
    el.querySelectorAll('.delete-cfg-btn').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete your Proton config for this game?')) return;
        const voterId  = b.dataset.voterId;
        const cfgAppId = b.dataset.appId;
        const r = await fetch(
          `${SB_URL}/user_proton_configs?voter_id=eq.${voterId}&app_id=eq.${cfgAppId}`,
          { method: 'DELETE', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'x-client-id': voterId } }
        );
        console.log('[delete-cfg]', r.status, voterId, cfgAppId);
        if (r.ok) { b.textContent = 'Deleted'; setTimeout(render, 1000); }
        else { b.textContent = 'Failed'; }
      });
    });

    // async-enhance author blocks with stats + avatars after the DOM is ready
    void enhanceAuthorBlocks(reps.filter(r => r._kind !== 'config'));

    // User-context tags under the artwork (#266 refinement): "On wishlist"
    // and "In library" light up when the user is signed in AND the appid
    // is in the corresponding cached Set. No site-pref gate -- signed-out
    // users see nothing, signed-in users always see the tags that apply.
    // Runs independently of the metadata fetch so a slow appdetails call
    // doesn't delay this.
    void (async () => {
      const host = el.querySelector('#game-user-tags');
      if (!host) return;
      let signedIn = false;
      try {
        const session = await window.SupaAuth?.getSession?.();
        signedIn = !!(session && session.user);
      } catch { /* stay signed out */ }
      if (!signedIn) return;
      const [libraryAppIds, wishlistAppIds] = await Promise.all([
        getMyLibraryAppIds().catch(() => new Set()),
        getMyWishlistAppIds().catch(() => new Set()),
      ]);
      const badges = computeBadgesForAppId(appId, { libraryAppIds, wishlistAppIds, signedIn: true });
      if (!badges.length) return;
      // Render each badge as a .game-tag pill so it matches the OS chips
      // in size + shape. Steam-blue background + white text keeps them
      // reading as "yours" without competing with the green OS chips.
      host.innerHTML = badges.map((b) =>
        `<span class="game-tag game-tag--user" data-badge="${b.key}" style="background:${b.color}">${b.label}</span>`,
      ).join('');
    })();

    // fetch real Steam Deck compat + min requirements and patch the UI.
    // Also probe platforms.linux via the same shared appdetails cache so
    // native-Linux titles get a small badge under the game title.
    void (async () => {
      const [deckData, reqsData, appMeta] = await Promise.all([
        fetchDeckStatusForApp(appId),
        fetchMinRequirements(appId),
        // Use the full metadata fetch instead of a dedicated linux probe so
        // the OS availability strip + Native hint + Metadata modal all
        // share one edge-function round trip.
        fetchAppMetadata(appId),
      ]);
      const platforms = appMeta?.platforms || null;
      const hasLinuxNative = platforms?.linux === true;
      // OS availability strip in the header: light up the OS icons Steam
      // says the game supports, dim the others. Only render at all when we
      // got a platforms dict back (Steam blip -> stay hidden rather than
      // showing "all off").
      if (platforms) {
        const strip = el.querySelector('#game-os-strip');
        if (strip) {
          strip.hidden = false;
          for (const chip of strip.querySelectorAll('.game-os-chip')) {
            const key = chip.dataset.os; // 'windows' | 'mac' | 'linux'
            const on = !!platforms[key];
            chip.classList.toggle('game-os-chip--on', on);
            const label = { windows: 'Windows', mac: 'macOS', linux: 'Linux' }[key] || key;
            chip.title = on
              ? `${label}: available. Click for metadata (developer, publisher, per-OS depot dates).`
              : `${label}: not offered by Steam`;
            // The chips are the click affordance for the Metadata modal
            // now that the redundant 'Native Linux runtime available' hint
            // has been retired -- the green Linux chip conveys the same
            // availability signal, and the click matches the mental model
            // of 'tell me more about this OS'.
            chip.addEventListener('click', () => _openMetadataModal(appId));
          }
        }
      }
      // App type chip under the artwork (#251): show mod / dlc / software so
      // the tile no longer needs a corner ribbon. "game" renders nothing; the
      // "demo" case is already covered by the DEMO pill next to the title.
      const rawType = String(appMeta?.type || '').toLowerCase();
      if (rawType && rawType !== 'game' && rawType !== 'demo') {
        const typeStrip = el.querySelector('#game-type-strip');
        if (typeStrip) {
          typeStrip.hidden = false;
          typeStrip.innerHTML = `<span class="game-type-tag" data-type="${rawType}" title="Steam classifies this as ${rawType}">${rawType.toUpperCase()}</span>`;
        }
      }
      // update deck status button icon + modal
      const deckBtn = el.querySelector('#deck-status-btn');
      if (deckBtn && deckData.status !== 'unknown') {
        const lbl = DECK_STATUS_LABELS[deckData.status] || 'Unknown';
        deckBtn.querySelector('svg').innerHTML = DECK_STATUS_ICON_SVG[deckData.status] || DECK_STATUS_ICON_SVG.unknown;
        deckBtn.title = `Steam Deck: ${lbl} (click for details)`;
      }
      const deckTip = el.querySelector('#deck-status-tip');
      if (deckTip) deckTip.innerHTML = `<div class="info-tooltip-inner">${renderDeckStatusModalContent(appId)}</div>`;

      // fill min requirements panel
      const reqsEl = el.querySelector('#min-reqs-content');
      if (reqsEl && reqsData) {
        reqsEl.innerHTML = `
          <h3 style="margin:0 0 8px;font-size:0.95rem;color:var(--strong)">Minimum System Requirements</h3>
          ${reqsData.minimum || '<p style="color:var(--muted)">No minimum requirements listed.</p>'}
          ${reqsData.recommended ? `<h3 style="margin:12px 0 8px;font-size:0.95rem;color:var(--strong)">Recommended</h3>${reqsData.recommended}` : ''}
        `;
      } else if (reqsEl) {
        reqsEl.innerHTML = '<p style="color:var(--muted);padding:8px 0">No system requirements available from Steam for this title.</p>';
      }
    })();
  }

  render();

  // Delegated flag-button handler: one listener on the container survives
  // render() calls (innerHTML replacement removes per-element listeners)
  el.addEventListener('click', e => {
    const btn = e.target.closest('.flag-report-btn');
    if (!btn) return;
    e.stopPropagation();
    if (btn.classList.contains('flagged')) return;
    _showFlagModal(btn);
  });

  // Scroll to a specific report if the URL has #report-{id} after the app hash.
  // The fixed topbar would cover the report's top edge under plain
  // scrollIntoView, so compute the scroll target manually and back the
  // position off by the topbar height plus a small gap. The anchor now sits
  // on the .report-block wrapper around the header card + summary, so the
  // top of the visible report aligns with the top of the viewport.
  const anchorMatch = location.hash.match(/#(report-[a-z0-9]+)$/i);
  if (anchorMatch) {
    setTimeout(() => {
      const target = el.querySelector(`#${anchorMatch[1]}`);
      if (!target) return;
      const topbarH = document.querySelector('.topbar')?.getBoundingClientRect().height || 0;
      const top = target.getBoundingClientRect().top + window.scrollY - topbarH - 12;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, 150);
  }
}

// - Search --------------------------------------------
//
