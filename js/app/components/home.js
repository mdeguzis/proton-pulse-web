// home (components) for the app page. Relocated from app.js.

import { fetchRecentPulseReports } from '../api/reports.js?v=a9fb53ae';
import { loadSearchIndex, searchIndex } from './search.js?v=5d6f9f3e';
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

function _filterByTier(reports, tier) {
  if (!tier || tier === 'all') return reports;
  if (tier === 'rated') return reports.filter(r => KNOWN_TIERS.has(r.tier));
  return reports.filter(r => r.tier === tier);
}

function _filterByType(reports, type) {
  if (!type || type === 'all') return reports;
  return reports.filter(r => type === 'protondb'
    ? (r.protondbCount || 0) > 0
    : (r.pulseCount || 0) > 0);
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
    : batch.map(g => renderGameCard({
        href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
        title: g.title, sub: _popularSub(g),
        tier: String(g.rating || '').toLowerCase() || undefined, sourceLabel: 'Steam',
      })).join('');
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

    const unratedToggle = `<button class="unrated-toggle" id="unrated-toggle" type="button"${unratedGames.length ? '' : ' disabled'}>Not rated yet <span class="unrated-count">${unratedGames.length}</span></button>`;

    el.innerHTML = `
      <div class="home-filter-bar">
        <div class="home-filter-selects">
          <div class="home-filter-item">
            <label class="home-filter-label" for="home-sort-select">Sort</label>
            <select id="home-sort-select" class="home-filter-select">
              <option value="recent">Recent</option>
              <option value="best">Best Tier</option>
              <option value="worst">Worst Tier</option>
              <option value="count">Most Reported</option>
            </select>
          </div>
          <div class="home-filter-item">
            <label class="home-filter-label" for="home-tier-select">Tier</label>
            <select id="home-tier-select" class="home-filter-select">
              <option value="all">All</option>
              <option value="rated">Rated only</option>
              <option value="platinum">Platinum</option>
              <option value="gold">Gold</option>
              <option value="silver">Silver</option>
              <option value="bronze">Bronze</option>
              <option value="borked">Borked</option>
            </select>
          </div>
          <div class="home-filter-item">
            <label class="home-filter-label" for="home-type-select">Source</label>
            <select id="home-type-select" class="home-filter-select">
              <option value="all">All</option>
              <option value="protondb">ProtonDB</option>
              <option value="pulse">Pulse</option>
            </select>
          </div>
        </div>
        <div class="home-layout-toggle">
          <button class="home-layout-btn active" data-layout="grid" title="Grid view">Grid</button>
          <button class="home-layout-btn" data-layout="list" title="List view">List</button>
        </div>
      </div>
      <p class="section-label" style="margin-bottom:10px">Recent Reports</p>
      <div class="cards" id="cards-recent"></div>
      <div id="load-more-recent"></div>
      <div class="section-label-row" style="margin-top:24px;margin-bottom:10px">
        <span class="section-label" style="margin:0">Popular on Steam</span>
        ${unratedToggle}
      </div>
      <div class="cards" id="cards-popular"></div>
      <div id="load-more-popular"></div>`;

    let currentSort = 'recent';
    let currentTier = 'all';
    let currentType = 'all';
    let currentLayout = 'grid';
    let showingUnrated = false;
    const unratedQueue = unratedGames.slice(PAGE_SIZE);

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
      if (showingUnrated) return;
      let filtered = ratedGames;
      if (currentTier !== 'all' && currentTier !== 'rated') {
        filtered = filtered.filter(g => String(g.rating || '').toLowerCase() === currentTier);
      }
      if (currentType !== 'all') {
        filtered = filtered.filter(g => currentType === 'protondb'
          ? (g.protondbCount || 0) > 0
          : (g.pulseCount || 0) > 0);
      }
      const cardsEl = document.getElementById('cards-popular');
      const loadMoreEl = document.getElementById('load-more-popular');
      if (!cardsEl) return;
      const initial = filtered.slice(0, PAGE_SIZE);
      const newQueue = filtered.slice(PAGE_SIZE);
      cardsEl.innerHTML = initial.map(g => renderGameCard({
        href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
        title: g.title, sub: _popularSub(g),
        tier: String(g.rating || '').toLowerCase() || undefined, sourceLabel: 'Steam',
      })).join('') || '<div class="state-box">No games match the current filters.</div>';
      if (loadMoreEl) {
        if (newQueue.length) {
          loadMoreEl.innerHTML = _loadMoreBtn('popular');
          loadMoreEl.querySelector('button').addEventListener('click', () => _appendCards('popular', newQueue));
        } else {
          loadMoreEl.innerHTML = initial.length ? _allShownNote(filtered.length) : '';
        }
      }
    }

    function applyRecentFilters() {
      const filtered = _filterByType(_filterByTier(_sortReports(allRecentReports, currentSort), currentTier), currentType);
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

    document.getElementById('home-tier-select')?.addEventListener('change', e => {
      currentTier = e.target.value;
      applyRecentFilters();
      applyPopularFilters();
    });

    document.getElementById('home-type-select')?.addEventListener('change', e => {
      currentType = e.target.value;
      applyRecentFilters();
      applyPopularFilters();
    });

    document.querySelectorAll('.home-layout-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.home-layout-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentLayout = btn.dataset.layout;
        const cardsEl = document.getElementById('cards-recent');
        if (cardsEl) cardsEl.classList.toggle('home-cards-list', currentLayout === 'list');
        applyRecentFilters();
      });
    });

    applyRecentFilters();
    applyPopularFilters();

    document.getElementById('unrated-toggle')?.addEventListener('click', (e) => {
      showingUnrated = !showingUnrated;
      const btn = e.currentTarget;
      btn.classList.toggle('unrated-toggle--active', showingUnrated);
      const cardsEl = document.getElementById('cards-popular');
      const loadMoreEl = document.getElementById('load-more-popular');
      if (showingUnrated) {
        const initial = unratedGames.slice(0, PAGE_SIZE);
        cardsEl.innerHTML = initial.map(g => renderGameCard({
          href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
          title: g.title, sub: 'No reports yet \u00b7 be the first',
          tier: 'pending', sourceLabel: 'Steam',
        })).join('');
        loadMoreEl.innerHTML = unratedQueue.length ? _loadMoreBtn('popular') : '';
        loadMoreEl.querySelector('button')?.addEventListener('click', () => {
          const batch = unratedQueue.splice(0, PAGE_SIZE);
          cardsEl.insertAdjacentHTML('beforeend', batch.map(g => renderGameCard({
            href: `#/app/${g.appId}`, appId: g.appId, imgUrl: g.headerImage || undefined,
            title: g.title, sub: 'No reports yet \u00b7 be the first',
            tier: 'pending', sourceLabel: 'Steam',
          })).join(''));
          if (!unratedQueue.length) loadMoreEl.innerHTML = '';
        });
      } else {
        applyPopularFilters();
      }
    });
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
