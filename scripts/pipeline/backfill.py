"""Backfill missing per-app report data and repair coverage gaps."""

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
import os
from pathlib import Path
from urllib import error

from .catalog import (
    get_protondb_probe_backfill_limit,
    get_steam_api_key,
    load_protondb_signal_catalog,
    load_steam_game_catalog,
    read_protondb_probe_cache,
)
from .common import (
    BACKFILL_MANIFEST_PATH,
    LIVE_COUNTS_URL,
    LIVE_REPORT_DEVICE,
    LIVE_REPORT_HASH_DEVICE,
    LIVE_REPORTS_URL,
    fetch_json,
    fetch_steam_title_with_source,
    flush_steam_title_cache,
    infer_duration,
    log,
    normalize_whitespace,
)
from .finalize import probe_cache_to_catalog
from .metadata import update_app_metadata
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
    """Manifest-defined app backfill target and optional report URL overrides."""

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
                    raise ValueError(
                        f"Invalid reportUrls entry in backfill manifest: {entry!r}"
                    )
                explicit_urls.append(url.strip())

        deduped_urls = tuple(dict.fromkeys(explicit_urls))
        return BackfillTarget(app_id=app_id, report_urls=deduped_urls)

    app_id = str(entry).strip()
    if not app_id or not app_id.isdigit():
        raise ValueError(f"Invalid app id in backfill manifest: {entry!r}")
    return BackfillTarget(app_id=app_id)


def load_backfill_targets(
    manifest_path: Path = BACKFILL_MANIFEST_PATH,
) -> list[BackfillTarget]:
    """Load and merge manifest entries keyed by app ID."""
    if not manifest_path.exists():
        log(
            f"[backfill] No manifest found at {manifest_path}; skipping live backfill",
            debug=True,
        )
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
        targets_by_app_id[target.app_id] = BackfillTarget(
            app_id=target.app_id, report_urls=merged_urls
        )

    return sorted(targets_by_app_id.values(), key=_target_app_id_sort_key)


def load_backfill_app_ids(manifest_path: Path = BACKFILL_MANIFEST_PATH) -> list[str]:
    """Return the sorted app IDs from the backfill manifest."""
    return [target.app_id for target in load_backfill_targets(manifest_path)]


def compute_js_hash(seed: str) -> int:
    """Reproduce the bundle hash function ProtonDB uses for report URLs."""
    hash_value = 0
    for ch in f"{seed}m":
        hash_value = ((hash_value << 5) - hash_value + ord(ch)) & 0xFFFFFFFF
    if hash_value & 0x80000000:
        hash_value -= 0x100000000
    return abs(hash_value)


def _build_js_hash_fragment(
    multiplier: int | str, prefix: int | str, modulus: int
) -> str:
    remainder = int(prefix) % modulus
    try:
        product = int(multiplier) * remainder
        product_repr = str(product)
    except (TypeError, ValueError):
        # ProtonDB's current bundle passes a non-numeric device key here, which
        # becomes JavaScript NaN before hashing.
        product_repr = "NaN"
    return f"{prefix}p{product_repr}"


def compute_live_report_hash(
    app_id: int, report_count: int, timestamp: int, device_key: str
) -> int:
    """Compute the current ProtonDB live detailed report hash for one app."""
    left = _build_js_hash_fragment(app_id, report_count, timestamp)
    right = _build_js_hash_fragment(device_key, app_id, timestamp)
    return compute_js_hash(f"p{left}*vRT{right}undefined")


def compute_live_report_hash_legacy(
    app_id: int, report_count: int, timestamp: int, page: str | int
) -> int:
    """Compute the legacy ProtonDB live detailed report hash for one app."""
    left = f"{report_count}p{app_id * (report_count % timestamp)}"
    try:
        page_value = int(page)
        right_multiplier = str(page_value * (app_id % timestamp))
    except (TypeError, ValueError):
        right_multiplier = "nan"
    right = f"{app_id}p{right_multiplier}"
    return compute_js_hash(f"p{left}*vRT{right}{str(None)}")


def build_live_report_candidate_urls(
    app_id: str, report_count: int, timestamp: int, explicit_urls: tuple[str, ...] = ()
) -> list[str]:
    """Build report URL candidates, preferring any manifest overrides first."""
    candidates = list(explicit_urls)

    current_hash = compute_live_report_hash(
        int(app_id), report_count, timestamp, LIVE_REPORT_HASH_DEVICE
    )
    candidates.append(
        LIVE_REPORTS_URL.replace("{device}", LIVE_REPORT_DEVICE).replace(
            "{hash}", str(current_hash)
        )
    )

    legacy_hash = compute_live_report_hash_legacy(
        int(app_id), report_count, timestamp, "all"
    )
    candidates.append(
        LIVE_REPORTS_URL.replace("{device}", LIVE_REPORT_DEVICE).replace(
            "{hash}", str(legacy_hash)
        )
    )

    return list(dict.fromkeys(candidates))


def fetch_live_reports_payload(
    app_id: str, candidate_urls: list[str], fetch_json_impl=fetch_json
) -> tuple[dict | None, str | None]:
    """Fetch the first live detailed report payload that resolves successfully."""
    for live_url in candidate_urls:
        log(f"[backfill] Fetching app {app_id} from {live_url}")
        try:
            payload = fetch_json_impl(live_url)
        except error.HTTPError as exc:
            log(
                f"[backfill] Candidate failed for {app_id}: HTTP {exc.code} at {live_url}",
                debug=True,
            )
            continue
        except error.URLError as exc:
            log(
                f"[backfill] Candidate failed for {app_id}: request error {exc} at {live_url}",
                debug=True,
            )
            continue

        if isinstance(payload, dict):
            return payload, live_url

        log(
            f"[backfill] Candidate failed for {app_id}: payload was not a JSON object at {live_url}",
            debug=True,
        )

    return None, None


def infer_live_rating(responses: dict | None) -> str:
    """Map live detailed ProtonDB responses into the plugin's rating buckets."""
    verdict = normalize_whitespace((responses or {}).get("verdict")).lower()
    if not verdict:
        return "pending"
    if verdict == "no":
        return "borked"
    if verdict != "yes":
        return "pending"

    fault_count = sum(
        1 for key in LIVE_REPORT_FAULT_KEYS if (responses or {}).get(key) == "yes"
    )
    if fault_count >= 3:
        return "bronze"
    if fault_count == 2:
        return "silver"
    if fault_count == 1:
        return "gold"
    if (responses or {}).get("triedOob") == "yes" or (responses or {}).get(
        "verdictOob"
    ) == "yes":
        return "platinum"
    return "gold"


def normalize_live_detailed_reports(
    app_id: str, raw_reports: list[dict], title: str = ""
) -> list[dict]:
    """Normalize ProtonDB live detailed reports into the mirror schema."""
    normalized = []
    for report in raw_reports:
        responses = report.get("responses") or {}
        steam = ((report.get("device") or {}).get("inferred") or {}).get("steam") or {}
        contributor_steam = (report.get("contributor") or {}).get("steam") or {}
        playtime = contributor_steam.get(
            "playtimeLinux", contributor_steam.get("playtime")
        )
        notes = normalize_whitespace(
            ((responses.get("notes") or {}).get("concludingNotes"))
            or ((responses.get("notes") or {}).get("verdict"))
            or (
                responses.get("notes")
                if isinstance(responses.get("notes"), str)
                else ""
            )
        )
        timestamp = report.get("timestamp")
        if not isinstance(timestamp, int) or timestamp <= 0:
            continue

        normalized.append(
            {
                "appId": app_id,
                "cpu": normalize_whitespace(steam.get("cpu")),
                "duration": infer_duration(playtime),
                "gpu": normalize_whitespace(steam.get("gpu")),
                "gpuDriver": normalize_whitespace(steam.get("gpuDriver")),
                "kernel": normalize_whitespace(steam.get("kernel")),
                "notes": notes,
                "os": normalize_whitespace(steam.get("os")),
                "protonVersion": normalize_whitespace(responses.get("protonVersion"))
                or "Unknown",
                "ram": normalize_whitespace(steam.get("ram")),
                "rating": infer_live_rating(responses),
                "timestamp": timestamp,
                "title": title,
            }
        )

    return normalized


def bucket_reports_by_year(reports: list[dict]) -> dict[str, list[dict]]:
    """Group reports into year buckets based on their timestamps."""
    buckets: dict[str, list[dict]] = defaultdict(list)
    for report in reports:
        ts = report.get("timestamp")
        try:
            year = (
                str(datetime.fromtimestamp(int(ts), tz=timezone.utc).year)
                if ts
                else "unknown"
            )
        except (ValueError, OSError):
            year = "unknown"
        buckets[year].append(report)
    return dict(buckets)


def write_bucketed_reports(
    data_output_path: Path, app_id: str, year_buckets: dict[str, list[dict]]
) -> set[tuple]:
    """Write normalized report buckets and return the generated index keys."""
    app_dir = data_output_path / app_id
    app_dir.mkdir(parents=True, exist_ok=True)
    written_keys: set[tuple] = set()

    for year, reports in year_buckets.items():
        year_file = app_dir / f"{year}.json"
        year_file.write_text(json.dumps(reports, indent=2))
        written_keys.add((app_id, year))

    return written_keys


def resolve_backfill_title(app_id: str, preferred_title: str = "") -> tuple[str, str]:
    """Resolve the title to write, preferring any manifest or catalog title first."""
    normalized_preferred = normalize_whitespace(preferred_title)
    if normalized_preferred:
        return normalized_preferred, "provided-catalog"
    return fetch_steam_title_with_source(app_id)


def backfill_missing_apps(
    data_output_path: Path,
    fetch_json_impl=fetch_json,
    manifest_path: Path = BACKFILL_MANIFEST_PATH,
    target_app_ids: list[str] | None = None,
    force: bool = False,
) -> tuple[set[tuple], set[str]]:
    """Backfill missing app data from ProtonDB live detailed reports."""
    # when specific IDs are passed, only process those and skip the manifest
    if target_app_ids:
        configured_targets = [BackfillTarget(app_id=aid) for aid in target_app_ids]
        log(f"[backfill] Targeting {len(configured_targets)} specific app ID(s)")
    else:
        configured_targets = load_backfill_targets(manifest_path)

    if force:
        # force mode: re-fetch all targets even if they already have data
        missing_targets = configured_targets
        already_present = 0
        log(f"[backfill] Force mode: processing all {len(missing_targets)} target(s)")
    else:
        existing_app_ids = {
            path.name for path in data_output_path.iterdir() if path.is_dir()
        }
        already_present = sum(
            1 for target in configured_targets if target.app_id in existing_app_ids
        )
        missing_targets = [
            target
            for target in configured_targets
            if target.app_id not in existing_app_ids
        ]

    if not missing_targets:
        log("[backfill] No missing app IDs require live backfill", debug=True)
        return set(), set()

    log(
        f"[backfill] Resolving {len(missing_targets)} missing app(s) via live ProtonDB detailed data"
    )
    counts = fetch_json_impl(LIVE_COUNTS_URL)
    if not isinstance(counts, dict):
        raise ValueError("Live ProtonDB counts payload was not a JSON object")

    report_count = counts.get("reports")
    timestamp = counts.get("timestamp")
    if (
        not isinstance(report_count, int)
        or not isinstance(timestamp, int)
        or report_count <= 0
        or timestamp <= 0
    ):
        raise ValueError(
            "Live ProtonDB counts payload did not contain usable report/timestamp seeds"
        )

    written_keys: set[tuple] = set()
    no_data_app_ids: set[str] = set()
    attempted = len(missing_targets)
    succeeded = 0
    no_candidate = 0
    no_usable_reports = 0
    unresolved_title = 0
    backfill_total = len(missing_targets)
    for bf_idx, target in enumerate(missing_targets, 1):
        bf_progress = f"({bf_idx}/{backfill_total})"
        candidate_urls = build_live_report_candidate_urls(
            target.app_id,
            report_count,
            timestamp,
            explicit_urls=target.report_urls,
        )
        payload, resolved_url = fetch_live_reports_payload(
            target.app_id, candidate_urls, fetch_json_impl=fetch_json_impl
        )
        if payload is None:
            log(
                f"[backfill] {bf_progress} Skipping {target.app_id}: no live detailed report candidate succeeded"
            )
            no_data_app_ids.add(target.app_id)
            no_candidate += 1
            continue

        title, title_source = resolve_backfill_title(target.app_id)
        if title:
            log(f"[backfill] {bf_progress} Title for {target.app_id}: {title!r} via {title_source}")
        else:
            log(
                f"[backfill] {bf_progress} Title unresolved for {target.app_id}: source={title_source}"
            )
            unresolved_title += 1
        reports = normalize_live_detailed_reports(
            target.app_id, payload.get("reports") or [], title=title
        )
        if not reports:
            log(
                f"[backfill] {bf_progress} Skipping {target.app_id}: live detailed payload had no usable reports"
            )
            no_data_app_ids.add(target.app_id)
            no_usable_reports += 1
            continue

        year_buckets = bucket_reports_by_year(reports)
        written_keys.update(
            write_bucketed_reports(data_output_path, target.app_id, year_buckets)
        )
        update_app_metadata(data_output_path, target.app_id, protondb_live=True)
        succeeded += 1
        log(
            f"[backfill] {bf_progress} Wrote {sum(len(rows) for rows in year_buckets.values())} reports across "
            f"{len(year_buckets)} year file(s) for {target.app_id} using {resolved_url}"
        )

    if no_data_app_ids:
        log(
            f"[backfill] {len(no_data_app_ids)} app(s) had no ProtonDB data: {sorted(no_data_app_ids)}"
        )

    _log_backfill_summary(
        "backfill",
        attempted,
        succeeded,
        written_keys,
        no_candidate=no_candidate,
        no_usable_reports=no_usable_reports,
        unresolved_title=unresolved_title,
        already_present=already_present,
    )

    return written_keys, no_data_app_ids


def _target_app_id_sort_key(target: BackfillTarget) -> int:
    """Sort BackfillTarget objects numerically by app ID."""
    return int(target.app_id)


def _string_app_id_sort_key(app_id: str) -> int:
    """Sort app ID strings numerically."""
    return int(app_id)


def _log_backfill_summary(
    prefix: str,
    attempted: int,
    succeeded: int,
    written_keys: set[tuple],
    *,
    no_candidate: int = 0,
    no_usable_reports: int = 0,
    unresolved_title: int = 0,
    already_present: int = 0,
) -> None:
    missed = max(0, attempted - succeeded)
    reason_parts = []
    if no_candidate:
        reason_parts.append(f"{no_candidate} no live detailed payload")
    if no_usable_reports:
        reason_parts.append(f"{no_usable_reports} no usable reports")
    if unresolved_title:
        reason_parts.append(f"{unresolved_title} unresolved title")
    if already_present:
        reason_parts.append(f"{already_present} already present")
    reason_text = ", ".join(reason_parts) if reason_parts else "none"
    log(
        f"[{prefix}] Summary: attempted {attempted:,} app(s), "
        f"succeeded {succeeded:,}, missed {missed:,}; "
        f"year buckets written {len(written_keys):,}; "
        f"miss reasons: {reason_text}"
    )


def backfill_probe_discoveries(
    data_output_path: Path,
    probe_catalog: dict[str, str],
    limit: int = 0,
    fetch_json_impl=fetch_json,
) -> set[tuple]:
    """Backfill apps discovered by the ProtonDB probe that have summaries but no local data."""
    existing_app_ids = {
        path.name for path in data_output_path.iterdir() if path.is_dir()
    }
    missing_app_ids = sorted(
        [app_id for app_id in probe_catalog if app_id not in existing_app_ids],
        key=_string_app_id_sort_key,
    )

    if not missing_app_ids:
        log("[probe-backfill] No probe-discovered apps require backfill")
        return set()

    total_missing = len(missing_app_ids)
    if 0 < limit < total_missing:
        missing_app_ids = missing_app_ids[:limit]
        log(
            f"[probe-backfill] {total_missing:,} probe-discovered apps missing data; backfilling first {limit:,}"
        )
    else:
        log(f"[probe-backfill] Backfilling {total_missing:,} probe-discovered app(s)")

    counts = fetch_json_impl(LIVE_COUNTS_URL)
    if not isinstance(counts, dict):
        raise ValueError("Live ProtonDB counts payload was not a JSON object")

    report_count = counts.get("reports")
    timestamp = counts.get("timestamp")
    if (
        not isinstance(report_count, int)
        or not isinstance(timestamp, int)
        or report_count <= 0
        or timestamp <= 0
    ):
        raise ValueError(
            "Live ProtonDB counts payload did not contain usable report/timestamp seeds"
        )

    written_keys: set[tuple] = set()
    succeeded = 0
    no_candidate = 0
    no_usable_reports = 0
    unresolved_title = 0
    total_to_process = len(missing_app_ids)
    for idx, app_id in enumerate(missing_app_ids, 1):
        progress = f"({idx}/{total_to_process})"
        candidate_urls = build_live_report_candidate_urls(
            app_id, report_count, timestamp
        )
        payload, resolved_url = fetch_live_reports_payload(
            app_id, candidate_urls, fetch_json_impl=fetch_json_impl
        )
        if payload is None:
            log(
                f"[probe-backfill] {progress} Skipping {app_id}: no live detailed report candidate succeeded"
            )
            no_candidate += 1
            continue

        title, title_source = resolve_backfill_title(
            app_id, preferred_title=probe_catalog.get(app_id, "")
        )
        if title:
            log(f"[probe-backfill] {progress} Title for {app_id}: {title!r} via {title_source}")
        else:
            log(
                f"[probe-backfill] {progress} Title unresolved for {app_id}: source={title_source}"
            )
            unresolved_title += 1
        reports = normalize_live_detailed_reports(
            app_id, payload.get("reports") or [], title=title
        )
        if not reports:
            log(
                f"[probe-backfill] {progress} Skipping {app_id}: live detailed payload had no usable reports"
            )
            no_usable_reports += 1
            continue

        year_buckets = bucket_reports_by_year(reports)
        written_keys.update(
            write_bucketed_reports(data_output_path, app_id, year_buckets)
        )
        update_app_metadata(data_output_path, app_id, protondb_live=True)
        succeeded += 1
        log(
            f"[probe-backfill] {progress} Wrote {sum(len(rows) for rows in year_buckets.values())} reports across "
            f"{len(year_buckets)} year file(s) for {app_id} using {resolved_url}"
        )

    _log_backfill_summary(
        "probe-backfill",
        len(missing_app_ids),
        succeeded,
        written_keys,
        no_candidate=no_candidate,
        no_usable_reports=no_usable_reports,
        unresolved_title=unresolved_title,
    )
    return written_keys


def run_probe_backfill(output_dir):
    """CLI entry point: read probe cache, backfill discovered apps, update state."""
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    state = read_pipeline_state(output_path)

    probe_cache = read_protondb_probe_cache()
    probe_catalog = {
        app_id: entry.get("title", "")
        for app_id, entry in probe_cache.items()
        if entry.get("tracked")
    }

    if not probe_catalog:
        log("[probe-backfill] No tracked apps in probe cache; nothing to backfill")
        return

    limit = get_protondb_probe_backfill_limit()
    log(
        f"[probe-backfill] Probe cache has {len(probe_catalog):,} tracked apps; limit {limit:,} per run"
    )

    backfilled_keys = backfill_probe_discoveries(
        data_output_path, probe_catalog, limit=limit
    )

    if backfilled_keys:
        merged_index_keys = set(state["index_keys"])
        merged_index_keys.update(backfilled_keys)
        merged_backfilled_keys = set(state["backfilled_keys"])
        merged_backfilled_keys.update(backfilled_keys)
        write_pipeline_state(
            output_path,
            state["parsed_count"],
            merged_index_keys,
            merged_backfilled_keys,
        )
        log(
            f"[probe-backfill] Updated pipeline state with {len(backfilled_keys):,} new keys"
        )

    flush_steam_title_cache()
    log("Done backfilling probe discoveries.")


def run_backfill(
    output_dir, target_app_ids: list[str] | None = None, force: bool = False
):
    """CLI entry point for manifest-driven live backfill runs."""
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    state = read_pipeline_state(output_path)
    backfilled_keys, no_data_ids = backfill_missing_apps(
        data_output_path,
        target_app_ids=target_app_ids,
        force=force,
    )
    merged_index_keys = set(state["index_keys"])
    merged_index_keys.update(backfilled_keys)
    merged_backfilled_keys = set(state["backfilled_keys"])
    merged_backfilled_keys.update(backfilled_keys)
    merged_no_data = set(state.get("no_data_app_ids", set()))
    merged_no_data.update(no_data_ids)
    write_pipeline_state(
        output_path,
        state["parsed_count"],
        merged_index_keys,
        merged_backfilled_keys,
        no_data_app_ids=merged_no_data,
    )
    log(
        f"[state] Updated pipeline state after backfill: {pipeline_state_path(output_path)}"
    )
    flush_steam_title_cache()
    log("Done backfilling missing apps.")


def _find_no_title_app_ids(data_output_path: Path) -> list[str]:
    """Find apps with missing titles: both on-disk apps with empty titles
    and catalog-only apps (Steam/ProtonDB) that have no title and no data."""
    app_ids: set[str] = set()

    # 1) On-disk apps with empty titles in latest.json
    for app_dir in sorted(data_output_path.iterdir(), key=lambda p: p.name):
        if not app_dir.is_dir() or not app_dir.name.isdigit():
            continue
        latest = app_dir / "latest.json"
        if not latest.exists():
            continue
        try:
            reports = json.loads(latest.read_text())
            if isinstance(reports, list) and reports:
                title = (reports[0].get("title") or "").strip()
                if not title:
                    app_ids.add(app_dir.name)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            app_ids.add(app_dir.name)

    on_disk_count = len(app_ids)

    # 2) Catalog-only apps with no title and no data directory
    catalog_titles: dict[str, str] = {}
    try:
        signal = load_protondb_signal_catalog()
        catalog_titles.update(signal)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    probe_cache = read_protondb_probe_cache()
    catalog_titles.update(probe_cache_to_catalog(probe_cache))
    steam_api_key = get_steam_api_key(os.environ)
    if steam_api_key:
        try:
            steam = load_steam_game_catalog(steam_api_key)
            catalog_titles.update(steam)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass

    for cid, title in catalog_titles.items():
        if not cid.isdigit():
            continue
        if (data_output_path / cid).is_dir():
            continue  # already handled above
        if not (title or "").strip():
            app_ids.add(cid)

    catalog_count = len(app_ids) - on_disk_count
    log(
        f"[no-titles] {on_disk_count} on-disk + {catalog_count} catalog-only = {len(app_ids)} total"
    )
    return sorted(app_ids, key=_string_app_id_sort_key)


def _find_bad_app_id_entries(data_output_path: Path) -> list[str]:
    """Find app directories with non-numeric names."""
    return sorted(
        p.name
        for p in data_output_path.iterdir()
        if p.is_dir() and not p.name.isdigit()
    )


def _find_no_protondb_data_app_ids(data_output_path: Path) -> list[str]:
    """Find apps with ProtonDB presence but no local on-disk ProtonDB data.

    Prefer the explicit ``no_data_app_ids`` tracked in pipeline state when
    present, but fall back to deriving candidates from the ProtonDB signal and
    probe catalogs so coverage-backfill can still repair visible coverage gaps
    like signal-only apps with no ``data/{appId}`` directory.
    """
    state = read_pipeline_state(data_output_path.parent)
    no_data_ids = set(state.get("no_data_app_ids", set()))
    if no_data_ids:
        return sorted(no_data_ids, key=lambda a: int(a) if a.isdigit() else 0)

    derived_ids: set[str] = set()
    try:
        derived_ids.update(load_protondb_signal_catalog().keys())
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass

    try:
        probe_cache = read_protondb_probe_cache()
        derived_ids.update(probe_cache_to_catalog(probe_cache).keys())
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass

    indexed_app_ids = {app_id for app_id, _year in state.get("index_keys", set())}
    backfilled_app_ids = {app_id for app_id, _year in state.get("backfilled_keys", set())}
    on_disk_app_ids = {p.name for p in data_output_path.iterdir() if p.is_dir() and p.name.isdigit()}

    candidates = [
        app_id
        for app_id in derived_ids
        if app_id.isdigit()
        and app_id not in indexed_app_ids
        and app_id not in backfilled_app_ids
        and app_id not in on_disk_app_ids
    ]
    return sorted(candidates, key=lambda a: int(a) if a.isdigit() else 0)


def _require_bounded_coverage_backfill(
    issue_type: str, limit: int, allow_unbounded: bool
) -> None:
    if issue_type == "bad-app-id":
        return
    if limit > 0:
        return
    if allow_unbounded:
        log(
            f"[coverage-backfill] Unbounded run explicitly allowed for issue type: {issue_type}"
        )
    else:
        log(
            f"[coverage-backfill] Running unbounded for issue type: {issue_type}"
        )


def _log_app_id_batches(prefix: str, app_ids: list[str], batch_size: int = 100) -> None:
    total = len(app_ids)
    if total == 0:
        log(f"{prefix}: none")
        return
    for start in range(0, total, batch_size):
        end = min(start + batch_size, total)
        batch = ",".join(app_ids[start:end])
        log(f"{prefix} ({start + 1}-{end}/{total}): {batch}")


def _patch_titles_on_disk(
    data_output_path: Path, app_ids: list[str]
) -> set[tuple[str, str]]:
    """Resolve Steam titles and patch all on-disk year files for the given app IDs.

    Returns the set of (app_id, year) keys that were updated so the caller can
    record them as backfilled.
    """
    patched_keys: set[tuple[str, str]] = set()
    for app_id in app_ids:
        title, source = fetch_steam_title_with_source(app_id)
        if not title:
            log(f"[no-titles] Could not resolve title for {app_id}: source={source}")
            continue
        log(f"[no-titles] {app_id}: {title!r} via {source}")
        app_dir = data_output_path / app_id
        for year_file in app_dir.glob("*.json"):
            if year_file.stem in ("index", "latest", "votes", "metadata"):
                continue
            try:
                reports = json.loads(year_file.read_text())
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
            changed = False
            for report in reports:
                if not (report.get("title") or "").strip():
                    report["title"] = title
                    changed = True
            if changed:
                year_file.write_text(json.dumps(reports, indent=2))
                patched_keys.add((app_id, year_file.stem))
    log(
        f"[no-titles] Patched {len(patched_keys)} year file(s) across {len({k[0] for k in patched_keys})} app(s)"
    )
    return patched_keys


def run_coverage_backfill(
    output_dir: str, issue_type: str, limit: int = 0, allow_unbounded: bool = False
) -> None:
    """Repair selected coverage issues by patching titles or backfilling data."""
    output_path = Path(output_dir)
    data_output_path = output_path / "data"

    _require_bounded_coverage_backfill(issue_type, limit, allow_unbounded)

    if issue_type == "no-titles":
        app_ids = _find_no_title_app_ids(data_output_path)
        log(f"[coverage-backfill] Found {len(app_ids)} app(s) with missing titles")
    elif issue_type == "bad-app-id":
        app_ids = _find_bad_app_id_entries(data_output_path)
        log(
            f"[coverage-backfill] Found {len(app_ids)} app(s) with non-numeric IDs: {app_ids}"
        )
        log("[coverage-backfill] Bad app IDs cannot be backfilled; listing only")
        return
    elif issue_type == "no-protondb-data":
        app_ids = _find_no_protondb_data_app_ids(data_output_path)
        log(f"[coverage-backfill] Found {len(app_ids)} app(s) with no ProtonDB data")
    else:
        log(f"!! ERROR: Unknown issue type: {issue_type}")
        return

    if not app_ids:
        log("[coverage-backfill] Nothing to backfill")
        return

    _log_app_id_batches("[coverage-backfill] Candidate app IDs", app_ids)

    if limit > 0:
        app_ids = app_ids[:limit]
        log(f"[coverage-backfill] Limited to {limit} app(s)")

    _log_app_id_batches("[coverage-backfill] Selected app IDs", app_ids)

    if issue_type == "no-titles":
        # Split into apps with existing data (patch titles) vs no data (live backfill)
        on_disk = [a for a in app_ids if (data_output_path / a).is_dir()]
        no_data = [a for a in app_ids if not (data_output_path / a).is_dir()]
        log(
            f"[no-titles] {len(on_disk)} on-disk (patch), {len(no_data)} no-data (backfill)"
        )

        # Patch titles on existing on-disk reports
        patched_keys = (
            _patch_titles_on_disk(data_output_path, on_disk) if on_disk else set()
        )

        # Attempt live backfill for catalog-only apps with no data
        if no_data:
            backfilled_keys, _no_data_ids = backfill_missing_apps(
                data_output_path,
                target_app_ids=no_data,
                force=True,
            )
            patched_keys.update(backfilled_keys)

        if patched_keys:
            state = read_pipeline_state(output_path)
            merged_backfilled = set(state["backfilled_keys"])
            merged_backfilled.update(patched_keys)
            merged_index = set(state["index_keys"])
            merged_index.update(patched_keys)
            write_pipeline_state(
                output_path,
                state["parsed_count"],
                merged_index,
                merged_backfilled,
            )
    else:
        run_backfill(output_dir, target_app_ids=app_ids, force=False)
    log(f"[coverage-backfill] Done ({issue_type})")
