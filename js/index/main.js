// Entry module for index.html (homepage). Migrated from index.js.
import { loadSteamImg as _loadSteamImg } from '../app/lib/steam-img.js?v=85cf4195';

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

  function pgCardHtml(g) {
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
    if (ratedCountEl) ratedCountEl.textContent = String(ratedGames.length);
    if (unratedCountEl) unratedCountEl.textContent = String(unratedGames.length);

    const state = { rated: true, unrated: false };

    function renderPopular() {
      const shown = [
        ...(state.rated ? ratedGames : []),
        ...(state.unrated ? unratedGames : []),
      ];
      list.innerHTML = shown.length
        ? shown.map(pgCardHtml).join('')
        : '<div class="pg-empty">No games match the current filters.</div>';
    }

    function wireFilter(btn, key) {
      if (!btn) return;
      btn.addEventListener('click', () => {
        state[key] = !state[key];
        btn.classList.toggle('pg-filter--active', state[key]);
        btn.setAttribute('aria-pressed', String(state[key]));
        renderPopular();
      });
    }
    wireFilter(ratedBtn, 'rated');
    wireFilter(unratedBtn, 'unrated');
    renderPopular();
  } catch (err) {
    console.debug('[popular-games] failed to load most_played.json', { error: String(err) });
    /* leave the section hidden */
  }
})();
