import json
import math
import os
import time
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
from .common import LIVE_COUNTS_URL, count_year_bucket_files, fetch_json, flush_steam_title_cache, log
from .metadata import bootstrap_all_app_metadata, read_app_metadata
from .state import read_pipeline_state


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
        app_dir = data_path / app_id
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
        app_dir = data_output_path / app_id
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
            f"<title>{display_name} - proton-pulse-data</title>"
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
        title = _extract_title(data_path / app_id)
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

    lines = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="utf-8">',
        '  <meta name="color-scheme" content="light dark">',
        "  <title>proton-pulse-data index</title>",
        "  <style>",
        "    :root {",
        "      color-scheme: light dark;",
        "      --bg: #f5f7fb;",
        "      --panel: #ffffff;",
        "      --text: #172033;",
        "      --muted: #5c677d;",
        "      --link: #0f62fe;",
        "      --border: #d9e0ee;",
        "      --shadow: rgba(0, 0, 0, 0.08);",
        "      --details-bg: #eef1f6;",
        "    }",
        "    @media (prefers-color-scheme: dark) {",
        "      :root {",
        "        --bg: #1a1a2e;",
        "        --panel: #16213e;",
        "        --text: #e0e0e0;",
        "        --muted: #7a9bb5;",
        "        --link: #5dade2;",
        "        --border: #333;",
        "        --shadow: rgba(0, 0, 0, 0.3);",
        "        --details-bg: #1a2744;",
        "      }",
        "    }",
        "    * { box-sizing: border-box; }",
        "    body {",
        "      margin: 0;",
        "      padding: 2rem;",
        "      background: var(--bg);",
        "      color: var(--text);",
        "      font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;",
        "    }",
        "    main {",
        "      max-width: 72rem;",
        "      margin: 0 auto;",
        "      padding: 1.5rem;",
        "      background: var(--panel);",
        "      border: 1px solid var(--border);",
        "      border-radius: 18px;",
        "      box-shadow: 0 18px 44px var(--shadow);",
        "    }",
        "    h1, h2 { line-height: 1.15; }",
        "    a { color: var(--link); }",
        "    p { color: var(--muted); }",
        "    ul { padding-left: 1.25rem; }",
        "    details {",
        "      padding: 0.45rem 0.7rem;",
        "      background: var(--details-bg);",
        "      border: 1px solid var(--border);",
        "      border-radius: 12px;",
        "    }",
        "    details + details, li + li { margin-top: 0.5rem; }",
        "    summary { cursor: pointer; font-weight: 600; }",
        "    .filter-row { margin: 1rem 0 1.25rem; }",
        "    #index-filter {",
        "      width: min(100%, 32rem);",
        "      padding: 0.75rem 0.9rem;",
        "      border-radius: 12px;",
        "      border: 1px solid var(--border);",
        "      background: var(--details-bg);",
        "      color: var(--text);",
        "      font: inherit;",
        "    }",
        "    #index-filter-help { margin-top: 0.5rem; font-size: 0.95rem; }",
        "    .is-hidden { display: none; }",
        "    @media (max-width: 640px) {",
        "      body { padding: 1rem; }",
        "      main { padding: 1rem; }",
        "    }",
        "  </style>",
        "</head>",
        "<body>",
        "<main>",
        "<h1>proton-pulse-data index</h1>",
        "<p>Monthly-updated ProtonDB per-game community reports. "
        f"<strong>{len(sorted_app_ids)}</strong> games tracked. "
        '<a href="index.html">Home</a> · '
        '<a href="app.html">Game Search</a> · '
        '<a href="coverage.html">Coverage Report</a></p>',
    ]

    if sample_entries:
        lines.append("<h2>Popular titles</h2>")
        lines.append("<p>" + " &middot; ".join(sample_entries) + "</p>")

    lines += [
        "<h2>All games (by app ID)</h2>",
        '<div class="filter-row">',
        '  <input id="index-filter" type="search" placeholder="Jump to an App ID or title…" autocomplete="off">',
        '  <p id="index-filter-help">Type to narrow the list. The filter is saved in the URL.</p>',
        "</div>",
        '<div class="pager">',
        '  <button id="index-prev" type="button">Previous</button>',
        '  <span id="index-page-info">Loading…</span>',
        '  <button id="index-next" type="button">Next</button>',
        "</div>",
        '<ul id="index-results"></ul>',
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
        f"<p>Generated: {now}</p>",
        "<script>",
        "const indexFilter=document.getElementById('index-filter');",
        "const indexFilterHelp=document.getElementById('index-filter-help');",
        "const indexResults=document.getElementById('index-results');",
        "const indexPrev=document.getElementById('index-prev');",
        "const indexNext=document.getElementById('index-next');",
        "const indexPageInfo=document.getElementById('index-page-info');",
        "const PAGE_SIZE=200;",
        "let filteredEntries=indexEntries;",
        "let currentPage=0;",
        "function readIndexFilter(){",
        "  const params=new URLSearchParams(window.location.search);",
        "  return params.get('q')||'';",
        "}",
        "function writeIndexFilter(value){",
        "  const params=new URLSearchParams(window.location.search);",
        "  if(value) params.set('q', value); else params.delete('q');",
        "  const query=params.toString();",
        "  const next=window.location.pathname+(query?`?${query}`:'');",
        "  window.history.replaceState(null,'',next);",
        "}",
        "function renderIndexPage(){",
        "  const totalPages=Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));",
        "  currentPage=Math.min(Math.max(0, currentPage), totalPages - 1);",
        "  const start=currentPage * PAGE_SIZE;",
        "  const slice=filteredEntries.slice(start, start + PAGE_SIZE);",
        "  indexResults.innerHTML=slice.map(([appId, title, display, years])=>{",
        "    const latestHref=`data/${appId}/latest.json`;",
        "    const yearRows=years.map((year)=>`<li><a href=\"data/${appId}/${year}.json\">${year}.json</a></li>`).join('');",
        "    return `<li><details><summary>${display}</summary><ul><li><a href=\"${latestHref}\"><strong>latest.json</strong></a></li>${yearRows}</ul></details></li>`;",
        "  }).join('');",
        "  indexPageInfo.textContent=filteredEntries.length",
        "    ? `Showing ${start + 1}–${Math.min(start + slice.length, filteredEntries.length)} of ${filteredEntries.length}`",
        "    : 'No matching apps';",
        "  indexPrev.disabled=currentPage===0;",
        "  indexNext.disabled=currentPage>=totalPages - 1 || filteredEntries.length===0;",
        "}",
        "function applyIndexFilter(){",
        "  const raw=indexFilter.value.trim();",
        "  const query=raw.toLowerCase();",
        "  filteredEntries=!query",
        "    ? indexEntries",
        "    : indexEntries.filter(([appId, title, display])=>{",
        "        const haystack=`${appId} ${title} ${display}`.toLowerCase();",
        "        return haystack.includes(query);",
        "      });",
        "  currentPage=0;",
        "  indexFilterHelp.textContent=query",
        "    ? `${filteredEntries.length} matching app${filteredEntries.length===1?'':'s'}`",
        "    : 'Type to narrow the list. The filter is saved in the URL.';",
        "  writeIndexFilter(raw);",
        "  renderIndexPage();",
        "}",
        "indexFilter.value=readIndexFilter();",
        "indexFilter.addEventListener('input', applyIndexFilter);",
        "indexPrev.addEventListener('click', ()=>{ if(currentPage>0){ currentPage-=1; renderIndexPage(); } });",
        "indexNext.addEventListener('click', ()=>{ const totalPages=Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE)); if(currentPage<totalPages-1){ currentPage+=1; renderIndexPage(); } });",
        "applyIndexFilter();",
        "</script>",
        "</main>",
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
    local_title = _extract_title(data_output_path / app_id)
    if local_title:
        return local_title, "indexed-data"

    signal_title = (protondb_signal_catalog or {}).get(app_id, "")
    if signal_title:
        return signal_title, "protondb-signal"

    steam_title = (steam_catalog or {}).get(app_id, "")
    if steam_title:
        return steam_title, "steam-catalog"

    return "", "none"


def generate_search_index(index_keys: set, data_output_path: Path, output_path: Path) -> None:
    """Generate search-index.json: compact [[appId, title], ...] list for client-side search."""
    app_ids = sorted(
        {app_id for app_id, _ in index_keys},
        key=lambda a: (0, int(a)) if a.isdigit() else (1, a),
    )
    entries = []
    for app_id in app_ids:
        title = _extract_title(data_output_path / app_id)
        if title:
            entries.append([app_id, title])
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
<title>proton-pulse-data coverage report</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 2em; background: #1a1a2e; color: #e0e0e0; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #333; padding: 6px 10px; text-align: left; }}
th {{ background: #16213e; color: #e0e0e0; cursor: pointer; user-select: none; }}
th:hover {{ background: #1a3a5c; }}
tr:nth-child(even) {{ background: #16213e; }}
tr:nth-child(odd) {{ background: #1a1a2e; }}
.yes {{ color: #4caf50; font-weight: bold; }}
.no {{ color: #666; }}
a {{ color: #5dade2; }}
.stats {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 1.5em; }}
.stat-card {{ background: #16213e; border: 1px solid #333; border-radius: 8px; padding: 14px 18px; }}
.stat-card .label {{ font-size: 0.8em; color: #7a9bb5; text-transform: uppercase; letter-spacing: 0.05em; }}
.stat-card .value {{ font-size: 1.6em; font-weight: bold; color: #5dade2; margin: 4px 0; }}
.stat-card .detail {{ font-size: 0.8em; color: #999; }}
.pct {{ color: #4caf50; }}
.filters {{ margin-bottom: 1em; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }}
#filter {{ padding: 6px; width: 300px; background: #16213e; color: #e0e0e0; border: 1px solid #333; border-radius: 4px; }}
.toggle {{ padding: 6px 14px; border: 2px solid #5dade2; border-radius: 4px; background: transparent; color: #5dade2; cursor: pointer; font-weight: bold; }}
.toggle.active {{ background: #5dade2; color: #1a1a2e; }}
.pager {{ margin: 1em 0; display: flex; gap: 8px; align-items: center; }}
.pager button {{ padding: 4px 12px; background: #16213e; color: #e0e0e0; border: 1px solid #333; border-radius: 4px; cursor: pointer; }}
.pager button:hover {{ background: #1a3a5c; }}
</style>
</head>
<body>
<h1>Coverage Report</h1>
<p style="color:#7a9bb5;margin-bottom:1em;">Generated: {now}</p>
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
  doSortFiltered();page=0;render();
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
</script>
</body></html>
"""
    report_file = output_path / "coverage.html"
    report_file.write_text(html)
    log(f"[coverage] Written: {report_file}")


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
    generate_app_indexes(state["index_keys"], data_output_path)
    generate_index_html(state["index_keys"], output_path)
    generate_search_index(state["index_keys"], data_output_path, output_path)
    generate_coverage_report(
        state["index_keys"],
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
    log_summary(state["parsed_count"], data_output_path, output_path, pipeline_start, state["backfilled_keys"])
    flush_steam_title_cache()
    log("Done finalizing output.")
