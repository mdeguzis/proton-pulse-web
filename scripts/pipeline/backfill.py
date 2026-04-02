import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib import error

from .common import (
    BACKFILL_MANIFEST_PATH,
    LIVE_COUNTS_URL,
    LIVE_REPORT_HASH_DEVICE,
    LIVE_REPORTS_URL,
    LIVE_REPORT_DEVICE,
    fetch_json,
    fetch_steam_title,
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


@dataclass(frozen=True)
class BackfillTarget:
    app_id: str
    report_urls: tuple[str, ...] = ()


def _coerce_backfill_target(entry) -> BackfillTarget:
    if isinstance(entry, dict):
        app_id = str(entry.get("appId", "")).strip()
        if not app_id or not app_id.isdigit():
            raise ValueError(f"Invalid app id in backfill manifest: {entry!r}")

        explicit_urls: list[str] = []
        report_url = entry.get("reportUrl")
        if report_url is not None:
            if not isinstance(report_url, str) or not report_url.strip():
                raise ValueError(f"Invalid reportUrl in backfill manifest: {entry!r}")
            explicit_urls.append(report_url.strip())

        report_urls = entry.get("reportUrls")
        if report_urls is not None:
            if not isinstance(report_urls, list):
                raise ValueError(f"reportUrls must be a JSON array: {entry!r}")
            for url in report_urls:
                if not isinstance(url, str) or not url.strip():
                    raise ValueError(f"Invalid reportUrls entry in backfill manifest: {entry!r}")
                explicit_urls.append(url.strip())

        deduped_urls = tuple(dict.fromkeys(explicit_urls))
        return BackfillTarget(app_id=app_id, report_urls=deduped_urls)

    app_id = str(entry).strip()
    if not app_id or not app_id.isdigit():
        raise ValueError(f"Invalid app id in backfill manifest: {entry!r}")
    return BackfillTarget(app_id=app_id)


def load_backfill_targets(manifest_path: Path = BACKFILL_MANIFEST_PATH) -> list[BackfillTarget]:
    if not manifest_path.exists():
        log(f"[backfill] No manifest found at {manifest_path}; skipping live backfill", debug=True)
        return []

    raw = json.loads(manifest_path.read_text())
    if not isinstance(raw, list):
        raise ValueError(f"Backfill manifest must be a JSON array: {manifest_path}")

    targets_by_app_id: dict[str, BackfillTarget] = {}
    for entry in raw:
        target = _coerce_backfill_target(entry)
        existing = targets_by_app_id.get(target.app_id)
        if existing is None:
            targets_by_app_id[target.app_id] = target
            continue

        merged_urls = tuple(dict.fromkeys([*existing.report_urls, *target.report_urls]))
        targets_by_app_id[target.app_id] = BackfillTarget(app_id=target.app_id, report_urls=merged_urls)

    return sorted(targets_by_app_id.values(), key=lambda target: int(target.app_id))


def load_backfill_app_ids(manifest_path: Path = BACKFILL_MANIFEST_PATH) -> list[str]:
    return [target.app_id for target in load_backfill_targets(manifest_path)]


def compute_js_hash(seed: str) -> int:
    hash_value = 0
    for ch in f"{seed}m":
        hash_value = ((hash_value << 5) - hash_value + ord(ch)) & 0xFFFFFFFF
    if hash_value & 0x80000000:
        hash_value -= 0x100000000
    return abs(hash_value)


def _build_js_hash_fragment(multiplier: int | str, prefix: int | str, modulus: int) -> str:
    remainder = int(prefix) % modulus
    try:
        product = int(multiplier) * remainder
        product_repr = str(product)
    except (TypeError, ValueError):
        # ProtonDB's current bundle passes a non-numeric device key here, which
        # becomes JavaScript NaN before hashing.
        product_repr = "NaN"
    return f"{prefix}p{product_repr}"


def compute_live_report_hash(app_id: int, report_count: int, timestamp: int, device_key: str) -> int:
    left = _build_js_hash_fragment(app_id, report_count, timestamp)
    right = _build_js_hash_fragment(device_key, app_id, timestamp)
    return compute_js_hash(f"p{left}*vRT{right}undefined")


def compute_live_report_hash_legacy(app_id: int, report_count: int, timestamp: int, page: str | int) -> int:
    left = f"{report_count}p{app_id * (report_count % timestamp)}"
    try:
        page_value = int(page)
        right_multiplier = str(page_value * (app_id % timestamp))
    except (TypeError, ValueError):
        right_multiplier = "nan"
    right = f"{app_id}p{right_multiplier}"
    return compute_js_hash(f"p{left}*vRT{right}{str(None)}")


def build_live_report_candidate_urls(app_id: str, report_count: int, timestamp: int, explicit_urls: tuple[str, ...] = ()) -> list[str]:
    candidates = list(explicit_urls)

    current_hash = compute_live_report_hash(int(app_id), report_count, timestamp, LIVE_REPORT_HASH_DEVICE)
    candidates.append(LIVE_REPORTS_URL.replace("{device}", LIVE_REPORT_DEVICE).replace("{hash}", str(current_hash)))

    legacy_hash = compute_live_report_hash_legacy(int(app_id), report_count, timestamp, "all")
    candidates.append(LIVE_REPORTS_URL.replace("{device}", LIVE_REPORT_DEVICE).replace("{hash}", str(legacy_hash)))

    return list(dict.fromkeys(candidates))


def fetch_live_reports_payload(app_id: str, candidate_urls: list[str], fetch_json_impl=fetch_json) -> tuple[dict | None, str | None]:
    for live_url in candidate_urls:
        log(f"[backfill] Fetching app {app_id} from {live_url}")
        try:
            payload = fetch_json_impl(live_url)
        except error.HTTPError as exc:
            log(f"[backfill] Candidate failed for {app_id}: HTTP {exc.code} at {live_url}", debug=True)
            continue
        except error.URLError as exc:
            log(f"[backfill] Candidate failed for {app_id}: request error {exc} at {live_url}", debug=True)
            continue

        if isinstance(payload, dict):
            return payload, live_url

        log(f"[backfill] Candidate failed for {app_id}: payload was not a JSON object at {live_url}", debug=True)

    return None, None


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


def normalize_live_detailed_reports(app_id: str, raw_reports: list[dict], title: str = "") -> list[dict]:
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
            "title": title,
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
    configured_targets = load_backfill_targets(manifest_path)
    existing_app_ids = {path.name for path in data_output_path.iterdir() if path.is_dir()}
    missing_targets = [target for target in configured_targets if target.app_id not in existing_app_ids]

    if not missing_targets:
        log("[backfill] No missing app IDs require live backfill", debug=True)
        return set()

    log(f"[backfill] Resolving {len(missing_targets)} missing app(s) via live ProtonDB detailed data")
    counts = fetch_json_impl(LIVE_COUNTS_URL)
    if not isinstance(counts, dict):
        raise ValueError("Live ProtonDB counts payload was not a JSON object")

    report_count = counts.get("reports")
    timestamp = counts.get("timestamp")
    if not isinstance(report_count, int) or not isinstance(timestamp, int) or report_count <= 0 or timestamp <= 0:
        raise ValueError("Live ProtonDB counts payload did not contain usable report/timestamp seeds")

    written_keys: set[tuple] = set()
    for target in missing_targets:
        candidate_urls = build_live_report_candidate_urls(
            target.app_id,
            report_count,
            timestamp,
            explicit_urls=target.report_urls,
        )
        payload, resolved_url = fetch_live_reports_payload(target.app_id, candidate_urls, fetch_json_impl=fetch_json_impl)
        if payload is None:
            log(f"[backfill] Skipping {target.app_id}: no live detailed report candidate succeeded")
            continue

        title = fetch_steam_title(target.app_id)
        reports = normalize_live_detailed_reports(target.app_id, payload.get("reports") or [], title=title)
        if not reports:
            log(f"[backfill] Skipping {target.app_id}: live detailed payload had no usable reports")
            continue

        year_buckets = bucket_reports_by_year(reports)
        written_keys.update(write_bucketed_reports(data_output_path, target.app_id, year_buckets))
        log(
            f"[backfill] Wrote {sum(len(rows) for rows in year_buckets.values())} reports across "
            f"{len(year_buckets)} year file(s) for {target.app_id} using {resolved_url}"
        )

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
