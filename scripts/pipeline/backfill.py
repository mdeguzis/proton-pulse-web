import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib import error

from .common import (
    BACKFILL_MANIFEST_PATH,
    LIVE_COUNTS_URL,
    LIVE_REPORTS_URL,
    LIVE_REPORT_DEVICE,
    fetch_json,
    infer_duration,
    log,
    normalize_whitespace,
)
from .state import pipeline_state_path, read_pipeline_state, write_pipeline_state


LIVE_REPORT_FAULT_KEYS = [
    "audioFaults",
    "graphicalFaults",
    "inputFaults",
    "performanceFaults",
    "saveGameFaults",
    "significantBugs",
    "stabilityFaults",
    "windowingFaults",
]


def load_backfill_app_ids(manifest_path: Path = BACKFILL_MANIFEST_PATH) -> list[str]:
    if not manifest_path.exists():
        log(f"[backfill] No manifest found at {manifest_path}; skipping live backfill", debug=True)
        return []

    raw = json.loads(manifest_path.read_text())
    if not isinstance(raw, list):
        raise ValueError(f"Backfill manifest must be a JSON array: {manifest_path}")

    app_ids: list[str] = []
    for entry in raw:
        app_id = str(entry).strip()
        if not app_id or not app_id.isdigit():
            raise ValueError(f"Invalid app id in backfill manifest: {entry!r}")
        app_ids.append(app_id)
    return sorted(set(app_ids), key=int)


def compute_js_hash(seed: str) -> int:
    hash_value = 0
    for ch in f"{seed}m":
        hash_value = ((hash_value << 5) - hash_value + ord(ch)) & 0xFFFFFFFF
    if hash_value & 0x80000000:
        hash_value -= 0x100000000
    return abs(hash_value)


def compute_live_report_hash(app_id: int, report_count: int, timestamp: int, page: str | int) -> int:
    left = f"{report_count}p{app_id * (report_count % timestamp)}"
    try:
        page_value = int(page)
        right_multiplier = str(page_value * (app_id % timestamp))
    except (TypeError, ValueError):
        right_multiplier = "nan"
    right = f"{app_id}p{right_multiplier}"
    return compute_js_hash(f"p{left}*vRT{right}{str(None)}")


def infer_live_rating(responses: dict | None) -> str:
    verdict = normalize_whitespace((responses or {}).get("verdict")).lower()
    if not verdict:
        return "pending"
    if verdict == "no":
        return "borked"
    if verdict != "yes":
        return "pending"

    fault_count = sum(1 for key in LIVE_REPORT_FAULT_KEYS if (responses or {}).get(key) == "yes")
    if fault_count >= 3:
        return "bronze"
    if fault_count == 2:
        return "silver"
    if fault_count == 1:
        return "gold"
    if (responses or {}).get("triedOob") == "yes" or (responses or {}).get("verdictOob") == "yes":
        return "platinum"
    return "gold"


def normalize_live_detailed_reports(app_id: str, raw_reports: list[dict]) -> list[dict]:
    normalized = []
    for report in raw_reports:
        responses = report.get("responses") or {}
        steam = (((report.get("device") or {}).get("inferred") or {}).get("steam") or {})
        contributor_steam = ((report.get("contributor") or {}).get("steam") or {})
        playtime = contributor_steam.get("playtimeLinux", contributor_steam.get("playtime"))
        notes = normalize_whitespace(
            ((responses.get("notes") or {}).get("concludingNotes"))
            or ((responses.get("notes") or {}).get("verdict"))
            or (responses.get("notes") if isinstance(responses.get("notes"), str) else "")
        )
        timestamp = report.get("timestamp")
        if not isinstance(timestamp, int) or timestamp <= 0:
            continue

        normalized.append({
            "appId": app_id,
            "cpu": normalize_whitespace(steam.get("cpu")),
            "duration": infer_duration(playtime),
            "gpu": normalize_whitespace(steam.get("gpu")),
            "gpuDriver": normalize_whitespace(steam.get("gpuDriver")),
            "kernel": normalize_whitespace(steam.get("kernel")),
            "notes": notes,
            "os": normalize_whitespace(steam.get("os")),
            "protonVersion": normalize_whitespace(responses.get("protonVersion")) or "Unknown",
            "ram": normalize_whitespace(steam.get("ram")),
            "rating": infer_live_rating(responses),
            "timestamp": timestamp,
            "title": "",
        })

    return normalized


def bucket_reports_by_year(reports: list[dict]) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = defaultdict(list)
    for report in reports:
        ts = report.get("timestamp")
        try:
            year = str(datetime.fromtimestamp(int(ts), tz=timezone.utc).year) if ts else "unknown"
        except (ValueError, OSError):
            year = "unknown"
        buckets[year].append(report)
    return dict(buckets)


def write_bucketed_reports(data_output_path: Path, app_id: str, year_buckets: dict[str, list[dict]]) -> set[tuple]:
    app_dir = data_output_path / app_id
    app_dir.mkdir(parents=True, exist_ok=True)
    written_keys: set[tuple] = set()

    for year, reports in year_buckets.items():
        year_file = app_dir / f"{year}.json"
        year_file.write_text(json.dumps(reports, indent=2))
        written_keys.add((app_id, year))

    return written_keys


def backfill_missing_apps(
    data_output_path: Path,
    fetch_json_impl=fetch_json,
    manifest_path: Path = BACKFILL_MANIFEST_PATH,
) -> set[tuple]:
    configured_app_ids = load_backfill_app_ids(manifest_path)
    existing_app_ids = {path.name for path in data_output_path.iterdir() if path.is_dir()}
    missing_app_ids = [app_id for app_id in configured_app_ids if app_id not in existing_app_ids]

    if not missing_app_ids:
        log("[backfill] No missing app IDs require live backfill", debug=True)
        return set()

    log(f"[backfill] Resolving {len(missing_app_ids)} missing app(s) via live ProtonDB detailed data")
    counts = fetch_json_impl(LIVE_COUNTS_URL)
    if not isinstance(counts, dict):
        raise ValueError("Live ProtonDB counts payload was not a JSON object")

    report_count = counts.get("reports")
    timestamp = counts.get("timestamp")
    if not isinstance(report_count, int) or not isinstance(timestamp, int) or report_count <= 0 or timestamp <= 0:
        raise ValueError("Live ProtonDB counts payload did not contain usable report/timestamp seeds")

    written_keys: set[tuple] = set()
    for app_id in missing_app_ids:
        hash_value = compute_live_report_hash(int(app_id), report_count, timestamp, "all")
        live_url = LIVE_REPORTS_URL.replace("{device}", LIVE_REPORT_DEVICE).replace("{hash}", str(hash_value))
        log(f"[backfill] Fetching app {app_id} from {live_url}")
        try:
            payload = fetch_json_impl(live_url)
        except error.HTTPError as exc:
            log(f"[backfill] Skipping {app_id}: live detailed request returned HTTP {exc.code}")
            continue
        except error.URLError as exc:
            log(f"[backfill] Skipping {app_id}: live detailed request failed: {exc}")
            continue

        reports = normalize_live_detailed_reports(app_id, payload.get("reports") or [])
        if not reports:
            log(f"[backfill] Skipping {app_id}: live detailed payload had no usable reports")
            continue

        year_buckets = bucket_reports_by_year(reports)
        written_keys.update(write_bucketed_reports(data_output_path, app_id, year_buckets))
        log(f"[backfill] Wrote {sum(len(rows) for rows in year_buckets.values())} reports across {len(year_buckets)} year file(s) for {app_id}")

    return written_keys


def run_backfill(output_dir):
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    state = read_pipeline_state(output_path)
    backfilled_keys = backfill_missing_apps(data_output_path)
    merged_index_keys = set(state["index_keys"])
    merged_index_keys.update(backfilled_keys)
    merged_backfilled_keys = set(state["backfilled_keys"])
    merged_backfilled_keys.update(backfilled_keys)
    write_pipeline_state(output_path, state["parsed_count"], merged_index_keys, merged_backfilled_keys)
    log(f"[state] Updated pipeline state after backfill: {pipeline_state_path(output_path)}")
    log("Done backfilling missing apps.")
