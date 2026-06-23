import json
from pathlib import Path

from .common import app_id_to_dir


APP_METADATA_FILENAME = "metadata.json"
RESERVED_APP_JSON_STEMS = {"index", "latest", "votes", "metadata"}
LIVE_NORMALIZED_REQUIRED_KEYS = {"appId", "duration", "protonVersion", "rating", "timestamp", "title"}
LIVE_NORMALIZED_ALLOWED_KEYS = {
    "appId",
    "cpu",
    "duration",
    "gpu",
    "gpuDriver",
    "kernel",
    "notes",
    "os",
    "protonVersion",
    "ram",
    "rating",
    "timestamp",
    "title",
}


def app_metadata_path(data_output_path: Path, app_id: str) -> Path:
    return data_output_path / app_id_to_dir(str(app_id)) / APP_METADATA_FILENAME


def read_app_metadata(data_output_path: Path, app_id: str) -> dict[str, bool]:
    metadata_path = app_metadata_path(data_output_path, app_id)
    if not metadata_path.exists():
        return {}
    try:
        raw = json.loads(metadata_path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        "official_dump": bool(raw.get("official_dump")),
        "protondb_live": bool(raw.get("protondb_live")),
    }


def update_app_metadata(data_output_path: Path, app_id: str, **flags: bool) -> dict[str, bool]:
    app_dir = data_output_path / app_id_to_dir(str(app_id))
    app_dir.mkdir(parents=True, exist_ok=True)

    metadata = {
        "official_dump": False,
        "protondb_live": False,
        **read_app_metadata(data_output_path, app_id),
    }
    for key, value in flags.items():
        if key in metadata:
            metadata[key] = bool(value)

    app_metadata_path(data_output_path, app_id).write_text(json.dumps(metadata, indent=2) + "\n")
    return metadata


def _iter_report_files(app_dir: Path):
    for json_file in sorted(app_dir.glob("*.json"), key=lambda path: path.stem):
        if json_file.stem in RESERVED_APP_JSON_STEMS:
            continue
        yield json_file


def _read_report_samples(app_dir: Path) -> list[dict]:
    samples: list[dict] = []
    for report_file in _iter_report_files(app_dir):
        try:
            reports = json.loads(report_file.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(reports, list) and reports and isinstance(reports[0], dict):
            samples.append(reports[0])
    return samples


def _is_live_normalized_report(report: dict) -> bool:
    keys = set(report.keys())
    return LIVE_NORMALIZED_REQUIRED_KEYS.issubset(keys) and keys.issubset(LIVE_NORMALIZED_ALLOWED_KEYS)


def infer_app_metadata_from_disk(data_output_path: Path, app_id: str) -> dict[str, bool]:
    app_dir = data_output_path / app_id_to_dir(str(app_id))
    if not app_dir.is_dir():
        return {}

    samples = _read_report_samples(app_dir)
    if not samples:
        return {}

    saw_live = any(_is_live_normalized_report(sample) for sample in samples)
    saw_non_live = any(not _is_live_normalized_report(sample) for sample in samples)
    inferred: dict[str, bool] = {}
    if saw_live:
        inferred["protondb_live"] = True
    if saw_non_live:
        inferred["official_dump"] = True
    return inferred


def bootstrap_app_metadata(
    data_output_path: Path,
    app_id: str,
    backfilled_app_ids: set[str] | None = None,
) -> dict[str, bool]:
    existing = read_app_metadata(data_output_path, app_id)
    inferred = infer_app_metadata_from_disk(data_output_path, app_id)
    merged = {
        "official_dump": existing.get("official_dump", False) or inferred.get("official_dump", False),
        "protondb_live": existing.get("protondb_live", False)
        or inferred.get("protondb_live", False)
        or str(app_id) in (backfilled_app_ids or set()),
    }
    if merged != existing or not app_metadata_path(data_output_path, app_id).exists():
        return update_app_metadata(data_output_path, app_id, **merged)
    return merged


def bootstrap_all_app_metadata(
    data_output_path: Path,
    backfilled_app_ids: set[str] | None = None,
) -> dict[str, dict[str, bool]]:
    bootstrapped: dict[str, dict[str, bool]] = {}
    for app_dir in sorted(data_output_path.iterdir(), key=lambda path: path.name):
        if not app_dir.is_dir():
            continue
        bootstrapped[app_dir.name] = bootstrap_app_metadata(
            data_output_path,
            app_dir.name,
            backfilled_app_ids=backfilled_app_ids,
        )
    return bootstrapped
