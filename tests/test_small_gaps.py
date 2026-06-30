"""Tests targeting small uncovered branches across multiple modules."""
import json
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

import scripts.pipeline.common as common_module
from scripts.pipeline.common import fetch_steam_title, count_year_bucket_files
from scripts.pipeline.state import deserialize_index_keys, read_pipeline_state, write_pipeline_state


# ── fetch_steam_title (wrapper, line 64-66 in common.py) ─────────────────────

def test_fetch_steam_title_returns_string():
    now = int(time.time())
    common_module._steam_title_cache = {"730": {"title": "CS2", "source": "steam-store", "ts": now}}
    result = fetch_steam_title("730")
    assert result == "CS2"
    common_module._steam_title_cache = None


# ── count_year_bucket_files non-dir branch (line 194) ────────────────────────

def test_count_year_bucket_files_skips_non_dir(tmp_path):
    (tmp_path / "notadir.txt").write_text("x")
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text("[]")
    result = count_year_bucket_files(tmp_path)
    assert result == 1


# ── state.py: deserialize_index_keys (line 23) ───────────────────────────────

def test_deserialize_index_keys_non_list_raises():
    with pytest.raises(ValueError):
        deserialize_index_keys("not a list")


# ── state.py: read_pipeline_state no_data_app_ids (line 50) ──────────────────

def test_read_pipeline_state_includes_no_data_app_ids(tmp_path):
    write_pipeline_state(tmp_path, 0, set(), no_data_app_ids={"730"})
    state = read_pipeline_state(tmp_path)
    assert "730" in state.get("no_data_app_ids", set())


# ── most_played.py: fetch_most_played (lines 36-38) ──────────────────────────

from scripts.pipeline.most_played import fetch_most_played, build_most_played


def test_fetch_most_played_network_error():
    import urllib.error
    with patch("scripts.pipeline.most_played.urllib.request.urlopen", side_effect=urllib.error.URLError("timeout")):
        result = fetch_most_played(timeout=1)
    assert result == []

def test_fetch_most_played_returns_ranks():
    payload = {"response": {"ranks": [{"appid": 730, "peak_in_game": 100}]}}
    mock_resp = MagicMock()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read.return_value = json.dumps(payload).encode()

    import io
    class FakeResp:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def read(self): return json.dumps(payload).encode()

    with patch("scripts.pipeline.most_played.urllib.request.urlopen", return_value=FakeResp()):
        result = fetch_most_played()
    assert result[0]["appid"] == 730


# ── most_played.py: build_most_played non-int peak (line 77) ─────────────────

def test_build_most_played_skips_non_int_peak_none(tmp_path):
    (tmp_path / "search-index.json").write_text(json.dumps([["730", "CS2", "gold", 1, 0]]))
    ranks = [{"appid": 730, "peak_in_game": None}]
    result = build_most_played(tmp_path, ranks=ranks)
    assert result[0]["peak"] is None


# ── pulse.py: fetch_pulse_rows error path (lines 45-47) ─────────────────────

from scripts.pipeline.pulse import fetch_pulse_rows


def test_fetch_pulse_rows_url_error():
    import urllib.error
    with (
        patch("scripts.pipeline.pulse._resolve_credentials", return_value=("https://example.com", "token")),
        patch("scripts.pipeline.pulse.urllib.request.urlopen", side_effect=urllib.error.URLError("timeout")),
    ):
        result = fetch_pulse_rows()
    assert result == []

def test_fetch_pulse_rows_non_list_payload():
    mock_resp = MagicMock()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read.return_value = json.dumps({"not": "a list"}).encode()
    with (
        patch("scripts.pipeline.pulse._resolve_credentials", return_value=("https://example.com", "token")),
        patch("scripts.pipeline.pulse.urllib.request.urlopen", return_value=mock_resp),
    ):
        result = fetch_pulse_rows()
    assert result == []


# ── game_images.py: _url_is_ok and _fetch_steam_header (lines 53-55, 72-73) ──

from scripts.pipeline.game_images import _url_is_ok, _fetch_steam_header, build_game_images


def test_url_is_ok_success():
    mock_resp = MagicMock()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.status = 200
    with patch("scripts.pipeline.game_images.urllib.request.urlopen", return_value=mock_resp):
        assert _url_is_ok("https://example.com/img.jpg") is True

def test_url_is_ok_exception():
    with patch("scripts.pipeline.game_images.urllib.request.urlopen", side_effect=Exception("error")):
        assert _url_is_ok("https://example.com/img.jpg") is False

def test_fetch_steam_header_returns_none_on_exception():
    with patch("scripts.pipeline.game_images.urllib.request.urlopen", side_effect=Exception("network")):
        url, status = _fetch_steam_header("730", store_up=True)
    assert url is None
    assert status == "unknown"

def test_fetch_steam_header_returns_header_image():
    payload = {"730": {"success": True, "data": {"header_image": "https://cdn.example.com/img.jpg"}}}
    mock_resp = MagicMock()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read.return_value = json.dumps(payload).encode()
    with patch("scripts.pipeline.game_images.urllib.request.urlopen", return_value=mock_resp):
        url, status = _fetch_steam_header("730", store_up=True)
    assert url == "https://cdn.example.com/img.jpg"
    assert status == "live"


# ── stats.py remaining framegen branch (lines 436-440) ───────────────────────

from scripts.pipeline.stats import compute_stats


def _make_year_file(data_path, app_id, year, reports):
    app_dir = data_path / app_id
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / f"{year}.json").write_text(json.dumps(reports))


def test_stats_framegen_passes_threshold(tmp_path):
    reports = [
        {
            "rating": "gold", "source": "pulse", "timestamp": 1700000000 + i,
            "formResponses": {"requiresFramegen": "yes"}, "vramMb": 8192,
            "gpu": "", "cpu": "", "os": "", "protonVersion": "",
        }
        for i in range(3)
    ]
    _make_year_file(tmp_path, "730", "2024", reports)
    stats = compute_stats(tmp_path)
    assert len(stats.get("top_games_needing_framegen") or []) > 0


# ── state.py: read_pipeline_state FileNotFoundError (line 50) ────────────────

from scripts.pipeline.state import read_pipeline_state as _read_state


def test_read_pipeline_state_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        _read_state(tmp_path / "nonexistent")


# ── most_played.py: _last_report_date when no latest_ts (line 77) ─────────────

from scripts.pipeline.most_played import build_most_played as _build_most_played


def test_build_most_played_zero_timestamp_peak(tmp_path):
    (tmp_path / "search-index.json").write_text(json.dumps([["730", "CS2", "gold", 1, 0]]))
    app_dir = tmp_path / "data" / "730"
    app_dir.mkdir(parents=True)
    # Write year file with zero timestamps -- _last_report_date returns None
    (app_dir / "2024.json").write_text(json.dumps([{"timestamp": 0}]))
    ranks = [{"appid": 730, "peak_in_game": 50000}]
    result = _build_most_played(tmp_path, ranks=ranks)
    assert result[0]["lastReportDate"] is None


# ── pulse.py: merge_pulse_into_data_dir non-list existing branch (line 154) ───

from scripts.pipeline.pulse import merge_pulse_into_data_dir


def test_merge_pulse_non_list_existing_resets(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "730"
    app_dir.mkdir()
    year_file = app_dir / "2025.json"
    year_file.write_text('"not a list"')  # non-list content
    pulse_row = {
        "pulseId": "abc", "app_id": "730", "created_at": "2025-01-01T00:00:00Z",
        "rating": "gold", "source": "pulse",
    }
    with patch("scripts.pipeline.pulse.fetch_pulse_rows", return_value=[pulse_row]):
        merge_pulse_into_data_dir(data_dir)
    result = json.loads(year_file.read_text())
    assert isinstance(result, list)
    assert len(result) == 1


# ── stats.py: framegen yes_pct <= 0 branch (line 438) ────────────────────────

from scripts.pipeline.stats import compute_stats as _compute_stats2


def test_stats_framegen_no_yes_skipped(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    reports = [
        {
            "rating": "gold", "source": "pulse", "timestamp": 1700000000 + i,
            "formResponses": {"requiresFramegen": "no"}, "vramMb": 8192,
            "gpu": "", "cpu": "", "os": "", "protonVersion": "",
        }
        for i in range(3)
    ]
    (app_dir / "2024.json").write_text(json.dumps(reports))
    stats = _compute_stats2(tmp_path)
    top = stats.get("top_games_needing_framegen") or []
    assert all(t[0] != "730" for t in top)


# ── game_images.py: _load_cache corrupt file branch ──────────────────────────

from scripts.pipeline.game_images import _load_cache


def test_load_cache_corrupt_returns_empty(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("not json")
    result = _load_cache(bad)
    assert result == {}


# ── cli.py: no-subcommand path (lines 220-221) ────────────────────────────────

from scripts.pipeline.cli import main as cli_main


def test_cli_no_subcommand_exits(monkeypatch):
    monkeypatch.setattr("sys.argv", ["cli"])
    with pytest.raises((SystemExit, AttributeError)):
        cli_main()


# ── most_played.py: _last_report_date non-list year file (line 77) ───────────

from scripts.pipeline.most_played import build_most_played as _bmp2


def test_build_most_played_non_list_year_file(tmp_path):
    (tmp_path / "search-index.json").write_text(json.dumps([["730", "CS2", "gold", 1, 0]]))
    app_dir = tmp_path / "data" / "730"
    app_dir.mkdir(parents=True)
    (app_dir / "2024.json").write_text('"not a list"')
    ranks = [{"appid": 730, "peak_in_game": 50000}]
    result = _bmp2(tmp_path, ranks=ranks)
    assert result[0]["lastReportDate"] is None


# ── process.py: seed_official_dump_metadata missing input dir (line 154) ─────

from scripts.pipeline.process import seed_official_dump_metadata as _seed_meta


def test_seed_official_dump_metadata_missing_dir_exits(tmp_path):
    with pytest.raises(SystemExit):
        _seed_meta(str(tmp_path / "nonexistent"), str(tmp_path / "out"))


# ── process.py: tarball member where extractfile returns None (line 175) ─────

import tarfile as _tf2
import io as _io3
from scripts.pipeline.process import seed_official_dump_metadata as _seed_meta2
import scripts.pipeline.process as _proc_mod2


def test_seed_official_dump_metadata_tarball_dir_member(tmp_path, monkeypatch):
    """A tar member that is a directory causes extractfile to return None -- covered by continue."""
    import tarfile as _tf3
    input_dir = tmp_path / "input"
    input_dir.mkdir()
    tar_path = input_dir / "dump.tar.gz"
    with _tf3.open(tar_path, "w:gz") as tar:
        # Add a directory member (not a file) -- extractfile returns None for these
        info = _tf3.TarInfo(name="subdir/")
        info.type = _tf3.DIRTYPE
        tar.addfile(info)
        # Also add a valid JSON member so we don't get zero hits
        json_data = b'[{"appId":"730"}]'
        info2 = _tf3.TarInfo(name="data.json")
        info2.size = len(json_data)
        tar.addfile(info2, _io3.BytesIO(json_data))
    _proc_mod2.ijson.items.return_value = iter([{"appId": "730"}])
    _seed_meta2(str(input_dir), str(tmp_path / "out"))
    assert (tmp_path / "out" / "data" / "730" / "metadata.json").exists()
