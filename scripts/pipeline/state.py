import json
from pathlib import Path


PIPELINE_STATE_FILENAME = "pipeline-state.json"


def pipeline_state_path(output_path: Path) -> Path:
    return output_path / PIPELINE_STATE_FILENAME


def _index_key_sort_key(item):
    app_id, year = item
    return (0, int(app_id), year) if str(app_id).isdigit() else (1, str(app_id), year)


def serialize_index_keys(index_keys: set[tuple]) -> list[list[str]]:
    return [[app_id, year] for app_id, year in sorted(index_keys, key=_index_key_sort_key)]


def deserialize_index_keys(raw_keys) -> set[tuple]:
    if not isinstance(raw_keys, list):
        raise ValueError("Pipeline state index_keys must be a list")
    return {
        (str(item[0]), str(item[1]))
        for item in raw_keys
        if isinstance(item, (list, tuple)) and len(item) == 2
    }


def write_pipeline_state(output_path: Path, parsed_count: int, index_keys: set[tuple], backfilled_keys: set[tuple] | None = None) -> None:
    state = {
        "parsed_count": parsed_count,
        "index_keys": serialize_index_keys(index_keys),
        "backfilled_keys": serialize_index_keys(backfilled_keys or set()),
    }
    pipeline_state_path(output_path).write_text(json.dumps(state, indent=2) + "\n")


def read_pipeline_state(output_path: Path) -> dict:
    state_file = pipeline_state_path(output_path)
    if not state_file.exists():
        raise FileNotFoundError(f"Pipeline state file not found: {state_file}")
    raw = json.loads(state_file.read_text())
    return {
        "parsed_count": int(raw.get("parsed_count", 0)),
        "index_keys": deserialize_index_keys(raw.get("index_keys", [])),
        "backfilled_keys": deserialize_index_keys(raw.get("backfilled_keys", [])),
    }
