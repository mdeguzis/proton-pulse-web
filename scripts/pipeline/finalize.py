import json
import time
from datetime import datetime, timezone
from pathlib import Path

from .common import count_year_bucket_files, log
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
    log(f"[summary] Main index file         : {(output_path / 'index.html').resolve()}")
    log(f"[summary] Total time              : {total_elapsed:.1f}s")
    log(f"[summary] Output dir              : {data_output_path.resolve()}")


def generate_latest_files(data_output_path: Path) -> None:
    count = 0
    for app_dir in data_output_path.iterdir():
        if not app_dir.is_dir():
            continue
        year_files = sorted(app_dir.glob("*.json"), key=lambda p: p.stem)
        year_files = [f for f in year_files if f.stem != "latest"]
        if not year_files:
            continue
        latest_src = year_files[-1]
        latest_dst = app_dir / "latest.json"
        latest_dst.write_bytes(latest_src.read_bytes())
        count += 1
    log(f"[latest] Generated {count} latest.json files", debug=True)


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
        log(f"[app-index] {app_id}/index.json -> {sorted_years}")


def generate_index_html(index_keys: set, output_path: Path) -> None:
    app_years: dict[str, list[str]] = {}
    for (app_id, year) in index_keys:
        app_years.setdefault(app_id, []).append(year)

    sorted_app_ids = sorted(app_years.keys(), key=lambda a: (0, int(a)) if a.isdigit() else (1, a))
    for app_id in sorted_app_ids:
        app_years[app_id] = sorted(app_years[app_id], key=lambda y: (0, int(y)) if y.isdigit() else (1, y))

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
        "  <title>proton-pulse-data index</title>",
        "</head>",
        "<body>",
        "<h1>proton-pulse-data index</h1>",
        "<p>Monthly-updated ProtonDB per-game community reports. "
        f"<strong>{len(sorted_app_ids)}</strong> games tracked. "
        '<a href="coverage.html">Coverage Report</a></p>',
    ]

    if sample_entries:
        lines.append("<h2>Popular titles</h2>")
        lines.append("<p>" + " &middot; ".join(sample_entries) + "</p>")

    lines += [
        "<h2>All games (by app ID)</h2>",
        "<ul>",
    ]

    for app_id in sorted_app_ids:
        lines.append("  <li>")
        lines.append("    <details>")
        lines.append(f"      <summary>{app_id}/</summary>")
        lines.append("      <ul>")
        latest_href = f"data/{app_id}/latest.json"
        lines.append(f'        <li><a href="{latest_href}"><strong>latest.json</strong></a></li>')
        for year in app_years[app_id]:
            href = f"data/{app_id}/{year}.json"
            lines.append(f'        <li><a href="{href}">{year}.json</a></li>')
        lines.append("      </ul>")
        lines.append("    </details>")
        lines.append("  </li>")

    now = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines += [
        "</ul>",
        f"<p>Generated: {now}</p>",
        "</body>",
        "</html>",
    ]

    index_file = output_path / "index.html"
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


def generate_coverage_report(index_keys: set, backfilled_keys: set, data_output_path: Path, output_path: Path) -> None:
    all_app_ids = {app_id for app_id, _ in index_keys}
    backfill_app_ids = {app_id for app_id, _ in backfilled_keys}
    official_app_ids = all_app_ids - backfill_app_ids

    rows = []
    for app_id in sorted(all_app_ids, key=lambda a: (0, int(a)) if a.isdigit() else (1, a)):
        title = _extract_title(data_output_path / app_id)
        rows.append((
            app_id,
            title,
            app_id in official_app_ids,
            app_id in backfill_app_ids,
        ))

    now = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    official_count = sum(1 for _, _, o, _ in rows if o)
    backfill_count = sum(1 for _, _, _, b in rows if b)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>proton-pulse-data coverage report</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 2em; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #ccc; padding: 6px 10px; text-align: left; }}
th {{ background: #335; color: #fff; cursor: pointer; user-select: none; }}
th:hover {{ background: #557; }}
tr:nth-child(even) {{ background: #f4f4f4; }}
.yes {{ color: green; font-weight: bold; }}
.no {{ color: #999; }}
a {{ color: #06c; }}
.filters {{ margin-bottom: 1em; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }}
#filter {{ padding: 6px; width: 300px; }}
.toggle {{ padding: 6px 14px; border: 2px solid #335; border-radius: 4px; background: #fff; color: #335; cursor: pointer; font-weight: bold; }}
.toggle.active {{ background: #335; color: #fff; }}
</style>
</head>
<body>
<h1>Coverage Report</h1>
<p>{len(rows)} apps &middot; {official_count} official &middot; {backfill_count} backfill &middot; Generated: {now}</p>
<div class="filters">
<input id="filter" placeholder="Filter by App ID or title\u2026" oninput="applyFilters()">
<button class="toggle active" data-src="all" onclick="toggleSrc('all')">All</button>
<button class="toggle" data-src="official" onclick="toggleSrc('official')">Official only</button>
<button class="toggle" data-src="backfill" onclick="toggleSrc('backfill')">Backfill only</button>
<button class="toggle" data-src="missing-title" onclick="toggleSrc('missing-title')">Missing title</button>
<button class="toggle" data-src="bad-appid" onclick="toggleSrc('bad-appid')">Bad App ID</button>
</div>
<table id="coverage">
<thead><tr>
<th onclick="sortTable(0)">App ID</th>
<th onclick="sortTable(1)">Title</th>
<th onclick="sortTable(2)">Official</th>
<th onclick="sortTable(3)">Backfill</th>
<th>Latest</th>
</tr></thead>
<tbody>
"""
    for app_id, title, official, backfill in rows:
        o = '<span class="yes">yes</span>' if official else '<span class="no">no</span>'
        b = '<span class="yes">yes</span>' if backfill else '<span class="no">no</span>'
        link = f'data/{app_id}/latest.json'
        flags = []
        if official:
            flags.append("official")
        if backfill:
            flags.append("backfill")
        if not title:
            flags.append("missing-title")
        if not app_id.isdigit():
            flags.append("bad-appid")
        html += f'<tr data-src="{" ".join(flags)}">'
        steam_url = f"https://store.steampowered.com/app/{app_id}" if app_id.isdigit() else ""
        protondb_url = f"https://www.protondb.com/app/{app_id}" if app_id.isdigit() else ""
        app_cell = f'<a href="{steam_url}">{app_id}</a>' if steam_url else app_id
        title_cell = f'<a href="{protondb_url}">{title}</a>' if protondb_url and title else (title or "")
        html += f'<td>{app_cell}</td><td>{title_cell}</td><td>{o}</td><td>{b}</td>'
        html += f'<td><a href="{link}">latest.json</a></td></tr>\n'

    html += """</tbody></table>
<script>
let activeSrc = new Set(["all"]);
let sortDir = [1,1,1,1];

function toggleSrc(src) {
  if (src === "all") {
    activeSrc.clear();
    activeSrc.add("all");
  } else {
    activeSrc.delete("all");
    if (activeSrc.has(src)) activeSrc.delete(src); else activeSrc.add(src);
    if (activeSrc.size === 0) activeSrc.add("all");
  }
  document.querySelectorAll(".toggle").forEach(b => b.classList.toggle("active", activeSrc.has(b.dataset.src)));
  applyFilters();
}

function applyFilters() {
  const q = document.getElementById("filter").value.toLowerCase();
  const all = activeSrc.has("all");
  document.querySelectorAll("#coverage tbody tr").forEach(r => {
    const src = r.dataset.src;
    const srcOk = all || [...activeSrc].some(s => src.includes(s));
    const textOk = !q || (r.cells[0].textContent + " " + r.cells[1].textContent).toLowerCase().includes(q);
    r.style.display = srcOk && textOk ? "" : "none";
  });
}

function sortTable(col) {
  const tb = document.querySelector("#coverage tbody");
  const rows = Array.from(tb.rows);
  sortDir[col] *= -1;
  rows.sort((a, b) => {
    let av = a.cells[col].textContent, bv = b.cells[col].textContent;
    if (col === 0) return sortDir[col] * (parseInt(av) - parseInt(bv));
    return sortDir[col] * av.localeCompare(bv);
  });
  rows.forEach(r => tb.appendChild(r));
}
</script>
</body></html>
"""
    report_file = output_path / "coverage.html"
    report_file.write_text(html)
    log(f"[coverage] Written: {report_file}")


def finalize_output(output_dir):
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    state = read_pipeline_state(output_path)
    pipeline_start = time.time()
    generate_latest_files(data_output_path)
    generate_app_indexes(state["index_keys"], data_output_path)
    generate_index_html(state["index_keys"], output_path)
    generate_coverage_report(state["index_keys"], state["backfilled_keys"], data_output_path, output_path)
    log_summary(state["parsed_count"], data_output_path, output_path, pipeline_start, state["backfilled_keys"])
    log("Done finalizing output.")
