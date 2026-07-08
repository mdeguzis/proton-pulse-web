"""Tests for scripts/pipeline/write_depot_files.py (#237)."""

import json
from pathlib import Path
from unittest.mock import patch

import scripts.pipeline.write_depot_files as wdf


UPDATES = [
    {"app_id": 367520, "os": "linux", "depot_id": 367521,
     "name": "linux depot", "manifest_id": "1", "last_updated_at": "2026-03-27T00:00:00Z"},
    {"app_id": 367520, "os": "windows", "depot_id": 367522,
     "name": "win depot",  "manifest_id": "2", "last_updated_at": "2026-03-27T00:00:00Z"},
]

HISTORY = [
    {"app_id": 367520, "os": "linux", "depot_id": 367521,
     "manifest_id": "1", "first_observed_at": "2026-01-01T00:00:00Z",
     "latest_observed_at": "2026-03-27T00:00:00Z"},
    {"app_id": 367520, "os": "linux", "depot_id": 367521,
     "manifest_id": "0", "first_observed_at": "2025-06-15T00:00:00Z",
     "latest_observed_at": "2025-12-31T00:00:00Z"},
    {"app_id": 367520, "os": "windows", "depot_id": 367522,
     "manifest_id": "2", "first_observed_at": "2026-02-01T00:00:00Z",
     "latest_observed_at": "2026-03-27T00:00:00Z"},
]

STATUS = [{
    "app_id": 367520,
    "app_status": "ok",
    "depot_count": 2,
    "fetched_at": "2026-03-27T09:00:00Z",
    "error": None,
    "raw_pics": {
        "367521": {
            "config": {"oslist": "linux"},
            "manifests": {"public": {"gid": "1", "timeupdated": "1743033600"}},
        },
        "367522": {
            "config": {"oslist": "windows"},
            "manifests": {"public": {"gid": "2", "timeupdated": "1743033600"}},
        },
        "branches": {"public": {"buildid": "12345", "timeupdated": "1743033600"}},
    },
}]


def _run_writer(tmp_path: Path) -> dict:
    """Invoke the writer with mocked Supabase reads and return the emitted file."""
    with patch.object(wdf, "_supabase_url", return_value="https://x"), \
         patch.object(wdf, "_service_key", return_value="k"), \
         patch.object(wdf, "_fetch_all", side_effect=[UPDATES, HISTORY, STATUS]):
        n = wdf.write_depot_files(tmp_path)
    assert n == 1
    return json.loads((tmp_path / "367520" / "depots.json").read_text())


class TestWriteDepotFiles:
    def test_emits_one_file_per_steam_app(self, tmp_path: Path):
        payload = _run_writer(tmp_path)
        assert payload["app_id"] == 367520
        assert payload["status"] == "ok"

    def test_tracked_since_is_earliest_first_observed_at_per_os(self, tmp_path: Path):
        payload = _run_writer(tmp_path)
        # linux has two history rows; earliest wins.
        assert payload["os"]["linux"]["tracked_since"] == "2025-06-15T00:00:00Z"
        # windows only one history row.
        assert payload["os"]["windows"]["tracked_since"] == "2026-02-01T00:00:00Z"

    def test_last_updated_is_max_across_updates_for_that_os(self, tmp_path: Path):
        payload = _run_writer(tmp_path)
        assert payload["os"]["linux"]["last_updated"] == "2026-03-27T00:00:00Z"
        assert payload["os"]["windows"]["last_updated"] == "2026-03-27T00:00:00Z"

    def test_depot_count_unions_updates_and_history(self, tmp_path: Path):
        payload = _run_writer(tmp_path)
        # Depot ids are unique per OS in the fixtures -- linux=1, windows=1.
        assert payload["os"]["linux"]["depots"] == 1
        assert payload["os"]["windows"]["depots"] == 1

    def test_manifests_array_carries_every_observation_row(self, tmp_path: Path):
        payload = _run_writer(tmp_path)
        linux_manifests = payload["os"]["linux"]["manifests"]
        # Two rows in HISTORY for linux -> two entries.
        assert len(linux_manifests) == 2
        assert {m["manifest_id"] for m in linux_manifests} == {"0", "1"}

    def test_raw_pics_is_persisted_verbatim(self, tmp_path: Path):
        payload = _run_writer(tmp_path)
        assert payload["raw_pics"]["branches"]["public"]["buildid"] == "12345"
        assert payload["raw_pics"]["367521"]["config"]["oslist"] == "linux"

    def test_missing_credentials_short_circuits(self, tmp_path: Path):
        with patch.object(wdf, "_supabase_url", return_value=None):
            assert wdf.write_depot_files(tmp_path) == 0
        assert not any(tmp_path.iterdir())

    def test_empty_supabase_writes_nothing(self, tmp_path: Path):
        with patch.object(wdf, "_supabase_url", return_value="https://x"), \
             patch.object(wdf, "_service_key", return_value="k"), \
             patch.object(wdf, "_fetch_all", side_effect=[[], [], []]):
            assert wdf.write_depot_files(tmp_path) == 0
        assert not any(tmp_path.iterdir())

    def test_app_with_only_history_still_emits(self, tmp_path: Path):
        # Simulate an app we've observed but not yet current-updated.
        with patch.object(wdf, "_supabase_url", return_value="https://x"), \
             patch.object(wdf, "_service_key", return_value="k"), \
             patch.object(wdf, "_fetch_all", side_effect=[[], HISTORY, []]):
            n = wdf.write_depot_files(tmp_path)
        assert n == 1
        payload = json.loads((tmp_path / "367520" / "depots.json").read_text())
        assert payload["os"]["linux"]["tracked_since"] == "2025-06-15T00:00:00Z"
        assert payload["os"]["linux"]["last_updated"] is None
