import json
import math
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .catalog import (
    DEFAULT_PROTONDB_PROBE_CACHE_PATH,
    get_protondb_probe_cache_max_age_seconds,
    get_protondb_probe_limit,
    get_protondb_probe_log_every,
    get_steam_api_key,
    load_protondb_signal_catalog,
    load_steam_game_catalog,
    probe_protondb_app_ids,
    read_protondb_probe_cache,
    write_protondb_probe_cache,
)
from .common import (
    LIVE_COUNTS_URL,
    app_id_to_dir,
    app_type_from_id,
    count_year_bucket_files,
    dir_to_app_id,
    fetch_json,
    flush_steam_title_cache,
    log,
)
from .gog_catalog import load_gog_catalog
from .metadata import bootstrap_all_app_metadata, read_app_metadata
from .game_images import build_game_images
from .most_played import build_most_played
from .pulse import merge_pulse_into_data_dir
from .state import read_pipeline_state
from .stats import write_stats_json


def log_summary(
    parsed_count: int,
    data_output_path: Path,
    output_path: Path,
    pipeline_start: float,
    backfilled_keys: set[tuple],
) -> None:
    total_elapsed = time.time() - pipeline_start
    unique_apps = sum(1 for p in data_output_path.iterdir() if p.is_dir())
    total_year_files = count_year_bucket_files(data_output_path)
    backfilled_apps = len({app_id for app_id, _year in backfilled_keys})
    backfilled_year_files = len(backfilled_keys)

    log(f"\n[summary] Total reports parsed    : {parsed_count:,}")
    log(f"[summary] Unique app directories  : {unique_apps:,}")
    log(f"[summary] Total year bucket files : {total_year_files:,}")
    log(f"[summary] Backfilled app IDs      : {backfilled_apps:,}")
    log(f"[summary] Backfilled year buckets : {backfilled_year_files:,}")
    log(f"[summary] Main index file         : {(output_path / 'data-index.html').resolve()}")
    log(f"[summary] Total time              : {total_elapsed:.1f}s")
    log(f"[summary] Output dir              : {data_output_path.resolve()}")


def generate_latest_files(data_output_path: Path) -> None:
    count = 0
    for app_dir in data_output_path.iterdir():
        if not app_dir.is_dir():
            continue
        year_files = sorted(app_dir.glob("*.json"), key=lambda p: p.stem)
        year_files = [f for f in year_files if f.stem not in {"latest", "index", "votes", "metadata"}]
        if not year_files:
            continue
        latest_src = year_files[-1]
        latest_dst = app_dir / "latest.json"
        latest_dst.write_bytes(latest_src.read_bytes())
        count += 1
    log(f"[latest] Generated {count} latest.json files", debug=True)


def reindex_apps(output_dir: str, app_ids: list[str]) -> None:
    """Rebuild index.json only for specific app IDs, scanning their year files on disk."""
    data_path = Path(output_dir) / "data"
    index_keys: set[tuple[str, str]] = set()
    for app_id in app_ids:
        app_dir = data_path / app_id_to_dir(app_id)
        if not app_dir.is_dir():
            log(f"[reindex] Skipping {app_id}: no data directory")
            continue
        for json_file in app_dir.glob("*.json"):
            if json_file.stem in ("index", "latest", "votes", "metadata"):
                continue
            index_keys.add((app_id, json_file.stem))
    if index_keys:
        generate_app_indexes(index_keys, data_path)
    log(f"[reindex] Rebuilt indexes for {len(app_ids)} app(s)")


def generate_app_indexes(index_keys: set, data_output_path: Path) -> None:
    app_years: dict[str, list[str]] = {}
    for (app_id, year) in index_keys:
        app_years.setdefault(app_id, []).append(year)

    for app_id, years in app_years.items():
        sorted_years = sorted(years, key=lambda y: (0, int(y)) if y.isdigit() else (1, y))
        app_dir = data_output_path / app_id_to_dir(app_id)
        app_dir.mkdir(parents=True, exist_ok=True)
        index_file = app_dir / "index.json"
        index_file.write_text(json.dumps(sorted_years))

        links = ['<li><a href="latest.json"><strong>latest.json</strong></a></li>']
        for year in sorted_years:
            links.append(f'<li><a href="{year}.json">{year}.json</a></li>')
        title = _extract_title(app_dir)
        display_name = f"{title} ({app_id})" if title else app_id
        html = (
            f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="color-scheme" content="dark">'
            f"<title>{display_name} - proton-pulse-web</title>"
            f"<style>"
            f"body {{ background: #101418; color: #d0dae6; font: 15px/1.6 system-ui, sans-serif; margin: 2rem; }}"
            f"a {{ color: #4a9fd0; }} h1 {{ color: #f0f4f8; }}"
            f"ul {{ padding-left: 1.25rem; }} li {{ margin: 0.3rem 0; }}"
            f"</style>"
            f"</head><body>"
            f"<h1>{display_name}</h1><ul>{''.join(links)}</ul>"
            f'<p><a href="../../app.html#/app/{app_id}">View reports</a>'
            f' | <a href="../../data-index.html">Data Index</a>'
            f' | <a href="../../coverage.html">Coverage Report</a></p>'
            f"</body></html>"
        )
        (app_dir / "index.html").write_text(html)

        log(f"[app-index] {app_id}/index.json -> {sorted_years}")


def generate_index_html(index_keys: set, output_path: Path) -> None:
    app_years: dict[str, list[str]] = {}
    for (app_id, year) in index_keys:
        app_years.setdefault(app_id, []).append(year)

    sorted_app_ids = sorted(app_years.keys(), key=lambda a: (0, int(a)) if a.isdigit() else (1, a))
    for app_id in sorted_app_ids:
        app_years[app_id] = sorted(app_years[app_id], key=lambda y: (0, int(y)) if y.isdigit() else (1, y))

    # Build a title lookup for all apps
    data_path = output_path / "data"
    app_titles: dict[str, str] = {}
    for app_id in sorted_app_ids:
        title = _extract_title(data_path / app_id_to_dir(app_id))
        app_titles[app_id] = title

    sample_apps = {
        "730": "Counter-Strike 2",
        "570": "Dota 2",
        "440": "Team Fortress 2",
        "292030": "The Witcher 3",
        "1245620": "Elden Ring",
        "1091500": "Cyberpunk 2077",
        "1174180": "Red Dead Redemption 2",
        "413150": "Stardew Valley",
        "814380": "Sekiro",
        "1086940": "Baldur's Gate 3",
    }

    sample_entries = []
    for app_id, name in sample_apps.items():
        if app_id in app_years:
            sample_entries.append(f'<a href="data/{app_id}/latest.json">{name}</a> ({app_id})')

    # Page-specific styles. Site-wide identity comes from site.css; this block only
    # adds what data-index needs (grid rows, detail split, json tinting). All colors
    # ride the same --accent / --green-hi / --mono variables for visual consistency.
    page_style = """
    h1 { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.02em; margin-bottom: 0.4em; }
    .meta { color: var(--muted); font-family: var(--mono); font-size: 0.8rem; letter-spacing: 0.04em; margin-bottom: 1em; }
    .popular { margin-bottom: 1.4em; }
    .popular .label { font-family: var(--mono); font-size: 0.7rem; color: var(--muted); letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 6px; }
    .popular a { color: var(--accent); }
    .filter-row { margin: 14px 0 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    #index-filter { flex: 0 1 380px; padding: 8px 12px; background: rgba(11,17,22,0.6); border: 1px solid var(--border2); color: var(--text); font-size: 0.88rem; font-family: inherit; }
    #index-filter:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    #index-filter-help { font-size: 0.78rem; color: var(--muted); margin: 0; }
    .pager { margin: 1em 0; display: flex; gap: 8px; align-items: center; font-family: var(--mono); font-size: 0.8rem; }
    .pager button { padding: 6px 14px; background: rgba(11,17,22,0.6); color: var(--text); border: 1px solid var(--border2); cursor: pointer; font-family: inherit; font-size: 0.8rem; }
    .pager button:hover:not(:disabled) { background: var(--s2); border-color: var(--accent); }
    .pager button:disabled { opacity: 0.4; cursor: not-allowed; }
    #index-page-info { color: var(--muted); }
    ul#index-results { list-style: none; padding: 0; margin: 12px 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 8px; }
    ul#index-results > li { display: contents; }
    ul#index-results a.row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: linear-gradient(180deg, rgba(27,40,56,0.5), rgba(11,17,22,0.4)); border: 1px solid var(--border); color: var(--text); transition: border-color .12s, background .12s, transform .12s, box-shadow .12s; }
    ul#index-results a.row:hover { border-color: var(--accent); background: linear-gradient(180deg, rgba(102,192,244,0.08), rgba(11,17,22,0.5)); box-shadow: 0 0 18px -6px var(--accent-glow); transform: translateY(-1px); text-decoration: none; }
    ul#index-results .appid { font-family: var(--mono); font-size: 0.78rem; color: var(--accent); min-width: 80px; flex-shrink: 0; }
    ul#index-results .title { flex: 1; color: var(--text); }
    ul#index-results .years { font-family: var(--mono); font-size: 0.72rem; color: var(--muted); flex-shrink: 0; }

    /* detail view: master/detail split with years on the left, JSON on the right */
    .detail-view { display: none; }
    .detail-view.is-open { display: block; }
    .grid-view.is-hidden { display: none; }
    .detail-head { display: flex; align-items: center; gap: 14px; margin: 16px 0; padding: 14px 18px; background: linear-gradient(180deg, rgba(27,40,56,0.55), rgba(11,17,22,0.45)); border: 1px solid var(--border); border-left: 3px solid var(--accent); flex-wrap: wrap; }
    .detail-head .back { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: rgba(11,17,22,0.55); border: 1px solid var(--border2); color: var(--muted); font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; }
    .detail-head .back:hover { color: var(--accent-hi); border-color: var(--accent); text-decoration: none; }
    .detail-title { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.02em; font-size: 1.2rem; color: var(--strong); margin: 0; }
    .detail-appid { font-family: var(--mono); font-size: 0.78rem; color: var(--accent); letter-spacing: 0.06em; }
    .detail-spacer { flex: 1; }
    .detail-split { display: grid; grid-template-columns: 200px 1fr; gap: 16px; align-items: stretch; min-height: 500px; }
    @media (max-width: 760px) {
      /* minmax(0, 1fr) instead of 1fr so the grid track actually constrains its
         child - without it, the year-list defaults to min-width: auto and grows
         to fit content width, defeating its own overflow-x: auto */
      .detail-split { grid-template-columns: minmax(0, 1fr); min-height: 0; }
    }
    .year-list { display: flex; flex-direction: column; gap: 4px; padding: 12px; background: rgba(11,17,22,0.4); border: 1px solid var(--border); }
    .year-list .label { font-family: var(--mono); font-size: 0.66rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.18em; margin-bottom: 6px; }
    .year-list button { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: transparent; border: 1px solid transparent; border-left: 2px solid var(--border2); color: var(--muted); font-family: var(--mono); font-size: 0.86rem; text-align: left; cursor: pointer; }
    .year-list button:hover { color: var(--text); background: rgba(102,192,244,0.05); border-left-color: var(--accent-soft); }
    .year-list button.is-active { color: var(--accent-hi); background: var(--accent-soft); border-left-color: var(--accent); box-shadow: inset 2px 0 8px -2px var(--accent-glow); }
    .year-list button .badge { margin-left: auto; font-family: var(--mono); font-size: 0.62rem; color: var(--green-hi); letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.7; }
    /* mobile: year-list becomes a horizontal scroll strip so it never eats vertical space */
    @media (max-width: 760px) {
      .year-list { flex-direction: row; overflow-x: auto; overflow-y: hidden; gap: 6px; padding: 8px 10px; align-items: stretch; scroll-snap-type: x proximity; scrollbar-width: thin; }
      .year-list .label { flex-shrink: 0; align-self: center; margin-bottom: 0; margin-right: 4px; }
      .year-list button { flex-shrink: 0; border-left: none !important; border-bottom: 2px solid var(--border2); padding: 6px 10px; scroll-snap-align: start; }
      .year-list button.is-active { border-bottom-color: var(--accent) !important; box-shadow: none !important; }
    }
    .json-pane { display: flex; flex-direction: column; background: rgba(11,17,22,0.55); border: 1px solid var(--border); overflow: hidden; }
    .json-pane-head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--s1); font-family: var(--mono); font-size: 0.78rem; }
    .json-pane-head .path { color: var(--accent); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .json-pane-head .status { color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; font-size: 0.7rem; }
    .json-pane-head .copy { background: none; border: 1px solid var(--border2); color: var(--muted); padding: 2px 8px; font-family: var(--mono); font-size: 0.72rem; cursor: pointer; }
    .json-pane-head .copy:hover { color: var(--accent-hi); border-color: var(--accent); }
    .json-pane pre { flex: 1; margin: 0; padding: 14px 18px; overflow: auto; font-family: var(--mono); font-size: 0.78rem; line-height: 1.6; color: var(--text); max-height: 70vh; }
    .json-pane .tok-k { color: var(--accent-hi); }
    .json-pane .tok-s { color: var(--green-hi); }
    .json-pane .tok-n { color: #ff9d4d; }
    .json-pane .tok-b { color: var(--magenta); }
    .json-pane .tok-nl { color: var(--muted); }
"""

    lines = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="utf-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1">',
        '  <meta name="color-scheme" content="dark">',
        "  <title>Data Index - Proton Pulse</title>",
        '  <link rel="stylesheet" href="site.css">',
        f'  <style>{page_style}</style>',
        "</head>",
        "<body>",
        # topbar.js injects the shared banner + nav at body start
        '<script src="topbar.js"></script>',
        '<div class="main-content"><div class="main-inner">',

        # ── grid view ──
        '<section class="grid-view">',
        "<h1>Data Index</h1>",
        '<p class="meta">// Per-game JSON reports under <code>/data/{appId}/</code></p>',
        f'<p class="meta"><strong>{len(sorted_app_ids):,}</strong> games tracked &middot; monthly-updated community reports</p>',
    ]

    if sample_entries:
        lines.append('<div class="popular"><div class="label">Popular titles</div>')
        lines.append('<p>' + " &middot; ".join(sample_entries) + '</p></div>')

    lines += [
        '<div class="filter-row">',
        '  <input id="index-filter" type="search" placeholder="Filter by title or App ID..." autocomplete="off">',
        '  <p id="index-filter-help">Filter is saved in the URL.</p>',
        "</div>",
        '<div class="pager">',
        '  <button id="index-prev" type="button">Previous</button>',
        '  <span id="index-page-info">Loading…</span>',
        '  <button id="index-next" type="button">Next</button>',
        "</div>",
        '<ul id="index-results"></ul>',
        "</section>",

        # ── detail view (hidden until a tile is clicked) ──
        '<section class="detail-view" id="detail-view">',
        '  <div class="detail-head">',
        '    <a class="back" href="#" id="detail-back">&larr; Back to index</a>',
        '    <h2 class="detail-title" id="detail-title">—</h2>',
        '    <span class="detail-appid" id="detail-appid"></span>',
        "  </div>",
        '  <div class="detail-split">',
        '    <div class="year-list" id="year-list"><div class="label">Year files</div></div>',
        '    <div class="json-pane">',
        '      <div class="json-pane-head">',
        '        <span class="path" id="json-path">/data/—/—.json</span>',
        '        <span class="status" id="json-status">Loading…</span>',
        '        <button class="copy" id="json-copy" type="button">Copy</button>',
        "      </div>",
        '      <pre id="json-content"></pre>',
        "    </div>",
        "  </div>",
        "</section>",
    ]

    js_entries = []
    for app_id in sorted_app_ids:
        title = app_titles.get(app_id, "")
        display = f"{title} ({app_id})" if title else f"{app_id}/"
        years = sorted(app_years[app_id], key=lambda year: int(year) if str(year).isdigit() else str(year))
        js_entries.append(json.dumps([app_id, title, display, years], separators=(",", ":")))

    now = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines += [
        f"<script>const indexEntries=[{','.join(js_entries)}];</script>",
        f'<p class="meta" style="margin-top:24px">// Generated: {now}</p>',
        "</div></div>",  # close .main-content / .main-inner

        # The behavior script is large enough that splitting it into one string per
        # line bloats the file - emit it as a single <script> block instead.
        """<script>
(function () {
  // ---- Grid view rendering with pagination ----
  const PAGE_SIZE = 200;
  const indexFilter = document.getElementById('index-filter');
  const indexFilterHelp = document.getElementById('index-filter-help');
  const indexResults = document.getElementById('index-results');
  const indexPrev = document.getElementById('index-prev');
  const indexNext = document.getElementById('index-next');
  const indexPageInfo = document.getElementById('index-page-info');
  let filteredEntries = indexEntries;
  let currentPage = 0;

  function readQuery() {
    return new URLSearchParams(location.search).get('q') || '';
  }
  function writeQuery(value) {
    const params = new URLSearchParams(location.search);
    if (value) params.set('q', value); else params.delete('q');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }

  function renderPage() {
    const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(0, currentPage), totalPages - 1);
    const start = currentPage * PAGE_SIZE;
    const slice = filteredEntries.slice(start, start + PAGE_SIZE);
    indexResults.innerHTML = slice.map(([appId, title, _display, years]) => {
      const yearStr = years.join(' ');
      const safeTitle = (title || appId).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      return `<li><a class="row" href="#/${appId}">` +
             `<span class="appid">${appId}</span>` +
             `<span class="title">${safeTitle}</span>` +
             `<span class="years">${yearStr}</span>` +
             `</a></li>`;
    }).join('');
    indexPageInfo.textContent = filteredEntries.length
      ? `Showing ${start + 1}–${Math.min(start + slice.length, filteredEntries.length)} of ${filteredEntries.length.toLocaleString()}`
      : 'No matching apps';
    indexPrev.disabled = currentPage === 0;
    indexNext.disabled = currentPage >= totalPages - 1 || filteredEntries.length === 0;
  }

  function applyFilter() {
    const raw = indexFilter.value.trim();
    const q = raw.toLowerCase();
    filteredEntries = !q ? indexEntries : indexEntries.filter(([appId, title, display]) => {
      return (`${appId} ${title} ${display}`).toLowerCase().includes(q);
    });
    currentPage = 0;
    indexFilterHelp.textContent = q
      ? `${filteredEntries.length.toLocaleString()} matching app${filteredEntries.length === 1 ? '' : 's'}`
      : 'Filter is saved in the URL.';
    writeQuery(raw);
    renderPage();
  }

  indexFilter.value = readQuery();
  indexFilter.addEventListener('input', applyFilter);
  indexPrev.addEventListener('click', () => { if (currentPage > 0) { currentPage--; renderPage(); } });
  indexNext.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
    if (currentPage < totalPages - 1) { currentPage++; renderPage(); }
  });
  applyFilter();

  // ---- Detail view: master/detail split with real JSON fetch ----
  const gridView = document.querySelector('.grid-view');
  const detailView = document.getElementById('detail-view');
  const titleEl = document.getElementById('detail-title');
  const appidEl = document.getElementById('detail-appid');
  const yearListEl = document.getElementById('year-list');
  const pathEl = document.getElementById('json-path');
  const statusEl = document.getElementById('json-status');
  const contentEl = document.getElementById('json-content');
  const copyBtn = document.getElementById('json-copy');
  const backBtn = document.getElementById('detail-back');

  function entryFor(appId) {
    return indexEntries.find(e => e[0] === appId);
  }

  function jsonHtml(value) {
    const json = JSON.stringify(value, null, 2);
    return json
      .replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
      .replace(/("(\\\\u[a-fA-F0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(\\.\\d*)?([eE][+\\-]?\\d+)?)/g, function (m) {
        let cls = 'tok-n';
        if (/^"/.test(m)) cls = /:$/.test(m) ? 'tok-k' : 'tok-s';
        else if (/^(true|false)$/.test(m)) cls = 'tok-b';
        else if (/null/.test(m)) cls = 'tok-nl';
        return '<span class="' + cls + '">' + m + '</span>';
      });
  }

  // Pulse + ProtonDB are merged into year.json by the pipeline (see
  // scripts/pipeline/pulse.py), so we just render whatever is in the file.
  // Each record carries a source field ("protondb" or "pulse") so consumers
  // can filter cleanly.
  let activeFetch = null;
  function loadYear(appId, file) {
    pathEl.textContent = '/data/' + appId + '/' + file;
    statusEl.textContent = 'loading';
    contentEl.textContent = '';
    const url = 'data/' + appId + '/' + file;
    const token = Symbol();
    activeFetch = token;
    fetch(url).then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        if (activeFetch !== token) return;
        const list = Array.isArray(data) ? data : [];
        const pulseN = list.filter(r => r && r.source === 'pulse').length;
        const protondbN = list.length - pulseN;
        statusEl.textContent = pulseN
          ? protondbN + ' ProtonDB + ' + pulseN + ' Pulse'
          : list.length + ' reports';
        contentEl.innerHTML = jsonHtml(data);
      })
      .catch(err => {
        if (activeFetch !== token) return;
        statusEl.textContent = 'error';
        contentEl.textContent = 'Failed to load ' + url + ' (' + err + ')';
      });
  }

  function openDetail(appId, year) {
    const entry = entryFor(appId);
    if (!entry) { closeDetail(); return; }
    const [, title, , years] = entry;
    // Two distinct UI states: "latest mode" (no year in hash) vs "year mode"
    // (specific year). Even though latest.json on disk == latest year.json,
    // only one button is highlighted at a time. Loaded file resolves to the
    // newest year file in either case (latest.json is just a mirror).
    const useLatest = !year;
    const targetYear = year && years.includes(year) ? year : years[years.length - 1];

    gridView.classList.add('is-hidden');
    detailView.classList.add('is-open');
    titleEl.textContent = title || appId;
    appidEl.textContent = '// ' + appId;

    yearListEl.innerHTML = '<div class="label">Year files</div>' +
      '<button data-file="latest.json" data-mode="latest" class="' + (useLatest ? 'is-active' : '') + '">' +
        '<span class="file">latest.json</span><span class="badge">latest</span></button>' +
      years.slice().reverse().map(y => {
        const file = y + '.json';
        const active = !useLatest && y === targetYear;
        return '<button data-year="' + y + '" data-file="' + file + '" class="' + (active ? 'is-active' : '') + '">' +
               '<span class="file">' + file + '</span></button>';
      }).join('');

    yearListEl.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        yearListEl.querySelectorAll('button').forEach(x => x.classList.remove('is-active'));
        b.classList.add('is-active');
        const y = b.dataset.year;
        if (y) history.replaceState(null, '', '#/' + appId + '/' + y);
        else history.replaceState(null, '', '#/' + appId);
        loadYear(appId, b.dataset.file);
      });
    });

    // Default load: latest.json content for either mode (the file on disk
    // mirrors the newest year). The visual highlight tells you which mode
    loadYear(appId, useLatest ? 'latest.json' : (targetYear + '.json'));
  }

  function closeDetail() {
    gridView.classList.remove('is-hidden');
    detailView.classList.remove('is-open');
    activeFetch = null;
  }

  backBtn.addEventListener('click', e => {
    e.preventDefault();
    history.pushState(null, '', location.pathname + location.search);
    closeDetail();
  });

  copyBtn.addEventListener('click', () => {
    const txt = contentEl.textContent;
    navigator.clipboard?.writeText(txt).then(() => {
      const old = copyBtn.textContent;
      copyBtn.textContent = 'Copied';
      setTimeout(() => copyBtn.textContent = old, 1200);
    });
  });

  function routeFromHash() {
    const m = location.hash.match(/^#\\/(\\d+)(?:\\/(\\d{4}))?/);
    if (m) openDetail(m[1], m[2]);
    else closeDetail();
  }
  window.addEventListener('hashchange', routeFromHash);
  routeFromHash();
})();
</script>""",
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>',
        '<script src="supabase-client.js"></script>',
        "</body>",
        "</html>",
    ]

    index_file = output_path / "data-index.html"
    index_file.write_text("\n".join(lines) + "\n")
    log(f"[index] Written: {index_file}", debug=True)


def _extract_title(app_dir: Path) -> str:
    latest = app_dir / "latest.json"
    if not latest.exists():
        return ""
    try:
        reports = json.loads(latest.read_text())
        if reports and isinstance(reports, list):
            return reports[0].get("title", "") or ""
    except Exception:
        pass
    return ""


def _resolve_coverage_title(
    app_id: str,
    data_output_path: Path,
    protondb_signal_catalog: dict[str, str] | None = None,
    steam_catalog: dict[str, str] | None = None,
) -> tuple[str, str]:
    local_title = _extract_title(data_output_path / app_id_to_dir(app_id))
    if local_title:
        return local_title, "indexed-data"

    signal_title = (protondb_signal_catalog or {}).get(app_id, "")
    if signal_title:
        return signal_title, "protondb-signal"

    steam_title = (steam_catalog or {}).get(app_id, "")
    if steam_title:
        return steam_title, "steam-catalog"

    return "", "none"


def derive_index_keys_from_disk(data_output_path: Path) -> set[tuple[str, str]]:
    """Walk data/ on disk and return every (app_id, year) tuple present.

    state["index_keys"] only contains apps PROCESSED in the current run. After
    the gh-pages merge step brings in 21k+ historical apps that this run
    didn't reprocess, those apps live on disk but aren't in pipeline-state.
    The data-index and search-index generators iterate index_keys, so without
    this disk-derived merge, they emit only the current-run set - which is
    how a scheduled run that picked up a single dump update wiped data-index
    down to one entry on prod.
    """
    keys: set[tuple[str, str]] = set()
    if not data_output_path.exists():
        return keys
    for app_dir in data_output_path.iterdir():
        if not app_dir.is_dir():
            continue
        dir_name = app_dir.name
        app_id = dir_to_app_id(dir_name)
        # skip dirs that aren't valid app IDs (e.g. plain text dirs, unknown prefixes)
        if not (app_id.isdigit() or app_id.startswith("gog:") or app_id.startswith("epic:")):
            continue
        for year_file in app_dir.glob("*.json"):
            stem = year_file.stem
            if stem in ("index", "latest", "votes", "metadata"):
                continue
            keys.add((app_id, stem))
    return keys


# Per-rating contribution to a game's overall score, on a 0..1 scale. Mirrors
# scoring-info.json:ratingScores so the search-index tier maps cleanly back
# onto the scoring page's score thresholds.
_RATING_SCORES = {
    "platinum": 1.0,
    "gold": 0.8,
    "silver": 0.6,
    "bronze": 0.4,
    "borked": 0.0,
}
# scoreTiers thresholds: 80+ platinum, 60+ gold, 40+ silver, 20+ bronze, else borked.
# Match scoring-info.json's scoreTiers; pending used when there are no rated reports.
def _score_to_tier(score_pct: float) -> str:
    if score_pct >= 80: return "platinum"
    if score_pct >= 60: return "gold"
    if score_pct >= 40: return "silver"
    if score_pct >= 20: return "bronze"
    return "borked"


def _compute_game_summary(app_dir: Path) -> tuple[str, int, int]:
    """Walk a game's year files and return (overall_tier, protondb_count, pulse_count).

    Tier is the average of per-report rating scores mapped through scoreTiers --
    same algorithm the scoring page documents. Pending if no rated reports.
    """
    total_score = 0.0
    rated_count = 0
    protondb_count = 0
    pulse_count = 0
    if not app_dir.is_dir():
        return ("pending", 0, 0)
    for year_file in app_dir.glob("*.json"):
        stem = year_file.stem
        if stem in ("index", "latest", "votes", "metadata"):
            continue
        try:
            reports = json.loads(year_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(reports, list):
            continue
        for r in reports:
            if not isinstance(r, dict):
                continue
            source = (r.get("source") or "protondb").lower()
            if source == "pulse":
                pulse_count += 1
            else:
                protondb_count += 1
            rating = (r.get("rating") or "").lower()
            if rating in _RATING_SCORES:
                total_score += _RATING_SCORES[rating]
                rated_count += 1
    if rated_count == 0:
        return ("pending", protondb_count, pulse_count)
    score_pct = (total_score / rated_count) * 100
    return (_score_to_tier(score_pct), protondb_count, pulse_count)


def generate_recent_reports(data_output_path: Path, output_path: Path, limit: int = 100) -> None:
    """Generate recent-reports.json: top games sorted by most recent report timestamp.

    Shape: [{appId, title, tier, lastReportDate, protondbCount, pulseCount}, ...]
    Reads every game directory, finds the latest report timestamp from year bucket files,
    sorts descending, and emits the top `limit` entries.
    """
    from datetime import datetime, timezone

    search_index_path = output_path / "search-index.json"
    index: dict[str, list] = {}
    if search_index_path.exists():
        for row in json.loads(search_index_path.read_text(encoding="utf-8")):
            if isinstance(row, list) and len(row) >= 3:
                index[str(row[0])] = row

    results = []
    for app_dir in data_output_path.iterdir():
        if not app_dir.is_dir():
            continue
        app_id = dir_to_app_id(app_dir.name)
        year_files = sorted(
            (f for f in app_dir.glob("*.json") if f.stem not in {"latest", "index", "votes", "metadata"}),
            key=lambda p: p.stem,
        )
        if not year_files:
            continue
        try:
            rows = json.loads(year_files[-1].read_text(encoding="utf-8"))
            if not isinstance(rows, list):
                continue
            latest_ts = max((int(r.get("timestamp", 0)) for r in rows if r.get("timestamp")), default=0)
            if not latest_ts:
                continue
            last_date = datetime.fromtimestamp(latest_ts, tz=timezone.utc).strftime("%Y-%m-%d")
        except Exception:
            continue
        row = index.get(app_id, [])
        title = row[1] if len(row) > 1 else ""
        if not title:
            continue
        tier = row[2] if len(row) > 2 else ""
        pdb_count = row[3] if len(row) > 3 else 0
        pulse_count = row[4] if len(row) > 4 else 0
        results.append({
            "appId": app_id,
            "title": title,
            "tier": tier,
            "lastReportDate": last_date,
            "protondbCount": pdb_count,
            "pulseCount": pulse_count,
            "appType": app_type_from_id(app_id),
        })

    results.sort(key=lambda r: r["lastReportDate"], reverse=True)
    out_path = output_path / "recent-reports.json"
    out_path.write_text(json.dumps(results[:limit], separators=(",", ":")) + "\n", encoding="utf-8")
    log(f"[recent-reports] wrote {len(results[:limit])} entries to {out_path}")


def _backfill_most_played_header_images(output_path: Path, overrides: dict) -> None:
    """Populate headerImage in most_played.json from game-images.json overrides.

    most_played.py sets headerImage: None as a placeholder because it runs
    before game_images.py. This step fills them in after both have run.
    """
    mp_path = output_path / "most_played.json"
    if not mp_path.exists() or not overrides:
        return
    try:
        data = json.loads(mp_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[game-images] WARN: could not read most_played.json for header backfill: {exc}")
        return
    changed = 0
    for entry in data:
        app_id = str(entry.get("appId", ""))
        if app_id in overrides and not entry.get("headerImage"):
            entry["headerImage"] = overrides[app_id]
            changed += 1
    if changed:
        mp_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        log(f"[game-images] backfilled {changed} headerImage(s) in most_played.json")


def generate_search_index(
    index_keys: set,
    data_output_path: Path,
    output_path: Path,
    gog_catalog: dict[str, str] | None = None,
) -> None:
    """Generate search-index.json with overall tier + report counts per game.

    Shape: [[appId, title, tier, protondbCount, pulseCount, appType], ...]
    Older consumers reading only the first two columns continue to work --
    JS destructuring ignores extra elements silently.

    GOG games from gog_catalog that have no local report data are emitted as
    stub entries (tier="", counts=0) so users can search for them before
    anyone has submitted a Pulse report.
    """
    app_ids = sorted(
        {app_id for app_id, _ in index_keys},
        key=lambda a: (0, int(a)) if a.isdigit() else (1, a),
    )
    entries = []
    seen_ids: set[str] = set()

    for app_id in app_ids:
        app_dir = data_output_path / app_id_to_dir(app_id)
        title = _extract_title(app_dir)
        if not title:
            continue
        tier, pdb_count, pulse_count = _compute_game_summary(app_dir)
        entries.append([app_id, title, tier, pdb_count, pulse_count, app_type_from_id(app_id)])
        seen_ids.add(app_id)

    # Emit stubs for GOG catalog games not yet in the index so users can search
    # for them and submit their first report.
    if gog_catalog:
        stubs = 0
        for pid, title in sorted(gog_catalog.items(), key=lambda kv: kv[1].lower()):
            canonical_id = f"gog:{pid}"
            if canonical_id not in seen_ids:
                entries.append([canonical_id, title, "", 0, 0, "gog"])
                stubs += 1
        if stubs:
            log(f"[search-index] Added {stubs:,} GOG catalog stubs (no reports yet)")

    index_file = output_path / "search-index.json"
    index_file.write_text(json.dumps(entries, separators=(",", ":")))
    log(f"[search-index] Written {len(entries):,} entries to {index_file}")


def generate_coverage_report(
    index_keys: set,
    backfilled_keys: set,
    data_output_path: Path,
    output_path: Path,
    steam_catalog: dict[str, str] | None = None,
    protondb_signal_catalog: dict[str, str] | None = None,
    protondb_counts: dict | None = None,
) -> None:
    indexed_app_ids = {app_id for app_id, _ in index_keys}
    all_app_ids = set(indexed_app_ids)
    state_backfill_app_ids = {app_id for app_id, _ in backfilled_keys}
    protondb_signal_app_ids = set((protondb_signal_catalog or {}).keys())
    steam_catalog_app_ids = set((steam_catalog or {}).keys())
    steam_protondb_overlap = steam_catalog_app_ids & protondb_signal_app_ids

    if steam_catalog:
        all_app_ids.update(steam_catalog.keys())
    all_app_ids.update(protondb_signal_app_ids)
    all_app_ids.update(state_backfill_app_ids)

    log(f"[coverage] Indexed app IDs           : {len(indexed_app_ids):,}")
    log(f"[coverage] Backfill app IDs          : {len(state_backfill_app_ids):,}")
    log(f"[coverage] ProtonDB signal app IDs   : {len(protondb_signal_app_ids):,}")
    if steam_catalog:
        log(f"[coverage] Steam catalog app IDs     : {len(steam_catalog_app_ids):,}")
        log(f"[coverage] Steam ∩ ProtonDB signals  : {len(steam_protondb_overlap):,}")
    log(f"[coverage] Final coverage universe   : {len(all_app_ids):,}")

    rows = []
    for app_id in sorted(all_app_ids, key=lambda a: (0, int(a)) if a.isdigit() else (1, a)):
        metadata = read_app_metadata(data_output_path, app_id)
        official = metadata.get("official_dump", False)
        protondb_live = metadata.get("protondb_live", False) or app_id in state_backfill_app_ids
        if not metadata and app_id in indexed_app_ids and app_id not in state_backfill_app_ids:
            official = True

        title, title_source = _resolve_coverage_title(
            app_id,
            data_output_path,
            protondb_signal_catalog=protondb_signal_catalog,
            steam_catalog=steam_catalog,
        )
        rows.append((
            app_id,
            title,
            title_source,
            official,
            protondb_live,
            app_id in protondb_signal_app_ids,
            app_id in steam_catalog_app_ids,
            app_id in indexed_app_ids,
        ))

    now = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    official_count = sum(1 for row in rows if row[3])
    backfill_count = sum(1 for row in rows if row[4])
    indexed_count = len(indexed_app_ids)
    steam_count = len(steam_catalog_app_ids) if steam_catalog else 0
    protondb_unique_games = (protondb_counts or {}).get("uniqueGames", 0) if protondb_counts else 0
    protondb_total_reports = (protondb_counts or {}).get("reports", 0) if protondb_counts else 0
    pct_of_protondb_total = (indexed_count / protondb_unique_games * 100) if protondb_unique_games else 0
    pct_of_steam = (indexed_count / steam_count * 100) if steam_count else 0
    protondb_pct_of_steam = (protondb_unique_games / steam_count * 100) if (steam_count and protondb_unique_games) else 0

    # Build JS data array instead of HTML rows
    # Format:
    # [appId, title, titleSource, official, backfill, protondbSignal, steamCatalog, "flags", indexed]
    js_rows = []
    for app_id, title, title_source, official, backfill, protondb_signal, steam_catalog_hit, indexed in rows:
        flags = []
        if official:
            flags.append("official")
        if backfill:
            flags.append("backfill")
        if protondb_signal:
            flags.append("protondb-signal")
        if steam_catalog_hit:
            flags.append("steam-catalog")
        if not title:
            flags.append("missing-title")
        if not app_id.isdigit():
            flags.append("bad-appid")
        if not official and not backfill and not indexed:
            flags.append("no-data")
        # Escape for JS string
        safe_title = title.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
        safe_title_source = title_source.replace("\\", "\\\\").replace('"', '\\"')
        js_rows.append(
            f'["{app_id}","{safe_title}","{safe_title_source}",'
            f'{1 if official else 0},{1 if backfill else 0},{1 if protondb_signal else 0},'
            f'{1 if steam_catalog_hit else 0},"{" ".join(flags)}",{1 if indexed else 0}]'
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coverage Report - Proton Pulse</title>
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="site.css">
<style>
/* coverage page only - table + stats layout that lives below the shared topbar */
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid var(--border); padding: 6px 10px; text-align: left; }}
th {{ background: var(--s2); color: var(--text); cursor: pointer; user-select: none; position: relative; padding-right: 22px; transition: background .12s, color .12s; }}
th:hover {{ background: var(--s3); color: var(--accent-hi); }}
th::after {{ content: '\\2195'; position: absolute; right: 6px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 0.85em; opacity: 0.4; }}
th.sort-asc::after {{ content: '\\25B2'; color: var(--accent); opacity: 1; }}
th.sort-desc::after {{ content: '\\25BC'; color: var(--accent); opacity: 1; }}
tr:nth-child(even) {{ background: var(--s1); }}
tr:nth-child(odd) {{ background: rgba(0,0,0,0.1); }}
.yes {{ color: var(--green-hi); font-weight: bold; }}
.no {{ color: var(--muted); }}
.stats {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 1.5em; }}
@media (max-width: 1100px) {{ .stats {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }} }}
@media (max-width: 640px) {{ .stats {{ grid-template-columns: 1fr; }} }}
.stat-card {{ background: linear-gradient(180deg, rgba(27,40,56,0.55), rgba(11,17,22,0.45)); border: 1px solid var(--border); padding: 14px 18px; clip-path: polygon(0 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%); }}
.stat-card .label {{ font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }}
.stat-card .value {{ font-family: var(--mono); font-size: 1.7rem; font-weight: 600; color: var(--accent-hi); margin: 4px 0; text-shadow: 0 0 14px var(--accent-glow); }}
.stat-card .detail {{ font-size: 0.78rem; color: var(--muted); }}
.pct {{ color: var(--green-hi); }}
.filters {{ margin-bottom: 1em; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }}
#filter {{ padding: 8px 10px; width: 320px; background: rgba(11,17,22,0.6); color: var(--text); border: 1px solid var(--border2); }}
#filter:focus {{ border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }}
.toggle {{ padding: 6px 14px; border: 1px solid var(--border2); background: transparent; color: var(--muted); cursor: pointer; font-weight: 600; text-transform: uppercase; font-size: 0.78rem; letter-spacing: 0.04em; transition: color .12s, border-color .12s, background .12s; }}
.toggle:hover {{ color: var(--text); border-color: var(--accent); }}
.toggle.active {{ background: var(--accent-soft); color: var(--accent-hi); border-color: var(--accent); }}
.pager {{ margin: 1em 0; display: flex; gap: 8px; align-items: center; }}
.pager button {{ padding: 6px 14px; background: rgba(11,17,22,0.6); color: var(--text); border: 1px solid var(--border2); cursor: pointer; font-family: inherit; font-size: 0.82rem; }}
.pager button:hover {{ background: var(--s2); border-color: var(--accent); }}
.coverage-meta {{ color: var(--muted); margin-bottom: 1em; font-family: var(--mono); font-size: 0.8rem; letter-spacing: 0.04em; }}
</style>
</head>
<body>
<!-- shared topbar (banner + nav + drawer) injected by topbar.js -->
<script src="topbar.js"></script>
<div class="main-content"><div class="main-inner">
<h1 style="font-family:var(--font-display);text-transform:uppercase;letter-spacing:0.02em;margin-bottom:0.4em">Coverage Report</h1>
<p class="coverage-meta">// Generated: {now}</p>
<div class="stats">
<div class="stat-card">
  <div class="label">Steam Games</div>
  <div class="value">{steam_count:,}</div>
  <div class="detail">All game-type app IDs from Steam API</div>
</div>
<div class="stat-card">
  <div class="label">ProtonDB Total</div>
  <div class="value">{protondb_unique_games:,}</div>
  <div class="detail">{protondb_total_reports:,} reports &middot; <span class="pct">{protondb_pct_of_steam:.1f}%</span> of Steam</div>
</div>
<div class="stat-card">
  <div class="label">Indexed (with data)</div>
  <div class="value">{indexed_count:,}</div>
  <div class="detail"><span class="pct">{pct_of_protondb_total:.1f}%</span> of ProtonDB &middot; <span class="pct">{pct_of_steam:.1f}%</span> of Steam</div>
</div>
<div class="stat-card">
  <div class="label">Official ProtonDB Dump</div>
  <div class="value">{official_count:,}</div>
  <div class="detail">From bdefore/protondb-data archive</div>
</div>
<div class="stat-card">
  <div class="label">Live Backfill</div>
  <div class="value">{backfill_count:,}</div>
  <div class="detail">Live ProtonDB detailed reports</div>
</div>
<div class="stat-card">
  <div class="label">Coverage Universe</div>
  <div class="value">{len(rows):,}</div>
  <div class="detail">Total apps tracked in this report</div>
</div>
</div>
<div class="filters">
<input id="filter" placeholder="Filter by App ID or title\u2026" oninput="onFilter()">
<button class="toggle active" data-src="all" onclick="toggleSrc('all')">All</button>
<button class="toggle" data-src="official" onclick="toggleSrc('official')">Official dump only</button>
<button class="toggle" data-src="backfill" onclick="toggleSrc('backfill')">Live backfill only</button>
<button class="toggle" data-src="no-data" onclick="toggleSrc('no-data')">No data</button>
<button class="toggle" data-src="missing-title" onclick="toggleSrc('missing-title')">Missing title</button>
<button class="toggle" data-src="bad-appid" onclick="toggleSrc('bad-appid')">Bad App ID</button>
</div>
<div class="pager">
<button onclick="goPage(-1)">&larr; Prev</button>
<span id="pageInfo"></span>
<button onclick="goPage(1)">Next &rarr;</button>
</div>
<table id="coverage">
<thead><tr>
<th onclick="doSort(0)">App ID</th>
<th onclick="doSort(1)">Title (ProtonDB)</th>
<th onclick="doSort(2)">Title Source</th>
<th onclick="doSort(3)">Official ProtonDB Dump</th>
<th onclick="doSort(4)">Live Backfill</th>
<th onclick="doSort(5)">Seen on ProtonDB</th>
<th onclick="doSort(6)">Seen in Steam Catalog</th>
<th>Indexed</th>
</tr></thead>
<tbody id="tbody"></tbody>
</table>
<div class="pager">
<button onclick="goPage(-1)">&larr; Prev</button>
<span id="pageInfo2"></span>
<button onclick="goPage(1)">Next &rarr;</button>
</div>
<script>
const DATA=[
{",".join(js_rows)}
];
const PAGE=300;
let filtered=DATA.slice();
let page=0;
let activeSrc=new Set(["all"]);
let sortCol=-1,sortAsc=1;
let filterTimer=null;
const TITLE_SOURCE_LABELS={{
  "indexed-data":"Indexed",
  "protondb-signal":"Seen on ProtonDB",
  "steam-catalog":"Seen in Steam Catalog",
  "steam-store":"Steam Store",
  "steam-store-scrape":"Steam Store Scrape",
  "steam-store-empty-name":"Steam Store (empty name)",
  "steam-store-unsuccessful":"Steam Store (unsuccessful)",
  "steam-store-error":"Steam Store (error)",
  "none":"None"
}};

function getStateFromUrl(){{
  const params=new URLSearchParams(window.location.search);
  const q=params.get("q")||"";
  const srcParam=params.get("src")||"all";
  const srcValues=srcParam.split(",").map(s=>s.trim()).filter(Boolean);
  const src=new Set(srcValues.length?srcValues:["all"]);
  const sort=Number.parseInt(params.get("sort")||"-1",10);
  const dir=Number.parseInt(params.get("dir")||"1",10);
  const pageValue=Math.max(0,Number.parseInt(params.get("page")||"0",10)||0);
  return {{
    q,
    src: src.has("all")||src.size===0?new Set(["all"]):src,
    sort: Number.isNaN(sort)?-1:sort,
    dir: dir===-1?-1:1,
    page: pageValue
  }};
}}

function saveStateToUrl(){{
  const params=new URLSearchParams(window.location.search);
  const q=document.getElementById("filter").value.trim();
  const src=[...activeSrc].sort().join(",");
  if(q)params.set("q",q);else params.delete("q");
  if(src&&src!=="all")params.set("src",src);else params.delete("src");
  if(sortCol>=0)params.set("sort",String(sortCol));else params.delete("sort");
  if(sortAsc===-1)params.set("dir","-1");else params.delete("dir");
  if(page>0)params.set("page",String(page));else params.delete("page");
  const query=params.toString();
  const next=window.location.pathname+(query?`?${{query}}`:"");
  window.history.replaceState(null,"",next);
}}

function toggleSrc(s){{
  if(s==="all"){{activeSrc.clear();activeSrc.add("all")}}
  else{{activeSrc.delete("all");activeSrc.has(s)?activeSrc.delete(s):activeSrc.add(s);if(!activeSrc.size)activeSrc.add("all")}}
  document.querySelectorAll(".toggle").forEach(b=>b.classList.toggle("active",activeSrc.has(b.dataset.src)));
  apply();
}}
function onFilter(){{clearTimeout(filterTimer);filterTimer=setTimeout(()=>apply(),200)}}
function apply(resetPage=true){{
  const q=document.getElementById("filter").value.toLowerCase();
  const all=activeSrc.has("all");
  filtered=DATA.filter(r=>{{
    if(!all&&![...activeSrc].some(s=>r[7].split(" ").includes(s)))return false;
    if(q){{
      const queryIsNumeric=/^\\d+$/.test(q);
      const haystack=(r[0]+" "+r[1]).toLowerCase();
      if(queryIsNumeric){{
        if(r[0]!==q)return false;
      }} else if(!haystack.includes(q)) return false;
    }}
    return true;
  }});
  if(sortCol>=0)doSortFiltered();
  if(resetPage) page=0;
  render();
}}
function doSort(c){{
  if(sortCol===c)sortAsc*=-1;else{{sortCol=c;sortAsc=1}}
  updateSortIndicator();
  doSortFiltered();page=0;render();
}}
function updateSortIndicator(){{
  document.querySelectorAll('th').forEach((th,i)=>{{
    th.classList.remove('sort-asc','sort-desc');
    if(i===sortCol)th.classList.add(sortAsc>0?'sort-asc':'sort-desc');
  }});
}}
function doSortFiltered(){{
  const c=sortCol,d=sortAsc;
  filtered.sort((a,b)=>{{
    if(c===0)return d*(parseInt(a[0]||"0")-parseInt(b[0]||"0"));
    if(c>=3&&c<=6)return d*(b[c]-a[c]);
    return d*String(a[c]).localeCompare(String(b[c]));
  }});
}}
function goPage(d){{
  const max=Math.max(0,Math.ceil(filtered.length/PAGE)-1);
  page=Math.max(0,Math.min(max,page+d));render();
}}
function render(){{
  const tb=document.getElementById("tbody");
  const start=page*PAGE,slice=filtered.slice(start,start+PAGE);
  const total=filtered.length,pages=Math.ceil(total/PAGE)||1;
  const maxPage=Math.max(0,pages-1);
  if(page>maxPage) page=maxPage;
  const safeStart=page*PAGE;
  const safeSlice=filtered.slice(safeStart,safeStart+PAGE);
  const info=total===0?`0\u20130 of 0 (1/1)`:`${{safeStart+1}}\u2013${{Math.min(safeStart+PAGE,total)}} of ${{total}} (${{page+1}}/${{pages}})`;
  document.getElementById("pageInfo").textContent=info;
  document.getElementById("pageInfo2").textContent=info;
  const h=[];
  for(const r of safeSlice){{
    const id=r[0],t=r[1],ts=r[2],o=r[3],b=r[4],ps=r[5],sc=r[6],ix=r[8];
    const isNum=id.length>0&&[...id].every(c=>c>='0'&&c<='9');
    const ac=isNum?`<a href="https://store.steampowered.com/app/${{id}}">${{id}}</a>`:id;
    const tc=isNum&&t?`<a href="https://www.protondb.com/app/${{id}}">${{t}}</a>`:(t||"");
    const oc=o?'<span class="yes">yes</span>':'<span class="no">no</span>';
    const bc=b?'<span class="yes">yes</span>':'<span class="no">no</span>';
    const psc=ps?'<span class="yes">yes</span>':'<span class="no">no</span>';
    const scc=sc?'<span class="yes">yes</span>':'<span class="no">no</span>';
    const tsc=TITLE_SOURCE_LABELS[ts]||ts.replace(/-/g,' ');
    const ixc=ix?`<a href="data/${{id}}/">index</a>`:'<span class="no">\u2014</span>';
    h.push(`<tr><td>${{ac}}</td><td>${{tc}}</td><td>${{tsc}}</td><td>${{oc}}</td><td>${{bc}}</td><td>${{psc}}</td><td>${{scc}}</td><td>${{ixc}}</td></tr>`);
  }}
  tb.innerHTML=h.join("");
  saveStateToUrl();
}}
const initialState=getStateFromUrl();
document.getElementById("filter").value=initialState.q;
activeSrc=initialState.src;
sortCol=initialState.sort;
sortAsc=initialState.dir;
page=initialState.page;
document.querySelectorAll(".toggle").forEach(b=>b.classList.toggle("active",activeSrc.has(b.dataset.src)));
apply(false);
updateSortIndicator();
</script>
</div></div>
</body></html>
"""
    report_file = output_path / "coverage.html"
    report_file.write_text(html)
    log(f"[coverage] Written: {report_file}")

    # Emit a tiny coverage-summary.json next to coverage.html so the homepage
    # (and any other consumer) can grab the headline numbers without parsing
    # 100KB of HTML. Keep this lean - only stats the landing page actually uses.
    # See proton-pulse-web/js/index/main.js: loadCoverageStats()
    summary = {
        "generated_at": now,
        "steam_games":      steam_count,
        "protondb_games":   protondb_unique_games,
        "protondb_reports": protondb_total_reports,
        "indexed":          indexed_count,
        "official":         official_count,
        "backfill":         backfill_count,
        "pct_of_steam":            round(pct_of_steam, 2),
        "pct_of_protondb":         round(pct_of_protondb_total, 2),
        "protondb_pct_of_steam":   round(protondb_pct_of_steam, 2),
    }
    summary_file = output_path / "coverage-summary.json"
    summary_file.write_text(json.dumps(summary, indent=2) + "\n")
    log(f"[coverage] Written: {summary_file}")


def probe_cache_to_catalog(probe_cache: dict[str, dict]) -> dict[str, str]:
    return {
        str(app_id): str(entry.get("title", "")).strip()
        for app_id, entry in probe_cache.items()
        if isinstance(entry, dict) and entry.get("tracked")
    }


def compute_probe_candidates(output_dir: str) -> tuple[list[str], int]:
    output_path = Path(output_dir)
    state = read_pipeline_state(output_path)
    steam_api_key = get_steam_api_key(os.environ)
    if not steam_api_key:
        return [], 0

    probe_cache_max_age = get_protondb_probe_cache_max_age_seconds(os.environ)
    probe_cache = read_protondb_probe_cache(max_age_seconds=probe_cache_max_age)

    protondb_signal_catalog = None
    try:
        protondb_signal_catalog = load_protondb_signal_catalog()
    except Exception as exc:
        log(f"[protondb-signal] Failed to load ProtonDB signal catalog: {exc}")

    steam_catalog = load_steam_game_catalog(steam_api_key)
    indexed_app_ids = {app_id for app_id, _ in state["index_keys"]}
    backfill_app_ids = {app_id for app_id, _ in state["backfilled_keys"]}
    protondb_known_ids = set((protondb_signal_catalog or {}).keys())
    probe_candidates = sorted(
        (set(steam_catalog.keys()) - protondb_known_ids - indexed_app_ids - backfill_app_ids),
        key=lambda app_id: int(app_id),
    )
    cached_candidate_count = len(set(probe_candidates) & set(probe_cache.keys()))
    return probe_candidates, cached_candidate_count


def build_probe_chunk_plan(output_dir: str) -> dict[str, object]:
    probe_candidates, cached_count = compute_probe_candidates(output_dir)
    probe_limit = get_protondb_probe_limit(os.environ)
    uncached_count = max(0, len(probe_candidates) - cached_count)

    if probe_limit <= 0:
        chunk_count = 1 if uncached_count > 0 else 0
    else:
        chunk_count = math.ceil(uncached_count / probe_limit)

    chunks = [f"{index:02d}" for index in range(1, chunk_count + 1)]
    plan = {
        "candidate_count": len(probe_candidates),
        "cached_count": cached_count,
        "uncached_count": uncached_count,
        "probe_limit": probe_limit,
        "chunk_count": chunk_count,
        "chunks": chunks,
    }
    return plan


def update_protondb_probe_cache(output_dir: str) -> dict[str, str]:
    protondb_signal_catalog = None
    steam_api_key = get_steam_api_key(os.environ)
    protondb_probe_limit = get_protondb_probe_limit(os.environ)
    protondb_probe_log_every = get_protondb_probe_log_every(os.environ)
    probe_cache_max_age = get_protondb_probe_cache_max_age_seconds(os.environ)
    probe_cache = read_protondb_probe_cache(max_age_seconds=probe_cache_max_age)
    protondb_probe_catalog = probe_cache_to_catalog(probe_cache)

    if steam_api_key:
        log("[steam-catalog] STEAM_API_KEY detected; Steam catalog expansion enabled")
    else:
        log("[steam-catalog] STEAM_API_KEY not found; Steam catalog expansion disabled")
        return protondb_probe_catalog

    try:
        protondb_signal_catalog = load_protondb_signal_catalog()
    except Exception as exc:
        log(f"[protondb-signal] Failed to load ProtonDB signal catalog: {exc}")

    try:
        probe_candidates, cached_count = compute_probe_candidates(output_dir)
        log(
            f"[protondb-probe] Candidate Steam app IDs before cache/filter: {len(probe_candidates):,}"
        )
        log(
            f"[protondb-probe] Cached app IDs already checked         : {cached_count:,}"
        )
        log(
            f"[protondb-probe] Per-run uncached probe limit           : {protondb_probe_limit:,}"
        )
        log(
            f"[protondb-probe] Progress log cadence                : every {protondb_probe_log_every:,} apps"
        )
        probe_cache, protondb_probe_catalog = probe_protondb_app_ids(
            probe_candidates,
            existing_cache=probe_cache,
            limit=protondb_probe_limit,
            log_every=protondb_probe_log_every,
            cache_path=DEFAULT_PROTONDB_PROBE_CACHE_PATH,
            flush_every=protondb_probe_log_every,
        )
        write_protondb_probe_cache(probe_cache)
        log(
            f"[protondb-probe] Cached probe results updated at {DEFAULT_PROTONDB_PROBE_CACHE_PATH}",
        )
    except Exception as exc:
        log(f"[protondb-probe] Failed to probe ProtonDB summaries: {exc}")

    return protondb_probe_catalog


_SB_URL_DEFAULT = "https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1"
_SB_ANON_KEY_DEFAULT = "sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V"


def write_proton_versions_json(output_path: Path) -> None:
    """Fetch distinct proton_version values from Supabase user_configs and write
    proton-versions.json as a sorted JSON array of strings. Silently no-ops on
    any error so a Supabase outage never fails the overall pipeline."""
    url = os.environ.get("SUPABASE_URL", _SB_URL_DEFAULT).rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", _SB_ANON_KEY_DEFAULT)
    endpoint = (
        f"{url}/user_configs"
        "?select=proton_version"
        "&proton_version=not.is.null"
        "&order=proton_version"
    )
    req = urllib.request.Request(
        endpoint,
        headers={"apikey": key, "Accept": "application/json", "Range": "0-4999"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as exc:
        log(f"[proton-versions] WARNING: failed to fetch proton_version values: {exc}")
        return

    if not isinstance(payload, list):
        log(f"[proton-versions] WARNING: unexpected payload shape: {type(payload).__name__}")
        return

    versions = sorted(
        {row["proton_version"].strip() for row in payload if row.get("proton_version", "").strip()}
    )
    out_file = output_path / "proton-versions.json"
    out_file.write_text(json.dumps(versions, indent=2))
    log(f"[proton-versions] Written {len(versions)} unique versions")


def finalize_output(output_dir, skip_probe: bool = False):
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    state = read_pipeline_state(output_path)
    pipeline_start = time.time()
    steam_catalog = None
    protondb_signal_catalog = None
    protondb_probe_catalog = None
    steam_api_key = get_steam_api_key(os.environ)
    probe_cache_max_age = get_protondb_probe_cache_max_age_seconds(os.environ)

    if skip_probe:
        log("[protondb-probe] Skipping active probe pass; using cached probe results only")
    protondb_probe_catalog = (
        probe_cache_to_catalog(read_protondb_probe_cache(max_age_seconds=probe_cache_max_age))
        if skip_probe
        else update_protondb_probe_cache(output_dir)
    )

    try:
        protondb_signal_catalog = load_protondb_signal_catalog()
    except Exception as exc:
        log(f"[protondb-signal] Failed to load ProtonDB signal catalog: {exc}")

    if steam_api_key:
        try:
            steam_catalog = load_steam_game_catalog(steam_api_key)
        except Exception as exc:
            log(f"[steam-catalog] Failed to load Steam app catalog: {exc}")
    else:
        log("[steam-catalog] STEAM_API_KEY not set; coverage report will use local output only", debug=True)

    gog_catalog: dict[str, str] | None = None
    try:
        gog_catalog = load_gog_catalog()
    except Exception as exc:
        log(f"[gog-catalog] Failed to load GOG catalog: {exc}")
    protondb_counts = None
    try:
        protondb_counts = fetch_json(LIVE_COUNTS_URL)
        if isinstance(protondb_counts, dict):
            unique = protondb_counts.get("uniqueGames")
            reports = protondb_counts.get("reports")
            log(f"[protondb-counts] uniqueGames={unique:,}, reports={reports:,}" if isinstance(unique, int) and isinstance(reports, int) else f"[protondb-counts] payload={protondb_counts}")
        else:
            log("[protondb-counts] Unexpected payload shape; skipping counts integration")
            protondb_counts = None
    except Exception as exc:
        log(f"[protondb-counts] Failed to fetch counts.json: {exc}")

    generate_latest_files(data_output_path)
    # merge Pulse Reports (Supabase user_configs) into year.json files alongside
    # ProtonDB data. runs before app-indexes so latest/index files pick up the
    # new pulse records too. silently no-ops if Supabase is unreachable
    merge_pulse_into_data_dir(data_output_path)
    bootstrapped_metadata = bootstrap_all_app_metadata(
        data_output_path,
        backfilled_app_ids={app_id for app_id, _ in state["backfilled_keys"]},
    )
    if bootstrapped_metadata:
        official_bootstrapped = sum(1 for meta in bootstrapped_metadata.values() if meta.get("official_dump"))
        live_bootstrapped = sum(1 for meta in bootstrapped_metadata.values() if meta.get("protondb_live"))
        log(
            f"[metadata] Bootstrapped app provenance for {len(bootstrapped_metadata):,} app(s): "
            f"{official_bootstrapped:,} official, {live_bootstrapped:,} live"
        )
    # Rebuild index_keys from disk so generators see the FULL post-merge set
    # (artifact + gh-pages historical apps), not just this run's processed
    # delta. Without this, a scheduled run that touched 1 new app produces
    # a data-index.html with 1 entry. See derive_index_keys_from_disk doc.
    disk_index_keys = derive_index_keys_from_disk(data_output_path)
    full_index_keys = set(state["index_keys"]) | disk_index_keys
    state_app_count = len({k[0] for k in state["index_keys"]})
    disk_app_count = len({k[0] for k in disk_index_keys})
    log(
        f"[finalize] index_keys: {state_app_count:,} from state, "
        f"{disk_app_count:,} from disk, "
        f"{len({k[0] for k in full_index_keys}):,} merged"
    )

    generate_app_indexes(full_index_keys, data_output_path)
    generate_index_html(full_index_keys, output_path)
    generate_search_index(full_index_keys, data_output_path, output_path, gog_catalog=gog_catalog)
    generate_coverage_report(
        full_index_keys,
        state["backfilled_keys"],
        data_output_path,
        output_path,
        steam_catalog=steam_catalog,
        protondb_signal_catalog={
            **(protondb_signal_catalog or {}),
            **(protondb_probe_catalog or {}),
        },
        protondb_counts=protondb_counts,
    )
    # Walk the data tree (post pulse merge) and emit stats.json that powers the
    # /stats.html page. Tiny output regardless of dataset size since everything
    # is pre-aggregated. See scripts/pipeline/stats.py
    write_stats_json(data_output_path, output_path)
    generate_recent_reports(data_output_path, output_path)
    build_most_played(output_path)
    overrides = build_game_images(output_path)
    _backfill_most_played_header_images(output_path, overrides)
    write_proton_versions_json(output_path)
    log_summary(state["parsed_count"], data_output_path, output_path, pipeline_start, state["backfilled_keys"])
    flush_steam_title_cache()
    log("Done finalizing output.")
