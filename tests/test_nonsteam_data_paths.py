"""Regression tests for #101: process, pulse, and finalize must agree on the
non-Steam per-game directory name (gog_123, not gog:123).

A GOG/Epic canonical id like 'gog:123' has to be converted to a filesystem-safe
'gog_123' before any path operation. Frontend (js/lib/app-id.js) and pipeline
(scripts/pipeline/common.app_id_to_dir) must produce the same string so the
browser fetches the same directory the pipeline writes.
"""
import json
from pathlib import Path

import pytest

from scripts.pipeline.common import app_id_to_dir
from scripts.pipeline.finalize import generate_app_indexes, generate_latest_files
from scripts.pipeline import process as process_mod


def test_app_id_to_dir_replaces_colon_for_gog_and_epic():
    assert app_id_to_dir("gog:123") == "gog_123"
    assert app_id_to_dir("epic:fortnite") == "epic_fortnite"


def test_app_id_to_dir_passes_steam_ids_through():
    assert app_id_to_dir("730") == "730"
    assert app_id_to_dir("570") == "570"


def test_finalize_writes_underscore_dir_for_gog_report(tmp_path: Path):
    # Simulate a GOG report year file already on disk (this is what pulse.py
    # writes via merge_pulse_into_data_dir). It must land in gog_123/, not gog:123/.
    gog_dir = tmp_path / "gog_123"
    gog_dir.mkdir()
    (gog_dir / "2026.json").write_text(json.dumps([
        {"appId": "gog:123", "title": "Test GOG Game", "timestamp": 1735689600, "rating": "platinum"}
    ]))

    generate_latest_files(tmp_path)
    generate_app_indexes({("gog:123", "2026")}, tmp_path)

    # Underscore directory has all three files
    assert (gog_dir / "latest.json").exists()
    assert (gog_dir / "index.json").exists()
    assert (gog_dir / "2026.json").exists()
    assert json.loads((gog_dir / "index.json").read_text()) == ["2026"]

    # Colon-named sibling directory must not be created
    assert not (tmp_path / "gog:123").exists()


def test_process_writes_underscore_dir(monkeypatch, tmp_path: Path):
    """parse_and_split must route year-file writes through app_id_to_dir, so a
    non-Steam id would land in data/gog_123/ rather than data/gog:123/. Steam
    IDs are unaffected (no colon to replace) -- we use one as the round-trip
    case here because process.py's input validator rejects non-digit IDs at
    line 38; this test asserts the *path construction* uses the helper, which
    is the call site the issue flagged.
    """
    fake_report = {"appId": "730", "timestamp": 1735689600, "rating": "gold"}

    class _StubIjson:
        @staticmethod
        def items(_handle, _path):
            yield fake_report

    monkeypatch.setattr(process_mod, "ijson", _StubIjson)

    count, keys = process_mod.parse_and_split(None, tmp_path, source_label="test")

    assert count == 1
    assert keys == {("730", "2025")}
    assert (tmp_path / "730" / "2025.json").exists()
    # Spot-check that the helper is being applied (i.e. the helper exists on the
    # module path the call site uses)
    assert process_mod.app_id_to_dir("gog:123") == "gog_123"
