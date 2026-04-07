import json
from pathlib import Path


APP_METADATA_FILENAME = "metadata.json"


def app_metadata_path(data_output_path: Path, app_id: str) -> Path:
    return data_output_path / str(app_id) / APP_METADATA_FILENAME


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
    app_dir = data_output_path / str(app_id)
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
