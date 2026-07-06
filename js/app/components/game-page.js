// game-page (components) for the app page. Relocated from app.js.

import { detectGpuArch } from '../../lib/gpu-arch-detector.js?v=b4fbb7ef';
import { populateScoringTooltip, pulseTierFromReports, tierFromReports } from '../../shared/scoring.js?v=1b8ae722';
import { computeCompatTrend, RECENT_DAYS, PRIOR_WINDOW_DAYS } from '../../lib/scoring/gameStats.js?v=8dc92cf7';
import { getWebClientId } from '../../shared/submit.js?v=64f1a52e';
import { fetchDeckStatusForApp, fetchMinRequirements } from '../api/deck-status.js?v=dfac69c8';
import { _protonDbLiveCache, fetchCdn, fetchProtonDbLive } from '../api/protondb.js?v=083594fa';
import { fetchConfigPlaytimeTotals, fetchNativeReports, fetchSupabase, flagReport } from '../api/supabase.js?v=d76564a6';
import { castVote, fetchUserVotes, fetchVotes } from '../api/votes.js?v=aba6619f';
import { enhanceAuthorBlocks } from './author.js?v=3a8cb3c7';
import { renderConfigCard } from './config-cards.js?v=c67740f8';
import { DECK_STATUS_ICON_SVG, DECK_STATUS_LABELS, _DECK_LCD_RE, _DECK_OLED_RE, renderDeckStatusButton, renderDeckStatusModalContent } from './deck-status.js?v=a1a075ee';
import { renderCard } from './report-card.js?v=a3e68133';
import { loadSearchIndex, searchIndex } from './search.js?v=598aaad1';
import { showAdultAllowed, isAdultEntry } from '../../lib/adult-filter.js?v=e4e9d845';
import { CDN, RATING_COLORS, RATING_TEXT, SB_KEY, SB_URL, SITE_ROOT, STEAM_IMG, dataFilesHref, storeLabelFromAppId } from '../config.js?v=f9591262';
import { loadSteamImg as _loadSteamImg } from '../lib/steam-img.js?v=ba0d7848';
import { configKey, daysAgo, downloadJson, esc, reportKey } from '../utils.js?v=c7e1268c';
import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';

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

const DISCORD_URL = 'https://discord.gg/4p6e4X7xW';

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
  const [cdnRaw, configs, nativeReports, votes, userVotes, playtimeTotals, suppressedKeys] = await Promise.all([
    safeFetch(() => fetchCdn(appId), 'fetchCdn', []),
    safeFetch(() => fetchSupabase(appId), 'fetchSupabase', []),
    safeFetch(() => fetchNativeReports(appId), 'fetchNativeReports', []),
    safeFetch(() => fetchVotes(appId), 'fetchVotes', {}),
    safeFetch(() => fetchUserVotes(appId), 'fetchUserVotes', {}),
    safeFetch(() => fetchConfigPlaytimeTotals(appId), 'fetchConfigPlaytimeTotals', []),
    safeFetch(() => _fetchReportModeration(appId), 'reportModeration', new Set()),
  ]);

  // Drop ProtonDB mirror reports an admin has shadow-banned or deleted. Pulse
  // reports are filtered server-side by RLS (is_hidden), so they never arrive.
  const cdn = suppressedKeys.size
    ? cdnRaw.filter(r => !suppressedKeys.has(_pdbReportKey(r)))
    : cdnRaw;
  if (suppressedKeys.size && cdn.length !== cdnRaw.length) {
    console.debug('[game-page] filtered suppressed ProtonDB reports', { appId, removed: cdnRaw.length - cdn.length, source: 'report_moderation' });
  }

  // If CDN was empty but the user already clicked "Check ProtonDB Live" this
  // session, use the cached live result so the page re-renders correctly.
  // ProtonDB's public summaries API only returns an aggregate (tier + total),
  // not individual reports, so the live result is a single `_liveOnly` summary.
  // It must NOT be rendered as a report card (it has no hardware/date and shows
  // up as a broken "Unknown / NAN days ago" row); instead it drives the header
  // tier + ProtonDB count below.
  const liveCached = !cdn.length ? (_protonDbLiveCache.get(String(appId)) || []) : [];
  const liveSummary = liveCached.find(r => r._liveOnly) || null;
  const liveOnly = !!liveSummary && !cdn.length;
  const cdnMiss = !cdn.length && !liveCached.length;

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
  // Effective ProtonDB report count: the mirrored count when we have it, else
  // the live aggregate total. Drives the header counts so a live-only game
  // shows the real ProtonDB rating instead of "0 reports / pending".
  const protonDbCount = cdn.length || (liveSummary ? (liveSummary.total || 0) : 0);
  const protonDbTier = liveOnly ? String(liveSummary.tier || '').toLowerCase() : tierFromReports(cdn);
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
      const snapshot = { gpu: filterGpu, arch: filterArch, os: filterOs, rating: filterRating, device: filterDevice, minPlaytime: filterMinPlaytime, source: filterSource };
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
    if (filterDevice) {
      arr = arr.filter(r => {
        const haystack = `${r.cpu || ''} ${r.gpu || ''}`;
        const isLcd  = _DECK_LCD_RE.test(haystack);
        const isOled = _DECK_OLED_RE.test(haystack);
        if (filterDevice === 'deck-lcd')  return isLcd;
        if (filterDevice === 'deck-oled') return isOled;
        if (filterDevice === 'deck-any')  return isLcd || isOled;
        if (filterDevice === 'desktop')   return !isLcd && !isOled;
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
    const overallTileSummary = hasAnyReports
      ? `${confBucket} confidence across ${totalReports} report${totalReports !== 1 ? 's' : ''}${pulseHasConfigs ? ` / ${configs.length} config${configs.length !== 1 ? 's' : ''}` : ''}`
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
    const tierBars = liveOnly
      ? '<div class="grp-bars-note">Per-tier breakdown is not available from ProtonDB\'s live summary.</div>'
      : `<div class="grp-bars">${TIER_ORDER.map((t) => {
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
          <img class="game-header-art" src="${STEAM_IMG(appId)}" data-appid="${appId}" alt="" onerror="window.__steamImgLoad(this)">
          ${ratingPanel}
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

          const activeCount = [filterGpu, filterArch, filterOs, filterRating, filterSource, filterDevice, filterMinPlaytime > 0 ? '1' : ''].filter(Boolean).length;
          const anyActive = activeCount > 0;

          return `
            <button class="filter-toggle-btn${activeCount > 0 ? ' has-filters' : ''}" id="filterToggle">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.72-4.8 5.74-7.39C20.25 4.95 19.8 4 18.95 4H5.04C4.2 4 3.74 4.95 4.25 5.61z"/></svg>
              Filters${activeCount > 0 ? ` <span class="filter-badge">${activeCount}</span>` : ''}
            </button>
            ${anyActive ? `<span class="filter-count">${reps.length} of ${combined.length} shown</span>` : ''}
            <div class="filter-panel" id="filterPanel">
              <div class="filter-panel-grid">
                ${gpuSel}${archSel}${osSel}${srcSel}${ratingSel}${deviceSel}${playtimeSel}
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
    el.querySelector('#fSource')?.addEventListener('change', e => { filterSource = e.target.value; saveFiltersIfEnabled(); render(); el.querySelector('#filterPanel')?.classList.add('open'); });
    el.querySelector('#filterToggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      el.querySelector('#filterPanel')?.classList.toggle('open');
    });
    el.querySelector('#filterClear')?.addEventListener('click', () => {
      filterGpu = ''; filterArch = ''; filterOs = ''; filterRating = '';
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

    // fetch real Steam Deck compat + min requirements and patch the UI
    void (async () => {
      const [deckData, reqsData] = await Promise.all([
        fetchDeckStatusForApp(appId),
        fetchMinRequirements(appId),
      ]);
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
