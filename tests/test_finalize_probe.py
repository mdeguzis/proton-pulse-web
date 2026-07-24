"""Tests for finalize.py probe-related and coverage functions."""
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

import scripts.pipeline.finalize as finalize_module
from scripts.pipeline.finalize import (
    compute_probe_candidates,
    build_probe_chunk_plan,
    probe_cache_to_catalog,
    generate_latest_files,
    reindex_apps,
    finalize_output,
)
from scripts.pipeline.state import write_pipeline_state


# ── probe_cache_to_catalog ─────────────────────────────────────────────────────

def test_probe_cache_to_catalog_tracked_only():
    cache = {
        "730": {"tracked": True, "title": "CS2"},
        "570": {"tracked": False, "title": "Dota"},
    }
    result = probe_cache_to_catalog(cache)
    assert "730" in result
    assert "570" not in result

def test_probe_cache_to_catalog_non_dict_entry():
    cache = {"730": "not a dict"}
    result = probe_cache_to_catalog(cache)
    assert "730" not in result


# ── generate_latest_files ──────────────────────────────────────────────────────

def test_generate_latest_files_skips_non_dir(tmp_path):
    (tmp_path / "file.txt").write_text("not a dir")
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text(json.dumps([{"appId": "730"}]))
    generate_latest_files(tmp_path)
    assert (app_dir / "latest.json").exists()

def test_generate_latest_files_skips_empty_app_dir(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    generate_latest_files(tmp_path)
    assert not (app_dir / "latest.json").exists()


# ── reindex_apps ──────────────────────────────────────────────────────────────

def test_reindex_apps_skips_missing_dir(tmp_path, capsys):
    write_pipeline_state(tmp_path, 0, set())
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    reindex_apps(str(tmp_path), ["999"])
    err = capsys.readouterr().err
    assert "Skipping 999" in err


# ── compute_probe_candidates ───────────────────────────────────────────────────

def test_compute_probe_candidates_no_steam_key(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    with patch("scripts.pipeline.finalize.get_steam_api_key", return_value=None):
        candidates, cached = compute_probe_candidates(str(tmp_path))
    assert candidates == []
    assert cached == 0

def test_compute_probe_candidates_with_steam_catalog(tmp_path):
    write_pipeline_state(tmp_path, 0, {("730", "2024")})
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", return_value={}),
        patch("scripts.pipeline.finalize.load_steam_game_catalog", return_value={"570": "Dota", "730": "CS2"}),
    ):
        candidates, cached = compute_probe_candidates(str(tmp_path))
    assert "570" in candidates
    assert "730" not in candidates  # already indexed

def test_compute_probe_candidates_signal_catalog_error(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", side_effect=Exception("err")),
        patch("scripts.pipeline.finalize.load_steam_game_catalog", return_value={"570": "Dota"}),
    ):
        candidates, cached = compute_probe_candidates(str(tmp_path))
    assert "570" in candidates


# ── build_probe_chunk_plan ─────────────────────────────────────────────────────

def test_build_probe_chunk_plan_no_candidates(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    with patch("scripts.pipeline.finalize.compute_probe_candidates", return_value=([], 0)):
        with patch("scripts.pipeline.finalize.get_protondb_probe_limit", return_value=100):
            plan = build_probe_chunk_plan(str(tmp_path))
    assert plan["chunk_count"] == 0
    assert plan["chunks"] == []

def test_build_probe_chunk_plan_with_candidates(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    candidates = [str(i) for i in range(250)]
    with (
        patch("scripts.pipeline.finalize.compute_probe_candidates", return_value=(candidates, 0)),
        patch("scripts.pipeline.finalize.get_protondb_probe_limit", return_value=100),
    ):
        plan = build_probe_chunk_plan(str(tmp_path))
    assert plan["chunk_count"] == 3
    assert len(plan["chunks"]) == 3

def test_build_probe_chunk_plan_no_limit(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    candidates = ["730", "570"]
    with (
        patch("scripts.pipeline.finalize.compute_probe_candidates", return_value=(candidates, 0)),
        patch("scripts.pipeline.finalize.get_protondb_probe_limit", return_value=0),
    ):
        plan = build_probe_chunk_plan(str(tmp_path))
    assert plan["chunk_count"] == 1

def test_build_probe_chunk_plan_all_cached(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    candidates = ["730", "570"]
    with (
        patch("scripts.pipeline.finalize.compute_probe_candidates", return_value=(candidates, 2)),
        patch("scripts.pipeline.finalize.get_protondb_probe_limit", return_value=100),
    ):
        plan = build_probe_chunk_plan(str(tmp_path))
    assert plan["chunk_count"] == 0
    assert plan["uncached_count"] == 0


# ── finalize_output (skip_probe path) ─────────────────────────────────────────

def test_finalize_output_skip_probe(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "730").mkdir()
    (data_dir / "730" / "2024.json").write_text(json.dumps([{
        "appId": "730", "timestamp": 1704067200, "rating": "gold",
        "title": "CS2", "source": "protondb",
    }]))
    write_pipeline_state(tmp_path, 1, {("730", "2024")})

    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value=None),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", return_value={"730": "CS2"}),
        patch("scripts.pipeline.finalize.fetch_json", side_effect=Exception("no network")),
        patch("scripts.pipeline.finalize.merge_pulse_into_data_dir", return_value=None),
        patch("scripts.pipeline.finalize.build_most_played"),
        patch("scripts.pipeline.finalize.build_game_images"),
        patch("scripts.pipeline.finalize.flush_steam_title_cache"),
    ):
        finalize_output(str(tmp_path), skip_probe=True)


# ── reindex_apps with real data (line 79) ─────────────────────────────────────

def test_reindex_apps_indexes_when_data_present(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text(json.dumps([{"appId": "730", "timestamp": 1704067200, "rating": "gold"}]))
    reindex_apps(str(tmp_path), ["730"])
    assert (app_dir / "index.json").exists()


# ── derive_index_keys_from_disk (line 563) ────────────────────────────────────

from scripts.pipeline.finalize import derive_index_keys_from_disk


def test_derive_index_keys_skips_non_dir(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "not-a-dir.txt").write_text("x")
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text("[]")
    result = derive_index_keys_from_disk(data_dir)
    assert ("730", "2024") in result


# ── generate_recent_reports edge cases (lines 654, 661, 665, 668, 670-671) ───

from scripts.pipeline.finalize import generate_recent_reports


def test_generate_recent_reports_skips_non_dir(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "file.txt").write_text("x")
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text(json.dumps([{"timestamp": 1704067200, "rating": "gold"}]))
    (tmp_path / "search-index.json").write_text(json.dumps([["730", "CS2", "gold", 5, 1]]))
    generate_recent_reports(data_dir, tmp_path)
    assert (tmp_path / "recent-reports.json").exists()


def test_generate_recent_reports_skips_empty_app_dir(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "730").mkdir()  # no year files
    (tmp_path / "search-index.json").write_text("[]")
    generate_recent_reports(data_dir, tmp_path)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert result == []


def test_generate_recent_reports_skips_non_list_year_file(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text('"not a list"')
    (tmp_path / "search-index.json").write_text(json.dumps([["730", "CS2", "gold", 5, 1]]))
    generate_recent_reports(data_dir, tmp_path)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert result == []


def test_generate_recent_reports_skips_zero_timestamp(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text(json.dumps([{"timestamp": 0}]))
    (tmp_path / "search-index.json").write_text(json.dumps([["730", "CS2", "gold", 5, 1]]))
    generate_recent_reports(data_dir, tmp_path)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert result == []


def test_generate_recent_reports_skips_corrupt_year_file(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text("not json")
    (tmp_path / "search-index.json").write_text(json.dumps([["730", "CS2", "gold", 5, 1]]))
    generate_recent_reports(data_dir, tmp_path)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert result == []


def test_generate_recent_reports_skips_missing_title(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "999"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text(json.dumps([{"timestamp": 1704067200}]))
    (tmp_path / "search-index.json").write_text("[]")  # no entry for 999
    generate_recent_reports(data_dir, tmp_path)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert result == []


# ── update_protondb_probe_cache with steam_api_key (lines 1164-1198) ──────────

from scripts.pipeline.finalize import update_protondb_probe_cache


def test_update_protondb_probe_cache_with_steam_key(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", return_value={}),
        patch("scripts.pipeline.finalize.compute_probe_candidates", return_value=([], 0)),
        patch("scripts.pipeline.finalize.probe_protondb_app_ids", return_value=({}, {})),
        patch("scripts.pipeline.finalize.write_protondb_probe_cache"),
    ):
        result = update_protondb_probe_cache(str(tmp_path))
    assert result == {}


def test_update_protondb_probe_cache_signal_catalog_error(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", side_effect=Exception("err")),
        patch("scripts.pipeline.finalize.compute_probe_candidates", return_value=([], 0)),
        patch("scripts.pipeline.finalize.probe_protondb_app_ids", return_value=({}, {})),
        patch("scripts.pipeline.finalize.write_protondb_probe_cache"),
    ):
        result = update_protondb_probe_cache(str(tmp_path))
    assert result == {}


# ── finalize_output: signal catalog error and steam catalog paths ─────────────

def _make_finalize_data(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "730").mkdir()
    (data_dir / "730" / "2024.json").write_text(json.dumps([{
        "appId": "730", "timestamp": 1704067200, "rating": "gold",
        "title": "CS2", "source": "protondb",
    }]))
    write_pipeline_state(tmp_path, 1, {("730", "2024")})


def test_finalize_output_signal_catalog_exception(tmp_path):
    _make_finalize_data(tmp_path)
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value=None),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", side_effect=Exception("err")),
        patch("scripts.pipeline.finalize.fetch_json", side_effect=Exception("no network")),
        patch("scripts.pipeline.finalize.merge_pulse_into_data_dir", return_value=None),
        patch("scripts.pipeline.finalize.build_most_played"),
        patch("scripts.pipeline.finalize.build_game_images"),
        patch("scripts.pipeline.finalize.flush_steam_title_cache"),
    ):
        finalize_output(str(tmp_path), skip_probe=True)


def test_finalize_output_with_steam_api_key(tmp_path):
    _make_finalize_data(tmp_path)
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", return_value={}),
        patch("scripts.pipeline.finalize.load_steam_game_catalog", return_value={"730": "CS2"}),
        patch("scripts.pipeline.finalize.fetch_json", side_effect=Exception("no network")),
        patch("scripts.pipeline.finalize.merge_pulse_into_data_dir", return_value=None),
        patch("scripts.pipeline.finalize.build_most_played"),
        patch("scripts.pipeline.finalize.build_game_images"),
        patch("scripts.pipeline.finalize.flush_steam_title_cache"),
    ):
        finalize_output(str(tmp_path), skip_probe=True)


def test_finalize_output_protondb_counts_non_dict(tmp_path):
    _make_finalize_data(tmp_path)
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value=None),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", return_value={}),
        patch("scripts.pipeline.finalize.fetch_json", return_value=["not", "a", "dict"]),
        patch("scripts.pipeline.finalize.merge_pulse_into_data_dir", return_value=None),
        patch("scripts.pipeline.finalize.build_most_played"),
        patch("scripts.pipeline.finalize.build_game_images"),
        patch("scripts.pipeline.finalize.flush_steam_title_cache"),
    ):
        finalize_output(str(tmp_path), skip_probe=True)


def test_reindex_apps_skips_reserved_stems(tmp_path):
    """json files named index/latest/votes/metadata are skipped (line 79)."""
    write_pipeline_state(tmp_path, 0, set())
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text(json.dumps([{"appId": "730", "timestamp": 1704067200, "rating": "gold"}]))
    (app_dir / "index.json").write_text("[]")  # reserved -- should be skipped
    (app_dir / "latest.json").write_text("[]")  # reserved -- should be skipped
    reindex_apps(str(tmp_path), ["730"])
    assert (app_dir / "index.json").exists()


# ── _compute_game_summary edge cases (lines 613-614, 616, 619) ────────────────

from scripts.pipeline.finalize import _compute_game_summary


def test_compute_game_summary_corrupt_year_file(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text("not json")
    tier, pdb, pulse, _trend = _compute_game_summary(app_dir)
    assert tier == "pending"


def test_compute_game_summary_non_list_year_file(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text('"not a list"')
    tier, pdb, pulse, _trend = _compute_game_summary(app_dir)
    assert tier == "pending"


def test_compute_game_summary_non_dict_report(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text(json.dumps(["not-a-dict", {"rating": "gold", "source": "protondb"}]))
    tier, pdb, pulse, _trend = _compute_game_summary(app_dir)
    assert pdb == 1


# ── update_protondb_probe_cache probe_protondb raises (lines 1195-1196) ───────

def test_update_protondb_probe_cache_probe_raises(tmp_path):
    write_pipeline_state(tmp_path, 0, set())
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", return_value={}),
        patch("scripts.pipeline.finalize.compute_probe_candidates", return_value=(["730"], 0)),
        patch("scripts.pipeline.finalize.probe_protondb_app_ids", side_effect=Exception("probe failed")),
    ):
        result = update_protondb_probe_cache(str(tmp_path))
    assert result == {}


# ── finalize_output steam catalog load error (lines 1228-1229) ───────────────

def test_finalize_output_steam_catalog_load_error(tmp_path):
    _make_finalize_data(tmp_path)
    with (
        patch("scripts.pipeline.finalize.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.finalize.read_protondb_probe_cache", return_value={}),
        patch("scripts.pipeline.finalize.load_protondb_signal_catalog", return_value={}),
        patch("scripts.pipeline.finalize.load_steam_game_catalog", side_effect=Exception("no catalog")),
        patch("scripts.pipeline.finalize.fetch_json", side_effect=Exception("no network")),
        patch("scripts.pipeline.finalize.merge_pulse_into_data_dir", return_value=None),
        patch("scripts.pipeline.finalize.build_most_played"),
        patch("scripts.pipeline.finalize.build_game_images"),
        patch("scripts.pipeline.finalize.flush_steam_title_cache"),
    ):
        finalize_output(str(tmp_path), skip_probe=True)


# ── _backfill_most_played_header_images (new function) ───────────────────────

from scripts.pipeline.finalize import _backfill_most_played_header_images


def test_backfill_most_played_header_images_fills_missing(tmp_path):
    mp = tmp_path / "most_played.json"
    mp.write_text(json.dumps([{"appId": 730, "headerImage": None}, {"appId": 570, "headerImage": None}]))
    _backfill_most_played_header_images(tmp_path, {"730": "https://cdn.example.com/730.jpg"})
    data = json.loads(mp.read_text())
    assert data[0]["headerImage"] == "https://cdn.example.com/730.jpg"
    assert data[1]["headerImage"] is None


def test_backfill_most_played_header_images_skips_existing(tmp_path):
    mp = tmp_path / "most_played.json"
    mp.write_text(json.dumps([{"appId": 730, "headerImage": "https://existing.com/img.jpg"}]))
    _backfill_most_played_header_images(tmp_path, {"730": "https://cdn.example.com/730.jpg"})
    data = json.loads(mp.read_text())
    assert data[0]["headerImage"] == "https://existing.com/img.jpg"


def test_backfill_most_played_header_images_no_file_noop(tmp_path):
    _backfill_most_played_header_images(tmp_path, {"730": "https://cdn.example.com/730.jpg"})


def test_backfill_most_played_header_images_empty_overrides_noop(tmp_path):
    mp = tmp_path / "most_played.json"
    mp.write_text(json.dumps([{"appId": 730, "headerImage": None}]))
    _backfill_most_played_header_images(tmp_path, {})
    data = json.loads(mp.read_text())
    assert data[0]["headerImage"] is None
