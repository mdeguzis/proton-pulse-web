// home (components) for the app page. Relocated from app.js.

import { fetchRecentPulseReports } from '../api/reports.js?v=a9fb53ae';
import { loadSearchIndex, searchIndex } from './search.js?v=78b89e87';
import { SB_KEY, SB_URL, isNonSteamAppId } from '../config.js?v=4031c5fa';
import { daysAgo, latestPerApp } from '../utils.js?v=f5dda5b6';
import { renderGameCard } from '../lib/card.js?v=3a07c55e';

const PAGE_SIZE = 10;
const KNOWN_TIERS = new Set(['platinum', 'gold', 'silver', 'bronze', 'borked']);
const TIER_SCORE = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };

function _sortReports(reports, sort) {
  const copy = [...reports];
  if (sort === 'best') {
    copy.sort((a, b) =>
      (TIER_SCORE[b.tier] || 0) - (TIER_SCORE[a.tier] || 0) ||
      (b.lastReportDate || '').localeCompare(a.lastReportDate || ''));
  } else if (sort === 'worst') {
    copy.sort((a, b) =>
      (TIER_SCORE[a.tier] || 99) - (TIER_SCORE[b.tier] || 99) ||
      (b.lastReportDate || '').localeCompare(a.lastReportDate || ''));
  } else if (sort === 'count') {
    copy.sort((a, b) =>
      ((b.protondbCount || 0) + (b.pulseCount || 0)) -
      ((a.protondbCount || 0) + (a.pulseCount || 0)));
  }
  return copy;
}

// Tier filter is multi-select. `sel` is a Set of chosen values. An empty set or
// one containing 'all' means no filtering. Within the set values are OR'd:
// 'rated' matches any KNOWN_TIER, 'unrated' matches anything that is not a known
// tier (pending / no reports), and a specific tier matches that tier exactly.
function _filterByTier(reports, sel) {
  if (!sel || sel.size === 0 || sel.has('all')) return reports;
  return reports.filter(r => {
    const t = r.tier;
    const isRated = KNOWN_TIERS.has(t);
    for (const v of sel) {
      if (v === 'rated' && isRated) return true;
      if (v === 'unrated' && !isRated) return true;
      if (v === t) return true;
    }
    return false;
  });
}

// Source filter is multi-select. `sel` is a Set of chosen values. Empty or 'all'
// means no filtering. Values are OR'd: a report passes if it has any of the
// selected sources.
function _filterByType(reports, sel) {
  if (!sel || sel.size === 0 || sel.has('all')) return reports;
  return reports.filter(r => {
    for (const v of sel) {
      if (v === 'protondb' && (r.protondbCount || 0) > 0) return true;
      if (v === 'pulse' && (r.pulseCount || 0) > 0) return true;
    }
    return false;
  });
}

// Read the checked values (excluding 'all') from a checkbox filter group.
function _readCheckGroup(groupEl) {
  const set = new Set();
  groupEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (cb.value !== 'all' && cb.checked) set.add(cb.value);
  });
  return set;
}

// Wire an "All + specific values" checkbox group. Checking "All" clears the
// specifics; checking a specific clears "All"; unchecking the last specific
// re-checks "All". Calls onChange with the resulting Set after every change.
function _wireCheckGroup(groupEl, onChange) {
  const allCb = groupEl.querySelector('input[value="all"]');
  groupEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.value === 'all') {
        if (cb.checked) {
          groupEl.querySelectorAll('input[type="checkbox"]').forEach(o => { if (o !== cb) o.checked = false; });
        } else if (_readCheckGroup(groupEl).size === 0) {
          cb.checked = true; // never leave the whole group empty
        }
      } else {
        if (cb.checked && allCb) allCb.checked = false;
        if (_readCheckGroup(groupEl).size === 0 && allCb) allCb.checked = true;
      }
      onChange(_readCheckGroup(groupEl));
    });
  });
}

function _popularSub(g) {
  const total = (g.protondbCount || 0) + (g.pulseCount || 0);
  const countPart = total > 0 ? `${total.toLocaleString()} report${total === 1 ? '' : 's'}` : '';
  const datePart = g.lastReportDate ? `latest: ${g.lastReportDate}` : '';
  return [countPart, datePart].filter(Boolean).join(' \u00b7 ');
}

function _loadMoreBtn(sectionId) {
  return `<button class="load-more-btn" data-section="${sectionId}">Load more</button>`;
}

function _allShownNote(count) {
  return `<p class="home-results-note">Showing all ${count} result${count === 1 ? '' : 's'}</p>`;
}

function _appendCards(sectionId, queue) {
  const cardsEl = document.getElementById(`cards-${sectionId}`);
  const btnEl = document.getElementById(`load-more-${sectionId}`);
  if (!cardsEl || !queue.length) { if (btnEl) btnEl.innerHTML = ''; return; }
  const batch = queue.splice(0, PAGE_SIZE);
  const html = sectionId === 'recent'
    ? batch.map(_recentCardHtml).join('')
    : batch.map(g => {
        const tier = g.tier || String(g.rating || '').toLowerCase();
        return renderGameCard({
          href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
          title: g.title,
          sub: tier === 'pending' ? 'No reports yet · be the first' : _popularSub(g),
          tier: tier || undefined, sourceLabel: 'Steam',
        });
      }).join('');
  cardsEl.insertAdjacentHTML('beforeend', html);
  if (!queue.length && btnEl) btnEl.innerHTML = '';
}

function _recentCardHtml(r) {
  return renderGameCard({
    href: `#/app/${r.appId}`,
    appId: r.appId,
    title: r.title,
    sub: _popularSub(r),
    tier: String(r.tier || '').toLowerCase() || undefined,
    sourceLabel: 'Steam',
  });
}

export async function renderHomePage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="state-box">Loading recent reports...</div>';
  try {
    const [recentResp, mostPlayedResp] = await Promise.all([
      fetch('recent-reports.json').catch(() => null),
      fetch('most_played.json').catch(() => null),
    ]);

    let allRecentReports = [];
    if (recentResp && recentResp.ok) {
      allRecentReports = await recentResp.json().catch(() => []);
    }

    const seenIds = new Set(allRecentReports.map(r => String(r.appId)));
    let ratedGames = [], unratedGames = [];
    if (mostPlayedResp && mostPlayedResp.ok) {
      const all = (await mostPlayedResp.json().catch(() => [])).filter(g => !seenIds.has(String(g.appId)));
      ratedGames = all.filter(g => KNOWN_TIERS.has(String(g.rating || '').toLowerCase()));
      unratedGames = all.filter(g => ['pending', 'catalog'].includes(String(g.rating || '').toLowerCase()));
    }

    el.innerHTML = `
      <div class="home-filter-bar">
        <div class="filter-wrap" id="home-filter-wrap">
          <button class="filter-toggle-btn" id="home-filter-toggle" type="button" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.72-4.8 5.74-7.39C20.25 4.95 19.8 4 18.95 4H5.04C4.2 4 3.74 4.95 4.25 5.61z"/></svg>
            Filters<span class="filter-badge" id="home-filter-badge" hidden></span>
          </button>
          <div class="filter-panel filter-panel--stack" id="home-filter-panel">
            <div class="filter-item">
              <label class="home-filter-label" for="home-sort-select">Sort</label>
              <select id="home-sort-select" class="home-filter-select">
                <option value="recent">Recent</option>
                <option value="best">Best Tier</option>
                <option value="worst">Worst Tier</option>
                <option value="count">Most Reported</option>
              </select>
            </div>
            <div class="filter-checks" id="home-tier-checks" data-group="tier">
              <span class="filter-checks-label">Tier</span>
              <label class="filter-check"><input type="checkbox" value="all" checked><span>All</span></label>
              <label class="filter-check"><input type="checkbox" value="rated"><span>Rated</span></label>
              <label class="filter-check"><input type="checkbox" value="unrated"><span>Not Rated Yet</span></label>
              <label class="filter-check"><input type="checkbox" value="platinum"><span>Platinum</span></label>
              <label class="filter-check"><input type="checkbox" value="gold"><span>Gold</span></label>
              <label class="filter-check"><input type="checkbox" value="silver"><span>Silver</span></label>
              <label class="filter-check"><input type="checkbox" value="bronze"><span>Bronze</span></label>
              <label class="filter-check"><input type="checkbox" value="borked"><span>Borked</span></label>
            </div>
            <div class="filter-checks" id="home-source-checks" data-group="source">
              <span class="filter-checks-label">Source</span>
              <label class="filter-check"><input type="checkbox" value="all" checked><span>All</span></label>
              <label class="filter-check"><input type="checkbox" value="protondb"><span>ProtonDB</span></label>
              <label class="filter-check"><input type="checkbox" value="pulse"><span>Pulse</span></label>
            </div>
            <div class="filter-panel-footer filter-panel-footer--stack">
              <button class="filter-clear-btn" id="home-filter-clear" type="button">Clear filters</button>
            </div>
          </div>
        </div>
        <div class="home-view-controls">
          <div class="home-size-toggle" id="home-size-toggle" title="Card size">
            <button class="home-size-btn" data-size="sm" type="button" title="Small cards">S</button>
            <button class="home-size-btn" data-size="md" type="button" title="Medium cards">M</button>
            <button class="home-size-btn" data-size="lg" type="button" title="Large cards">L</button>
          </div>
          <div class="home-layout-toggle">
            <button class="home-layout-btn active" data-layout="grid" title="Grid view">Grid</button>
            <button class="home-layout-btn" data-layout="list" title="List view">List</button>
          </div>
        </div>
      </div>
      <p class="section-label" style="margin-bottom:10px">Recent Reports</p>
      <div class="cards" id="cards-recent"></div>
      <div id="load-more-recent"></div>
      <div class="section-label-row" style="margin-top:24px;margin-bottom:10px">
        <span class="section-label" style="margin:0">Popular on Steam</span>
      </div>
      <div class="cards" id="cards-popular"></div>
      <div id="load-more-popular"></div>`;

    let currentSort = 'recent';
    let tierSel = new Set();   // empty => all tiers
    let sourceSel = new Set(); // empty => all sources
    let currentLayout = 'grid';

    function _listRowHtml(r) {
      const tier = String(r.tier || '').toLowerCase();
      const total = (r.protondbCount || 0) + (r.pulseCount || 0);
      const countStr = total > 0 ? `${total.toLocaleString()} reports` : '';
      return `<a class="home-list-row" href="#/app/${r.appId}">
        <span class="home-list-tier tier-badge tier-badge--${tier || 'pending'}">${tier || '?'}</span>
        <span class="home-list-title">${r.title || r.appId}</span>
        <span class="home-list-meta">${[r.lastReportDate, countStr].filter(Boolean).join(' \u00b7 ')}</span>
      </a>`;
    }

    function applyPopularFilters() {
      // Build the candidate pool from the tier selection. Rated games show by
      // default; the unrated catalog games (no reports yet) only appear when
      // "Not Rated Yet" (or "All") is selected, so they stay hidden otherwise.
      const wantUnrated = tierSel.has('all') || tierSel.has('unrated');
      const onlyUnrated = tierSel.size === 1 && tierSel.has('unrated');
      const pool = [
        ...(onlyUnrated ? [] : ratedGames),
        ...(wantUnrated ? unratedGames : []),
      ];
      // Map rating -> tier ('pending' for unrated) so the shared Set-based tier
      // filter treats them consistently with recent reports.
      const asReports = pool.map(g => {
        const t = String(g.rating || '').toLowerCase();
        return { ...g, tier: KNOWN_TIERS.has(t) ? t : 'pending' };
      });
      const filtered = _filterByType(_filterByTier(asReports, tierSel), sourceSel);
      const cardsEl = document.getElementById('cards-popular');
      const loadMoreEl = document.getElementById('load-more-popular');
      if (!cardsEl) return;
      const initial = filtered.slice(0, PAGE_SIZE);
      const queue = filtered.slice(PAGE_SIZE);
      cardsEl.innerHTML = initial.map(_popularItemHtml).join('')
        || '<div class="state-box">No games match the current filters.</div>';
      if (loadMoreEl) {
        if (queue.length) {
          loadMoreEl.innerHTML = _loadMoreBtn('popular');
          loadMoreEl.querySelector('button').addEventListener('click', () => {
            const batch = queue.splice(0, PAGE_SIZE);
            cardsEl.insertAdjacentHTML('beforeend', batch.map(_popularItemHtml).join(''));
            if (!queue.length) loadMoreEl.innerHTML = '';
          });
        } else {
          loadMoreEl.innerHTML = initial.length ? _allShownNote(filtered.length) : '';
        }
      }
    }

    // Render a popular game honoring the current view type: a slim list row in
    // List mode (same as recent reports), or a sized card in Grid mode.
    function _popularItemHtml(g) {
      if (currentLayout === 'list') return _listRowHtml(g);
      return renderGameCard({
        href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
        title: g.title,
        sub: g.tier === 'pending' ? 'No reports yet · be the first' : _popularSub(g),
        tier: g.tier || undefined, sourceLabel: 'Steam',
      });
    }

    function applyRecentFilters() {
      const filtered = _filterByType(_filterByTier(_sortReports(allRecentReports, currentSort), tierSel), sourceSel);
      const cardsEl = document.getElementById('cards-recent');
      const loadMoreEl = document.getElementById('load-more-recent');
      const renderFn = currentLayout === 'list' ? _listRowHtml : _recentCardHtml;
      const queue = filtered.slice(PAGE_SIZE);
      const initial = filtered.slice(0, PAGE_SIZE);
      cardsEl.innerHTML = initial.map(renderFn).join('') || '<div class="state-box">No reports found.</div>';
      if (loadMoreEl) {
        if (queue.length) {
          loadMoreEl.innerHTML = _loadMoreBtn('recent');
          loadMoreEl.querySelector('button').addEventListener('click', () => _appendCards('recent', queue));
        } else {
          loadMoreEl.innerHTML = filtered.length ? _allShownNote(filtered.length) : '';
        }
      }
    }

    document.getElementById('home-sort-select')?.addEventListener('change', e => {
      currentSort = e.target.value;
      applyRecentFilters();
    });

    // Filters popover: toggle open, close on outside click.
    const filterWrap = document.getElementById('home-filter-wrap');
    const filterToggle = document.getElementById('home-filter-toggle');
    const filterPanel = document.getElementById('home-filter-panel');
    const filterBadge = document.getElementById('home-filter-badge');
    filterToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = filterPanel.classList.toggle('open');
      filterToggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (filterPanel?.classList.contains('open') && filterWrap && !filterWrap.contains(e.target)) {
        filterPanel.classList.remove('open');
        filterToggle.setAttribute('aria-expanded', 'false');
      }
    });

    // Active-filter badge: count specific tier + source selections.
    function updateFilterBadge() {
      const n = tierSel.size + sourceSel.size;
      filterToggle?.classList.toggle('has-filters', n > 0);
      if (filterBadge) {
        filterBadge.textContent = String(n);
        filterBadge.hidden = n === 0;
      }
    }

    const tierGroup = document.getElementById('home-tier-checks');
    const sourceGroup = document.getElementById('home-source-checks');
    if (tierGroup) _wireCheckGroup(tierGroup, sel => {
      tierSel = sel; updateFilterBadge(); applyRecentFilters(); applyPopularFilters();
    });
    if (sourceGroup) _wireCheckGroup(sourceGroup, sel => {
      sourceSel = sel; updateFilterBadge(); applyRecentFilters(); applyPopularFilters();
    });

    // Clear filters: reset every group back to "All", sort back to Recent.
    document.getElementById('home-filter-clear')?.addEventListener('click', () => {
      [tierGroup, sourceGroup].forEach(g => {
        if (!g) return;
        g.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = cb.value === 'all'; });
      });
      const sortSel = document.getElementById('home-sort-select');
      if (sortSel) sortSel.value = 'recent';
      currentSort = 'recent';
      tierSel = new Set();
      sourceSel = new Set();
      updateFilterBadge();
      applyRecentFilters();
      applyPopularFilters();
    });

    // S/M/L only make sense for the card (grid) view; disable them in list mode.
    function _setSizeEnabled(enabled) {
      document.querySelectorAll('.home-size-btn').forEach(b => { b.disabled = !enabled; });
      document.getElementById('home-size-toggle')?.classList.toggle('home-size-toggle--disabled', !enabled);
    }

    document.querySelectorAll('.home-layout-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.home-layout-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentLayout = btn.dataset.layout;
        const isList = currentLayout === 'list';
        // List view applies to BOTH sections so they stay consistent.
        document.getElementById('cards-recent')?.classList.toggle('home-cards-list', isList);
        document.getElementById('cards-popular')?.classList.toggle('home-cards-list', isList);
        _setSizeEnabled(!isList);
        applyRecentFilters();
        applyPopularFilters();
      });
    });

    // Card size (S/M/L) is a saved user preference. Applies the cards--<size>
    // class to both card lists; default medium.
    const SIZE_KEY = 'pp:grid-size';
    const SIZES = ['sm', 'md', 'lg'];
    function _savedSize() {
      try { const s = localStorage.getItem(SIZE_KEY); return SIZES.includes(s) ? s : 'md'; } catch { return 'md'; }
    }
    function applyGridSize(size) {
      ['cards-recent', 'cards-popular'].forEach(id => {
        const el2 = document.getElementById(id);
        if (el2) { SIZES.forEach(s => el2.classList.remove(`cards--${s}`)); el2.classList.add(`cards--${size}`); }
      });
      document.querySelectorAll('.home-size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === size));
    }
    document.querySelectorAll('.home-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const size = btn.dataset.size;
        try { localStorage.setItem(SIZE_KEY, size); } catch { /* ignore */ }
        applyGridSize(size);
      });
    });
    applyGridSize(_savedSize());

    applyRecentFilters();
    applyPopularFilters();
  } catch {
    el.innerHTML = '<div class="state-box">Search for a game above or navigate to <code>#/app/{appId}</code></div>';
  }
}

export async function renderHomeFallback() {
  const [pulseReports] = await Promise.all([
    fetchRecentPulseReports(),
    loadSearchIndex(),
  ]);
  const popularIds = ['730', '570', '440', '292030', '1245620', '1091500', '1174180', '413150'];
  const titleById = new Map((searchIndex || []).map(([id, title]) => [String(id), title]));
  const popularCards = popularIds
    .map((appId) => ({ appId, title: titleById.get(appId) || `App ${appId}` }))
    .filter((row) => row.title)
    .map((row) => renderGameCard({ href: `#/app/${row.appId}`, appId: row.appId, title: row.title, sub: 'ProtonDB data available' }))
    .join('');

  const pulseCards = renderPulseReportCards(pulseReports);

  return `
    ${pulseCards ? `
      <p class="section-label" style="margin-bottom:10px">Recent Proton Pulse Reports</p>
      <div class="cards" style="margin-bottom:16px">
        ${pulseCards}
      </div>` : ''}
    <p class="section-label" style="margin-bottom:10px">Popular ProtonDB Reports</p>
    <div class="cards">
      ${popularCards}
    </div>`;
}

// Unified activity card used by the merged "Recent Activity" feed on the
// home page. `kind` drives the small REPORT/CONFIG pill on the right plus
// which fields show in the body. Single renderer means both kinds share
// the same hover/click target shape, so the layout is consistent down
// the list instead of two visually separate sections
export function renderActivityCard(kind, row, counts = {}) {
  const isReport = kind === 'report';
  const appId = row.app_id;
  let title, sub, isNonSteam = false;
  if (isReport) {
    title = row.title || `App ${appId}`;
    isNonSteam = isNonSteamAppId(appId);
    const total = (counts.protondbCount || 0) + (counts.pulseCount || 0);
    const countPart = total > 0 ? `${total.toLocaleString()} report${total === 1 ? '' : 's'}` : '';
    const date = row.created_at ? String(row.created_at).slice(0, 10) : '';
    const datePart = date ? `latest: ${date}` : '';
    sub = [countPart, datePart].filter(Boolean).join(' \u00b7 ');
  } else {
    const cfg = row.config || {};
    title = row.app_name || cfg.appName || `App ${appId}`;
    const hwLine = [cfg.protonVersion || '', cfg.profileName || ''].filter(Boolean).join(' | ');
    const d = Math.round((Date.now() / 1000 - new Date(row.updated_at).getTime() / 1000) / 86400);
    const age = d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
    sub = `${hwLine}${hwLine && age ? ' \u00b7 ' : ''}${age}`;
    isNonSteam = cfg.isNonSteam === true || isNonSteamAppId(appId);
  }
  const rating = isReport ? String(row.rating || '').toLowerCase() : '';
  return renderGameCard({
    href: `#/app/${appId}`,
    appId,
    title,
    sub,
    tier: rating || undefined,
    sourceLabel: isNonSteam ? 'Non-Steam' : 'Steam',
  });
}

export function renderPulseReportCards(rows) {
  return rows.map((row) => {
    const rating = String(row.rating || '').toLowerCase();
    const sub = [row.proton_version, daysAgo(Math.floor(new Date(row.created_at).getTime() / 1000))].filter(Boolean).join(' \u00b7 ');
    return renderGameCard({
      href: `#/app/${row.app_id}`,
      appId: row.app_id,
      title: row.title || `App ${row.app_id}`,
      sub,
      tier: rating || undefined,
    });
  }).join('');
}
