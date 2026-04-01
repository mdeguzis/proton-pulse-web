import os
import sys
import json
import tarfile
import ijson
import argparse
import subprocess
import tempfile
import time
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

DEBUG = False


def log(msg, debug=False):
    """Flush-safe print for CI environments. Skipped if debug=True and DEBUG is off."""
    if debug and not DEBUG:
        return
    print(msg, flush=True)


def clone_repo(url, target_dir):
    log(f"[clone] Cloning {url} -> {target_dir}", debug=True)
    result = subprocess.run(
        ["git", "clone", "--depth=1", url, target_dir],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        log(f"!! git clone failed:\n{result.stderr}")
        sys.exit(1)
    log(f"[clone] Clone complete.", debug=True)


def process_data(input_dir, output_dir):
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    data_output_path.mkdir(parents=True, exist_ok=True)

    log(f"[init] Input dir : {input_path.resolve()}", debug=True)
    log(f"[init] Output dir: {data_output_path.resolve()}", debug=True)

    if not input_path.exists():
        log(f"!! ERROR: Input directory does not exist: {input_path}")
        sys.exit(1)

    all_files = list(input_path.iterdir())
    log(f"[init] Files found in input dir: {len(all_files)}", debug=True)
    for f in sorted(all_files)[:20]:
        size = f.stat().st_size if f.is_file() else 0
        log(f"  {f.name}  ({size:,} bytes)", debug=True)
    if len(all_files) > 20:
        log(f"  ... and {len(all_files) - 20} more", debug=True)

    parsed_count = 0
    index_keys: set[tuple] = set()
    pipeline_start = time.time()

    # 1. Handle Raw JSON files
    json_files = sorted(input_path.glob("*.json"))
    log(f"\n[json] Found {len(json_files)} raw JSON file(s)", debug=True)
    for json_file in json_files:
        size = json_file.stat().st_size
        log(f"[json] Parsing: {json_file.name} ({size:,} bytes)", debug=True)
        t0 = time.time()
        with open(json_file, 'r') as f:
            count, src_keys = parse_and_split(f, data_output_path, source_label=json_file.name)
        elapsed = time.time() - t0
        log(f"[json] Done: {count:,} reports in {elapsed:.1f}s", debug=True)
        parsed_count += count
        index_keys.update(src_keys)

    # 2. Handle Tarballs (backwards compatibility)
    tar_files = sorted(input_path.glob("*.tar.gz"))
    log(f"\n[tar] Found {len(tar_files)} tarball(s)", debug=True)
    for tar_file in tar_files:
        size = tar_file.stat().st_size
        log(f"[tar] Extracting: {tar_file.name} ({size:,} bytes)", debug=True)
        t0 = time.time()
        try:
            with tarfile.open(tar_file, "r:gz") as tar:
                members = [m for m in tar.getmembers() if m.name.endswith(".json")]
                log(f"[tar]   JSON members inside archive: {len(members)}", debug=True)
                for member in members:
                    log(f"[tar]   -> {member.name} ({member.size:,} bytes)", debug=True)
                    f = tar.extractfile(member)
                    if f:
                        count, src_keys = parse_and_split(f, data_output_path, source_label=member.name)
                        log(f"[tar]      {count:,} reports parsed", debug=True)
                        parsed_count += count
                        index_keys.update(src_keys)
        except Exception as e:
            log(f"!! Failed to process {tar_file.name}: {e}")
        elapsed = time.time() - t0
        log(f"[tar] Done: {elapsed:.1f}s", debug=True)

    total_elapsed = time.time() - pipeline_start
    unique_apps = sum(1 for p in data_output_path.iterdir() if p.is_dir())
    total_year_files = sum(1 for p in data_output_path.rglob("*.json"))

    log(f"\n[summary] Total reports parsed    : {parsed_count:,}")
    log(f"[summary] Unique app directories  : {unique_apps:,}")
    log(f"[summary] Total year bucket files : {total_year_files:,}")
    log(f"[summary] Total time              : {total_elapsed:.1f}s")
    log(f"[summary] Output dir              : {data_output_path.resolve()}")

    if parsed_count == 0:
        log(f"!! ERROR: No reports were parsed from {input_dir}.")
        log(f"!! Found {len(json_files)} JSONs and {len(tar_files)} tarballs.")
        sys.exit(1)

    log("Done!")
    generate_latest_files(data_output_path)
    generate_app_indexes(index_keys, data_output_path)
    generate_index_html(index_keys, output_path)


def parse_and_split(file_handle, data_output_path, source_label="?"):
    """
    Stream-parse a report array and write output as:
        data/{appId}/{year}.json
    Each year file is a JSON array of all reports for that app in that year.
    Appends to existing year files so multiple source archives merge correctly.
    Deduplicates by timestamp to guard against the same archive appearing both
    as a loose .json and inside a .tar.gz in the same reports/ folder.
    """
    count = 0
    skipped = 0

    # Buffer in-memory per (appId, year) to minimize file open/close churn
    buffer: dict[tuple, list] = defaultdict(list)

    parser = ijson.items(file_handle, 'item')

    for report in parser:
        app_id = report.get("appId")
        if not app_id:
            skipped += 1
            continue

        ts = report.get("timestamp")
        try:
            year = str(datetime.fromtimestamp(int(ts), tz=timezone.utc).year) if ts else "unknown"
        except (ValueError, OSError):
            year = "unknown"

        buffer[(str(app_id), year)].append(report)
        count += 1

        if count % 10000 == 0:
            log(f"  [parse] {source_label}: {count:,} reports buffered...", debug=True)

    log(f"  [parse] {source_label}: flushing {len(buffer)} app/year buckets to disk...", debug=True)
    flush_start = time.time()

    for (app_id, year), new_reports in buffer.items():
        app_dir = data_output_path / app_id
        app_dir.mkdir(exist_ok=True)
        year_file = app_dir / f"{year}.json"

        existing = []
        if year_file.exists():
            try:
                with open(year_file, "r") as yf:
                    existing = json.load(yf)
            except Exception:
                existing = []

        # Deduplicate by timestamp — guards against the same archive appearing
        # both as a loose .json and inside a .tar.gz in the same reports/ folder.
        seen_timestamps = {r.get("timestamp") for r in existing}
        added = 0
        for r in new_reports:
            ts = r.get("timestamp")
            if ts not in seen_timestamps:
                existing.append(r)
                seen_timestamps.add(ts)
                added += 1

        if added < len(new_reports):
            dupes = len(new_reports) - added
            log(f"  [dedup] appId={app_id} year={year}: skipped {dupes} duplicate(s)", debug=True)

        with open(year_file, "w") as yf:
            json.dump(existing, yf, indent=2)

    flush_elapsed = time.time() - flush_start
    log(f"  [parse] {source_label}: flush done in {flush_elapsed:.1f}s", debug=True)

    if skipped:
        log(f"  [parse] {source_label}: skipped {skipped} records missing appId", debug=True)

    return count, set(buffer.keys())


def generate_latest_files(data_output_path: Path) -> None:
    """
    For each app directory, create latest.json containing the reports
    from the most recent year file.
    """
    count = 0
    for app_dir in data_output_path.iterdir():
        if not app_dir.is_dir():
            continue
        year_files = sorted(app_dir.glob("*.json"), key=lambda p: p.stem)
        # Exclude any existing latest.json from the sort
        year_files = [f for f in year_files if f.stem != "latest"]
        if not year_files:
            continue
        latest_src = year_files[-1]
        latest_dst = app_dir / "latest.json"
        latest_dst.write_bytes(latest_src.read_bytes())
        count += 1
    log(f"[latest] Generated {count} latest.json files", debug=True)


def generate_app_indexes(index_keys: set, data_output_path: Path) -> None:
    """
    Write data/{appId}/index.json for each app — a sorted list of available years.
    The plugin fetches this to discover which year files to merge for a game.
    """
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
    """
    Write index.html to output_path listing all data/{appId}/{year}.json files
    as a collapsible tree using native <details>/<summary> elements.
    index_keys is a set of (appId, year) tuples.
    """
    # Collect {appId: [year, ...]} sorted numerically
    app_years: dict[str, list[str]] = {}
    for (app_id, year) in index_keys:
        app_years.setdefault(app_id, []).append(year)

    sorted_app_ids = sorted(app_years.keys(), key=lambda a: (0, int(a)) if a.isdigit() else (1, a))
    for app_id in sorted_app_ids:
        app_years[app_id] = sorted(app_years[app_id], key=lambda y: (0, int(y)) if y.isdigit() else (1, y))

    # Well-known Steam app IDs for quick reference
    SAMPLE_APPS = {
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

    # Build sample links for apps that exist in the dataset
    sample_entries = []
    for app_id, name in SAMPLE_APPS.items():
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
        f"<strong>{len(sorted_app_ids)}</strong> games tracked.</p>",
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


def main():
    parser = argparse.ArgumentParser(
        description="Split ProtonDB reports into data/{appId}/{year}.json buckets"
    )
    parser.add_argument(
        "input_dir", nargs="?",
        help="Local directory containing JSON/tar.gz report files"
    )
    parser.add_argument(
        "output_dir", nargs="?",
        help="Output directory root (split files go under <output_dir>/data/)"
    )
    parser.add_argument(
        "--url",
        help="Git repo URL to clone as data source (e.g. https://github.com/bdefore/protondb-data)"
    )
    parser.add_argument(
        "--subfolder", default="reports",
        help="Subfolder within the cloned repo to use as input (default: reports)"
    )
    parser.add_argument(
        "--output", dest="output_dir_flag",
        help="Output directory (alternative to positional arg)"
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="Enable verbose debug logging"
    )
    args = parser.parse_args()

    global DEBUG
    DEBUG = args.debug

    output_dir = args.output_dir or args.output_dir_flag
    if not output_dir:
        output_dir = tempfile.mkdtemp(prefix="protondb-output-")
        log(f"[init] No output_dir specified, using temp dir: {output_dir}")

    if args.url:
        tmp_dir = tempfile.mkdtemp(prefix="protondb-clone-")
        clone_repo(args.url, tmp_dir)
        input_dir = os.path.join(tmp_dir, args.subfolder)
        log(f"[init] Using cloned subfolder: {input_dir}", debug=True)
    elif args.input_dir:
        input_dir = args.input_dir
    else:
        log("!! ERROR: provide input_dir or --url")
        parser.print_help()
        sys.exit(1)

    process_data(input_dir, output_dir)


if __name__ == "__main__":
    main()
