// Entry module for index.html (homepage). Migrated from index.js.

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
