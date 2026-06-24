// Entry module for index.html (homepage). Migrated from index.js.
import { loadSteamImg as _loadSteamImg } from '../app/lib/steam-img.js?v=3e345596';

// Homepage-only logic. Universal nav chrome (banner, nav row, mobile drawer,
// search dropdown, auth indicator) lives in topbar.js.

// Pulse report count. Uses HEAD + Content-Range so we don't care whether
// PostgREST returns the aggregate in the body; the header is always there
// when Prefer: count=exact is set. Range: 0-0 keeps the response tiny.
(async function loadPulseStats() {
  const SB = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
  const KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
  try {
    const resp = await fetch(`${SB}/user_configs?select=id`, {
      method: 'HEAD',
      headers: { apikey: KEY, Prefer: 'count=exact', Range: '0-0' },
    });
    // content-range looks like "0-0/1234" or "*/1234"
    const range = resp.headers.get('content-range') || '';
    const total = parseInt(range.split('/')[1], 10);
    const count = Number.isFinite(total) ? total : 0;
    const el = document.getElementById('pulse-report-count');
    if (el) el.textContent = count.toLocaleString();
  } catch (_) {}
})();

// Coverage stats. Prefers /coverage-summary.json (emitted by the data pipeline
// in scripts/pipeline/finalize.py:generate_coverage_report) since it's tiny
// and structured. Falls back to scraping coverage.html if the JSON isn't there
// (e.g. an older deployment). In local vite dev both 404 -> em-dash stays.
(async function loadCoverageStats() {
  function setStat(id, value) {
    if (value == null) return;
    const el = document.getElementById(id);
    if (el) el.textContent = typeof value === 'number' ? value.toLocaleString() : value;
  }

  // try the JSON summary first
  try {
    const resp = await fetch('coverage-summary.json', { cache: 'no-store' });
    if (resp.ok) {
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('application/json') || ct.includes('text/plain')) {
        const data = await resp.json();
        setStat('stat-steam-games',    data.steam_games);
        setStat('stat-protondb-games', data.protondb_games);
        setStat('stat-indexed',        data.indexed);
        return;
      }
    }
  } catch (_) { /* fall through to HTML scrape */ }

  // fallback: parse coverage.html for the same numbers
  try {
    const resp = await fetch('coverage.html');
    if (!resp.ok) return;
    const html = await resp.text();
    function pick(label) {
      const safe = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        '<div class="label">' + safe + '<\\/div>\\s*<div class="value">([\\d,]+)<\\/div>'
      );
      const m = html.match(re);
      return m ? m[1] : null;
    }
    setStat('stat-steam-games',    pick('Steam Games'));
    setStat('stat-protondb-games', pick('ProtonDB Total'));
    setStat('stat-indexed',        pick('Indexed (with data)'));
  } catch (_) { /* leave em-dash placeholders */ }
})();

// Popular games on Steam. Reads most_played.json (produced by the pipeline:
// Steam's most-played titles cross-referenced with our compat rating). Renders
// a wide-card list. The section stays hidden until data lands so it never shows
// empty on a fetch miss (older deploys / local dev without the file).
(async function loadPopularGames() {
  const list = document.getElementById('pg-list');
  const section = document.getElementById('popular-games');
  if (!list || !section) return;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  // 1275982 -> "1.3M", 732248 -> "732K", 940 -> "940"
  function fmtPeak(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
  }

  const RATING_LABEL = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked' };
  // Tiers that count as a real compatibility rating. Anything else (catalog,
  // pending, empty) is a title we list but have no reports for yet.
  const KNOWN_TIERS = new Set(['platinum', 'gold', 'silver', 'bronze', 'borked']);

  let currentLayout = 'grid';

  function pgCardHtml(g) {
    if (currentLayout === 'list') return pgListRowHtml(g);
    const img = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(g.appId)}/header.jpg`;
    const peak = fmtPeak(g.peak);
    const rating = String(g.rating || '').toLowerCase();
    const rated = KNOWN_TIERS.has(rating);
    const badgeClass = rated ? `pg-${rating}` : 'pg-unrated';
    const rLabel = rated ? RATING_LABEL[rating] : 'Unrated';
    return `
      <a class="pg-card" href="app.html#/app/${encodeURIComponent(g.appId)}">
        <img class="pg-thumb" src="${img}" data-appid="${g.appId}" alt="" loading="lazy" onerror="window.__steamImgLoad(this)">
        <div class="pg-info">
          <div class="pg-title">${esc(g.title)}</div>
          ${peak ? `<div class="pg-sub">${peak} peak players</div>` : ''}
        </div>
        <span class="pg-badge ${badgeClass}">${rLabel}</span>
      </a>`;
  }

  function pgListRowHtml(g) {
    const rating = String(g.rating || '').toLowerCase();
    const rated = KNOWN_TIERS.has(rating);
    const rLabel = rated ? RATING_LABEL[rating] : '?';
    const peak = fmtPeak(g.peak);
    return `<a class="pg-list-row" href="app.html#/app/${encodeURIComponent(g.appId)}">
      <span class="pg-list-tier pg-badge ${rated ? `pg-${rating}` : 'pg-unrated'}">${rLabel}</span>
      <span class="pg-list-title">${esc(g.title)}</span>
      <span class="pg-list-meta">${peak ? peak + ' peak' : ''}</span>
    </a>`;
  }

  try {
    const resp = await fetch('most_played.json', { cache: 'no-store' });
    if (!resp.ok) {
      console.debug('[popular-games] most_played.json fetch not ok', { status: resp.status });
      return;
    }
    const games = await resp.json();
    if (!Array.isArray(games) || games.length === 0) {
      console.debug('[popular-games] most_played.json empty or not an array', { type: typeof games });
      return;
    }

    // Split into rated games and unrated titles that lack reports
    // (catalog/pending). Two independent filter buttons drive the view:
    // "Rated" (on by default) and "Not Rated" (off by default). Any
    // combination is allowed, including both on or both off.
    const ratedGames = games.filter((g) => KNOWN_TIERS.has(String(g.rating || '').toLowerCase()));
    const unratedGames = games.filter((g) => !KNOWN_TIERS.has(String(g.rating || '').toLowerCase()));
    console.debug('[popular-games] loaded most_played.json', {
      total: games.length, rated: ratedGames.length, unrated: unratedGames.length, source: 'most_played.json',
    });

    section.hidden = false;

    const ratedBtn = document.getElementById('pg-filter-rated');
    const unratedBtn = document.getElementById('pg-filter-unrated');
    const ratedCountEl = document.getElementById('pg-rated-count');
    const unratedCountEl = document.getElementById('pg-unrated-count');
    const loadMoreEl = document.getElementById('pg-load-more');
    if (ratedCountEl) ratedCountEl.textContent = String(ratedGames.length);
    if (unratedCountEl) unratedCountEl.textContent = String(unratedGames.length);

    const PAGE_SIZE = 12;
    const state = { rated: true, unrated: false };
    let shownCount = PAGE_SIZE;

    // The combined list of games to show for the current filter state.
    function currentList() {
      return [
        ...(state.rated ? ratedGames : []),
        ...(state.unrated ? unratedGames : []),
      ];
    }

    function renderPopular() {
      const all = currentList();
      if (!all.length) {
        list.innerHTML = '<div class="pg-empty">No games match the current filters.</div>';
        if (loadMoreEl) loadMoreEl.innerHTML = '';
        return;
      }
      list.innerHTML = all.slice(0, shownCount).map(pgCardHtml).join('');
      if (loadMoreEl) {
        const remaining = all.length - shownCount;
        loadMoreEl.innerHTML = remaining > 0
          ? `<button class="pg-load-more" id="pg-load-more-btn" type="button">Load more <span class="pg-load-more-count">${remaining}</span></button>`
          : '';
        const moreBtn = document.getElementById('pg-load-more-btn');
        if (moreBtn) moreBtn.addEventListener('click', () => { shownCount += PAGE_SIZE; renderPopular(); });
      }
    }

    // Rated / Not Rated are mutually exclusive (either-or): selecting one
    // deselects the other, and exactly one is always active.
    function selectFilter(key) {
      state.rated = key === 'rated';
      state.unrated = key === 'unrated';
      ratedBtn?.classList.toggle('pg-filter--active', state.rated);
      unratedBtn?.classList.toggle('pg-filter--active', state.unrated);
      ratedBtn?.setAttribute('aria-pressed', String(state.rated));
      unratedBtn?.setAttribute('aria-pressed', String(state.unrated));
      shownCount = PAGE_SIZE; // restart paging when the filter changes
      renderPopular();
    }
    ratedBtn?.addEventListener('click', () => selectFilter('rated'));
    unratedBtn?.addEventListener('click', () => selectFilter('unrated'));

    // S/M/L card size (saved preference, shared key with app page)
    const SIZE_KEY = 'pp:grid-size';
    const SIZES = ['sm', 'md', 'lg'];
    function savedSize() {
      try { const s = localStorage.getItem(SIZE_KEY); return SIZES.includes(s) ? s : 'md'; } catch { return 'md'; }
    }
    function applySize(size) {
      SIZES.forEach(s => list.classList.remove(`pg-list--${s}`));
      list.classList.add(`pg-list--${size}`);
      document.querySelectorAll('.pg-size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === size));
    }
    function setSizeEnabled(enabled) {
      document.querySelectorAll('.pg-size-btn').forEach(b => { b.disabled = !enabled; });
      document.getElementById('pg-size-toggle')?.classList.toggle('pg-size-toggle--disabled', !enabled);
    }
    document.querySelectorAll('.pg-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        try { localStorage.setItem(SIZE_KEY, btn.dataset.size); } catch { /* ignore */ }
        applySize(btn.dataset.size);
      });
    });

    // Grid/List layout (saved preference, shared key with app page)
    const LAYOUT_KEY = 'pp:grid-layout';
    function savedLayout() {
      try { const l = localStorage.getItem(LAYOUT_KEY); return (l === 'list' || l === 'grid') ? l : 'grid'; } catch { return 'grid'; }
    }
    function applyLayout(layout) {
      currentLayout = layout;
      const isList = layout === 'list';
      list.classList.toggle('pg-list--list-mode', isList);
      document.querySelectorAll('.pg-layout-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
      setSizeEnabled(!isList);
      renderPopular();
    }
    document.querySelectorAll('.pg-layout-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        try { localStorage.setItem(LAYOUT_KEY, btn.dataset.layout); } catch { /* ignore */ }
        applyLayout(btn.dataset.layout);
      });
    });

    applySize(savedSize());
    applyLayout(savedLayout());
  } catch (err) {
    console.debug('[popular-games] failed to load most_played.json', { error: String(err) });
    /* leave the section hidden */
  }
})();
