// game-page (components) for the app page. Relocated from app.js.

import { detectGpuArch } from '../../lib/gpu-arch-detector.js?v=1f02f4a6';
import { populateScoringTooltip, pulseTierFromReports, tierFromReports } from '../../shared/scoring.js?v=0dae1257';
import { getWebClientId } from '../../shared/submit.js?v=09904778';
import { fetchDeckStatusForApp, fetchMinRequirements } from '../api/deck-status.js?v=64d7ee9d';
import { _protonDbLiveCache, fetchCdn, fetchProtonDbLive } from '../api/protondb.js?v=7ad8fd16';
import { fetchConfigPlaytimeTotals, fetchNativeReports, fetchSupabase } from '../api/supabase.js?v=b1ef901e';
import { castVote, fetchUserVotes, fetchVotes } from '../api/votes.js?v=cb7b4c5e';
import { enhanceAuthorBlocks } from './author.js?v=e80d446e';
import { renderConfigCard } from './config-cards.js?v=42909e25';
import { DECK_STATUS_ICON_SVG, DECK_STATUS_LABELS, _DECK_LCD_RE, _DECK_OLED_RE, renderDeckStatusButton, renderDeckStatusModalContent } from './deck-status.js?v=b0fa82d9';
import { renderCard } from './report-card.js?v=dd9e7991';
import { loadSearchIndex, searchIndex } from './search.js?v=b549cfc9';
import { CDN, RATING_COLORS, RATING_TEXT, SB_KEY, SB_URL, STEAM_IMG, dataFilesHref } from '../config.js?v=9970759a';
import { loadSteamImg as _loadSteamImg } from '../lib/steam-img.js?v=85cf4195';
import { confColor, confTextColor, configKey, daysAgo, downloadJson, esc, fmtMinutes, reportKey } from '../utils.js?v=f5dda5b6';

export function trendSummary(reps) {
  if (reps.length < 2) return '';
  const ratingVal = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };
  const now = Date.now() / 1000;
  const recent = reps.filter(r => now - r.timestamp < 180 * 86400);
  const older  = reps.filter(r => now - r.timestamp >= 180 * 86400);
  if (!recent.length || !older.length) return '';
  const avg = arr => arr.reduce((s, r) => s + (ratingVal[r.rating] || 3), 0) / arr.length;
  const diff = avg(recent) - avg(older);
  if (Math.abs(diff) < 0.3)
    return `<div class="trend">Compatibility is <strong>stable</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
  if (diff > 0)
    return `<div class="trend">Compatibility is <strong style="color:var(--green)">improving</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
  return `<div class="trend">Compatibility is <strong style="color:var(--red)">declining</strong> - ${recent.length} recent vs ${older.length} older reports</div>`;
}

// - Deck Verified status helpers (stub for now) -------
//

export async function renderGamePage(appId) {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading reports...</div>';

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
  const [cdn, configs, nativeReports, votes, userVotes, playtimeTotals] = await Promise.all([
    safeFetch(() => fetchCdn(appId), 'fetchCdn', []),
    safeFetch(() => fetchSupabase(appId), 'fetchSupabase', []),
    safeFetch(() => fetchNativeReports(appId), 'fetchNativeReports', []),
    safeFetch(() => fetchVotes(appId), 'fetchVotes', {}),
    safeFetch(() => fetchUserVotes(appId), 'fetchUserVotes', {}),
    safeFetch(() => fetchConfigPlaytimeTotals(appId), 'fetchConfigPlaytimeTotals', []),
  ]);

  // If CDN was empty but the user already clicked "Check ProtonDB Live" this
  // session, use the cached live result so the page re-renders correctly.
  const liveCached = !cdn.length ? (_protonDbLiveCache.get(String(appId)) || []) : [];
  const cdnMiss = !cdn.length && !liveCached.length;

  const reports = [
    ...cdn.map(r => ({ ...r, source: 'protondb' })),
    ...liveCached.map(r => ({ ...r, source: 'protondb' })),
    ...nativeReports,
  ];

  // Hard miss: nothing in cache, nothing native, nothing from Pulse.
  // Show a "not in our mirror" state with a user-triggered live check button
  // rather than auto-fetching so we don't hammer the ProtonDB API.
  if (!reports.length && !configs.length) {
    el.innerHTML = `
      <div class="state-box">
        <p style="margin:0 0 10px">This game (<strong>${esc(String(appId))}</strong>) is not in our cached ProtonDB mirror.</p>
        <p style="margin:0 0 14px;color:var(--muted);font-size:0.88rem">Our mirror updates periodically. You can check ProtonDB live, but please use this sparingly to avoid overloading their API.</p>
        <button id="live-check-btn" class="submit-report-btn" style="margin:0">Check ProtonDB Live</button>
        <span id="live-check-status" style="margin-left:10px;font-size:0.85rem;color:var(--muted)"></span>
      </div>`;
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

  // Resolve a human-readable title: reports first (they almost always carry one),
  // then configs, then fall back to the pre-loaded search-index which has the
  // canonical Steam name per appId. Final fallback is the bare app id.
  await loadSearchIndex();
  const indexHit = (searchIndex || []).find(row => String(row[0]) === String(appId));
  const title = reports[0]?.title || configs[0]?.appName || indexHit?.[1] || `App ${appId}`;
  const protonDbTier = tierFromReports(cdn);
  const pulseTier = pulseTierFromReports(nativeReports, cdn.length);
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
    const totalReports = nativeReports.length + cdn.length;
    const hasAnyReports = totalReports > 0;
    // Use the combined-source tier when there are any reports; fall back to
    // protondb tier if only protondb reports exist; "pending" when nothing
    const overallTier = hasAnyReports
      ? (pulseHasReports ? pulseTier.tier : protonDbTier)
      : 'pending';
    const overallTileColor = hasAnyReports ? (RATING_COLORS[overallTier] || '#3a4a5a') : '#2a5a8c';
    const overallTileText  = hasAnyReports ? (RATING_TEXT[overallTier]   || '#c8d4e0') : '#d7e9fb';
    // Single summary line - confidence label comes from TOTAL report count,
    // not just Pulse. The old code used pulseTier.confidence which returns
    // 'none' when there are 0 Pulse reports (even if there are 163 ProtonDB
    // reports), producing the nonsensical "none confidence across 163 reports"
    const confBucket = totalReports >= 20 ? 'high' : totalReports >= 5 ? 'medium' : totalReports >= 1 ? 'low' : '';
    const overallTileSummary = hasAnyReports
      ? `${confBucket} confidence across ${totalReports} report${totalReports !== 1 ? 's' : ''}${pulseHasConfigs ? ` / ${configs.length} config${configs.length !== 1 ? 's' : ''}` : ''}`
      : (pulseHasConfigs ? 'Community-submitted configs available' : 'No community data yet');
    // Confidence: prefer Pulse's computed confidencePct (weights both sources)
    // when there are Pulse reports; otherwise fall back to a sample-size only
    // approximation against the ProtonDB report count alone
    const overallConfidencePct = pulseHasReports && pulseTier.confidencePct
      ? pulseTier.confidencePct
      : (cdn.length > 0 ? Math.min(95, Math.round(30 + Math.log2(Math.max(1, cdn.length)) * 18)) : 0);
    // Per-source breakdown - tiny stat strip at the bottom of the tile. Always
    // shows BOTH Pulse + ProtonDB (even at 0) so users understand both feeds
    // contribute even when only one has data. Configs only appear if > 0
    const statBits = [
      `<span><strong>${nativeReports.length}</strong> Pulse</span>`,
      `<span><strong>${cdn.length}</strong> ProtonDB</span>`,
    ];
    if (configs.length) statBits.push(`<span><strong>${configs.length}</strong> config${configs.length !== 1 ? 's' : ''}</span>`);
    const statRow = `<div class="source-summary-stats">${statBits.join('<span class="ss-sep">/</span>')}</div>`;

    // Rating distribution as a grid - shows ALL 5 tiers always with their
    // count, even at 0. Replaces an earlier horizontal stripe bar that
    // looked weird when only one tier had data ("just a gold blob"); the
    // grid format reads at a glance and works the same with 1 report or 100
    const allReports = [...nativeReports, ...cdn];
    const ratingCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0 };
    for (const r of allReports) {
      if (ratingCounts[r.rating] != null) ratingCounts[r.rating]++;
    }
    const TIER_LABELS = { platinum: 'Plat', gold: 'Gold', silver: 'Silv', bronze: 'Bron', borked: 'Bork' };
    const ratingDistribution = `
      <div class="source-summary-distribution" title="Rating distribution across all reports">
        ${Object.entries(ratingCounts).map(([tier, n]) => `
          <div class="dist-chip dist-${tier}${n === 0 ? ' dist-empty' : ''}" title="${n} ${tier} report${n !== 1 ? 's' : ''}">
            <span class="dist-chip-label">${TIER_LABELS[tier]}</span>
            <span class="dist-chip-count">${n}</span>
          </div>
        `).join('')}
      </div>`;

    // Newest-report age - tells visitors at a glance whether the data is
    // fresh or stale. Uses the existing daysAgo helper for consistency
    const newestTs = allReports.length
      ? Math.max(...allReports.map(r => r.timestamp || 0))
      : 0;
    const freshnessLine = newestTs ? `
      <div class="source-summary-freshness">Newest report: <strong>${daysAgo(newestTs)}</strong></div>` : '';
    // Two-column inner layout so the wide tile actually uses its horizontal
    // space. Left: kicker + rating + confidence + summary. Right: distribution
    // bar + freshness + per-source breakdown. Collapses to single column on
    // narrow screens via the media query in app.css
    const sourceTiles = `
      <div class="source-summary-grid">
        <button class="source-summary-tile source-summary-tile-combined" type="button" data-target="pulse-summary">
          <div class="ss-primary">
            <span class="source-summary-tier-row">
              ${hasAnyReports && overallConfidencePct ? `<a class="source-summary-conf conf-link" href="confidence.html?app=${appId}" onclick="event.stopPropagation()" style="background:${confColor(overallConfidencePct / 10)};color:${confTextColor(overallConfidencePct / 10)}" title="See the factor-by-factor breakdown of this aggregate confidence">Confidence: ${overallConfidencePct}%</a>` : ''}
              <span class="source-summary-value" style="background:${overallTileColor};color:${overallTileText}">${overallTier}</span>
            </span>
            <span class="source-summary-meta">${overallTileSummary}</span>
          </div>
          <div class="ss-details">
            ${ratingDistribution}
            ${freshnessLine}
            ${statRow}
          </div>
        </button>
      </div>`;

    // Show a banner if the signed-in client already has a public report on this
    // game (matched via client id on user_configs). No draft concept: upload means publish.
    const myCid = getWebClientId();
    const myPublished = nativeReports.find(r => r.clientId && r.clientId === myCid);
    const myStatusBadge = myPublished ? `
      <div class="my-config-banner my-config-banner--published" title="Your report for this game">
        <span class="my-config-banner-dot"></span>
        <span class="my-config-banner-label">Your report:</span>
        <span class="my-config-banner-status">Published</span>
      </div>` : '';

    el.innerHTML = `
      <div class="game-header">
        <div class="game-header-main">
          <div class="game-header-info">
            <div class="game-title">${esc(title)}</div>
            <div class="game-meta">
              App ${appId}
              &nbsp;/&nbsp; <strong>${cdn.length}</strong> ProtonDB report${cdn.length !== 1 ? 's' : ''}
              ${nativeReports.length ? `&nbsp;/&nbsp; <strong>${nativeReports.length}</strong> Pulse report${nativeReports.length !== 1 ? 's' : ''}` : ''}
              &nbsp;/&nbsp; <strong>${configs.length}</strong> Pulse config${configs.length !== 1 ? 's' : ''}
              ${totalCommunityMinutes > 0 ? `&nbsp;/&nbsp; <strong>${fmtMinutes(totalCommunityMinutes)}</strong> community playtime (${totalSessionCount} session${totalSessionCount !== 1 ? 's' : ''})` : ''}
            </div>
            ${myStatusBadge}
          </div>
          <img src="${STEAM_IMG(appId)}" data-appid="${appId}" alt="" onerror="window.__steamImgLoad(this)">
        </div>
        <div class="game-header-side">
          ${sourceTiles}
          <div class="game-header-actions">
            <a class="info-btn" href="scoring.html" id="rating-info-btn" title="How scoring works (opens the canonical scoring page)"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="11" fill="#3b82f6"/><text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="serif">i</text></svg></a>
            <a class="info-btn info-btn-labeled" id="stats-btn" href="game-stats.html?app=${appId}" title="Per-game compatibility stats: confidence factors, trend, Proton version success rates, launch option frequency, and proven launch options"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="4" height="18" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="17" y="12" width="4" height="9" rx="1"/></svg><span>Stats</span></a>
            ${renderDeckStatusButton(appId)}
            <a class="submit-report-btn" href="submit.html?app=${appId}&title=${encodeURIComponent(title)}">Submit Report</a>
          </div>
        </div>
        <div class="info-tooltip" id="deck-status-tip">
          <div class="info-tooltip-inner" id="deck-status-content">${renderDeckStatusModalContent(appId)}</div>
        </div>
        <!-- External link footer lives inside the game-header banner so it
             reads as part of the game's metadata strip instead of a floating
             group of buttons. Less cluttered, less visual seams between the
             rating tile and the navigation links -->
        <div class="hub-links hub-links-in-banner">
          <a class="hub-link" href="https://store.steampowered.com/app/${appId}" target="_blank" rel="noopener">Steam ></a>
          <a class="hub-link" href="https://steamdb.info/app/${appId}/" target="_blank" rel="noopener">SteamDB ></a>
          <a class="hub-link" href="https://www.protondb.com/app/${appId}" target="_blank" rel="noopener">ProtonDB ></a>
          <a class="hub-link" href="https://www.pcgamingwiki.com/w/index.php?search=${encodeURIComponent(title)}" target="_blank" rel="noopener">PCGamingWiki ></a>
          <a class="hub-link" href="https://steamcharts.com/app/${appId}" target="_blank" rel="noopener">Steam Charts ></a>
          <a class="hub-link" href="https://github.com/ValveSoftware/Proton/issues?q=${encodeURIComponent(title)}" target="_blank" rel="noopener">Proton Issues ></a>
          <a class="hub-link" href="${dataFilesHref(appId)}" target="_blank" rel="noopener">Data Files ></a>
        </div>
      </div>

      ${trendSummary(reports)}

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
        </div>
      </div>

      <div class="cards">
        ${reps.length
          ? reps.map((r, i) => r._kind === 'config'
              ? renderConfigCard(r, i, votes, userVotes)
              : renderCard(r, votes, userVotes, playtimeTotals)
            ).join('')
          : '<div class="state-box" style="border:none">No configs or reports match filters</div>'}
      </div>
    `;

    el.querySelectorAll('.sort-bar button').forEach(b =>
      b.onclick = () => { sortMode = b.dataset.sort; render(); }
    );

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
    el.querySelectorAll('.vote-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
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

  // Scroll to a specific report if the URL has #report-{id} after the app hash
  const anchorMatch = location.hash.match(/#(report-[a-z0-9]+)$/i);
  if (anchorMatch) {
    setTimeout(() => {
      el.querySelector(`#${anchorMatch[1]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }
}

// - Search --------------------------------------------
//
