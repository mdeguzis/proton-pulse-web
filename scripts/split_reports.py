import os
import sys
import json
import re
import tarfile
import ijson
import argparse
import subprocess
import tempfile
import time
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
from urllib.request import urlopen, Request
from urllib.error import URLError

DEBUG = False


def log(msg, debug=False):
    """Flush-safe print for CI environments. Skipped if debug=True and DEBUG is off."""
    if debug and not DEBUG:
        return
    print(msg, flush=True)


def _fetch_name_protondb(app_id: str) -> str | None:
    """Try ProtonDB's Steam proxy."""
    url = f"https://www.protondb.com/proxy/steam/api/appdetails/?appids={app_id}"
    try:
        req = Request(url, headers={"User-Agent": "proton-pulse-data/1.0"})
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        return data.get(app_id, {}).get("data", {}).get("name")
    except Exception:
        return None


def _fetch_name_steamspy(app_id: str) -> str | None:
    """Fallback to SteamSpy."""
    url = f"https://steamspy.com/api.php?request=appdetails&appid={app_id}"
    try:
        req = Request(url, headers={"User-Agent": "proton-pulse-data/1.0"})
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        name = data.get("name")
        return name if name and name != "ValveTestApp" else None
    except Exception:
        return None


def fetch_app_names(app_ids: set[str], cache_path: str | None = None) -> dict[str, str]:
    """
    Resolve app IDs to game names via ProtonDB proxy, then SteamSpy fallback.
    Loads/saves a JSON cache file to avoid redundant lookups across runs.
    """
    cache: dict[str, str] = {}
    if cache_path:
        try:
            with open(cache_path, "r") as f:
                cache = json.load(f)
            log(f"[names] Loaded {len(cache)} cached names from {cache_path}", debug=True)
        except FileNotFoundError:
            pass
        except Exception as e:
            log(f"!! WARNING: Could not read name cache: {e}")

    missing = app_ids - cache.keys()
    if not missing:
        log(f"[names] All {len(app_ids)} names cached, nothing to fetch")
        return cache

    log(f"[names] Resolving {len(missing)} app names ({len(cache)} cached)...")
    resolved = 0
    failed = 0
    for i, app_id in enumerate(sorted(missing), 1):
        name = _fetch_name_protondb(app_id)
        if not name:
            name = _fetch_name_steamspy(app_id)
        if name:
            cache[app_id] = name
            resolved += 1
        else:
            failed += 1
        if i % 100 == 0:
            log(f"[names]   {i}/{len(missing)} looked up ({resolved} resolved, {failed} failed)...", debug=True)
        # Light rate-limit to be polite
        time.sleep(0.25)

    log(f"[names] Resolved {resolved} new names, {failed} unresolved")

    if cache_path:
        try:
            Path(cache_path).parent.mkdir(parents=True, exist_ok=True)
            with open(cache_path, "w") as f:
                json.dump(cache, f, indent=2)
            log(f"[names] Cache saved to {cache_path}", debug=True)
        except Exception as e:
            log(f"!! WARNING: Could not write name cache: {e}")

    return cache


def slugify(name: str) -> str:
    """Normalize a game name to lowercase-dashes."""
    name = name.lower()
    name = re.sub(r"[^a-z0-9]+", "-", name)
    return name.strip("-")


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


def process_data(input_dir, output_dir, app_names_cache=None):
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
    app_ids = {app_id for (app_id, _) in index_keys}
    app_names = fetch_app_names(app_ids, cache_path=app_names_cache)
    generate_index_html(index_keys, output_path, app_names=app_names)


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


def generate_index_html(index_keys: set, output_path: Path, app_names: dict[str, str] = None) -> None:
    """
    Write index.html to output_path listing all data/{appId}/{year}.json files
    as a collapsible tree using native <details>/<summary> elements.
    index_keys is a set of (appId, year) tuples.
    """
    if app_names is None:
        app_names = {}

    # Collect {appId: [year, ...]} sorted numerically
    app_years: dict[str, list[str]] = {}
    for (app_id, year) in index_keys:
        app_years.setdefault(app_id, []).append(year)

    sorted_app_ids = sorted(app_years.keys(), key=lambda a: (0, int(a)) if a.isdigit() else (1, a))
    for app_id in sorted_app_ids:
        app_years[app_id] = sorted(app_years[app_id], key=lambda y: (0, int(y)) if y.isdigit() else (1, y))

    lines = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="utf-8">',
        "  <title>proton-pulse-data index</title>",
        "</head>",
        "<body>",
        "<h1>proton-pulse-data index</h1>",
        "<ul>",
    ]

    for app_id in sorted_app_ids:
        name = app_names.get(app_id)
        if name:
            label = f"{slugify(name)}_{app_id}"
        else:
            label = app_id
        lines.append("  <li>")
        lines.append("    <details>")
        lines.append(f"      <summary>{label}/</summary>")
        lines.append("      <ul>")
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
    parser.add_argument(
        "--app-names-cache",
        help="Path to JSON cache file for app name lookups"
    )
    args = parser.parse_args()

    global DEBUG
    DEBUG = args.debug

    output_dir = args.output_dir or args.output_dir_flag
    if not output_dir:
        log("!! ERROR: output_dir is required (positional or --output)")
        parser.print_help()
        sys.exit(1)

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

    process_data(input_dir, output_dir, app_names_cache=args.app_names_cache)


if __name__ == "__main__":
    main()
