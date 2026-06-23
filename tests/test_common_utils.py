import json
import subprocess
import sys
import time
from io import StringIO
from pathlib import Path
from unittest.mock import patch, MagicMock, call

import pytest
import scripts.pipeline.common as common_module
from scripts.pipeline.common import (
    set_debug,
    log,
    clone_repo,
    fetch_json,
    _scrape_steam_store_title,
    normalize_whitespace,
    infer_duration,
    count_year_bucket_files,
    fetch_steam_title_with_source,
    app_id_to_dir,
    dir_to_app_id,
    app_type_from_id,
    is_valid_app_id,
    flush_steam_title_cache,
    _load_steam_title_cache,
    _save_steam_title_cache,
)


# ── set_debug / log ───────────────────────────────────────────────────────────

def test_log_writes_to_stderr(capsys):
    log("hello world")
    captured = capsys.readouterr()
    assert "hello world" in captured.err

def test_log_debug_suppressed_when_debug_off():
    set_debug(False)
    log("debug-only msg", debug=True)
    # no assertion needed - just ensure it doesn't crash

def test_log_debug_shown_when_debug_on(capsys):
    set_debug(True)
    log("debug msg", debug=True)
    captured = capsys.readouterr()
    assert "debug msg" in captured.err
    set_debug(False)  # reset


# ── normalize_whitespace ──────────────────────────────────────────────────────

def test_normalize_strips_whitespace():
    assert normalize_whitespace("  hello  ") == "hello"

def test_normalize_non_string_returns_empty():
    assert normalize_whitespace(None) == ""
    assert normalize_whitespace(42) == ""

def test_normalize_empty_string():
    assert normalize_whitespace("") == ""


# ── infer_duration ────────────────────────────────────────────────────────────

def test_infer_duration_under_one_hour():
    assert infer_duration(30) == "underOneHour"

def test_infer_duration_one_to_four_hours():
    assert infer_duration(120) == "oneToFourHours"

def test_infer_duration_several_hours():
    assert infer_duration(500) == "severalHours"

def test_infer_duration_all_the_time():
    assert infer_duration(1000) == "allTheTime"

def test_infer_duration_zero():
    assert infer_duration(0) == "unreported"

def test_infer_duration_none():
    assert infer_duration(None) == "unreported"

def test_infer_duration_negative():
    assert infer_duration(-10) == "unreported"

def test_infer_duration_boundary_60():
    assert infer_duration(60) == "oneToFourHours"

def test_infer_duration_boundary_240():
    assert infer_duration(240) == "severalHours"

def test_infer_duration_boundary_900():
    assert infer_duration(900) == "allTheTime"


# ── count_year_bucket_files ───────────────────────────────────────────────────

def test_count_year_bucket_files_basic(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text("[]")
    (app_dir / "2024.json").write_text("[]")
    assert count_year_bucket_files(tmp_path) == 2

def test_count_year_bucket_files_skips_reserved(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text("[]")
    (app_dir / "latest.json").write_text("[]")
    (app_dir / "index.json").write_text("[]")
    (app_dir / "votes.json").write_text("[]")
    (app_dir / "metadata.json").write_text("{}")
    assert count_year_bucket_files(tmp_path) == 1

def test_count_year_bucket_files_empty(tmp_path):
    assert count_year_bucket_files(tmp_path) == 0

def test_count_year_bucket_files_multiple_apps(tmp_path):
    for app_id in ["730", "570", "440"]:
        d = tmp_path / app_id
        d.mkdir()
        (d / "2023.json").write_text("[]")
    assert count_year_bucket_files(tmp_path) == 3


# ── Steam title cache ─────────────────────────────────────────────────────────

def test_load_steam_title_cache_missing_file(tmp_path):
    common_module._steam_title_cache = None
    cache = _load_steam_title_cache(tmp_path / "nonexistent.json")
    assert cache == {}

def test_load_steam_title_cache_reads_file(tmp_path):
    common_module._steam_title_cache = None
    path = tmp_path / "cache.json"
    path.write_text(json.dumps({"730": {"title": "CS2", "source": "steam-store", "ts": 9999999999}}))
    cache = _load_steam_title_cache(path)
    assert "730" in cache
    # reset global
    common_module._steam_title_cache = None

def test_load_steam_title_cache_returns_cached_on_second_call(tmp_path):
    common_module._steam_title_cache = {"already": "loaded"}
    cache = _load_steam_title_cache(tmp_path / "any.json")
    assert cache == {"already": "loaded"}
    common_module._steam_title_cache = None

def test_load_steam_title_cache_corrupt_file(tmp_path):
    common_module._steam_title_cache = None
    path = tmp_path / "corrupt.json"
    path.write_text("not json {{{")
    cache = _load_steam_title_cache(path)
    assert cache == {}
    common_module._steam_title_cache = None

def test_save_steam_title_cache_writes_file(tmp_path):
    common_module._steam_title_cache = {"730": {"title": "CS2", "ts": 1}}
    common_module._steam_title_cache_dirty = True
    cache_path = tmp_path / "cache.json"
    _save_steam_title_cache(cache_path)
    assert cache_path.exists()
    common_module._steam_title_cache = None
    common_module._steam_title_cache_dirty = False

def test_save_steam_title_cache_skips_if_not_dirty(tmp_path):
    common_module._steam_title_cache = {"730": {"title": "CS2", "ts": 1}}
    common_module._steam_title_cache_dirty = False
    cache_path = tmp_path / "cache.json"
    _save_steam_title_cache(cache_path)
    assert not cache_path.exists()
    common_module._steam_title_cache = None

def test_flush_steam_title_cache_calls_save(tmp_path):
    common_module._steam_title_cache = {"730": {"title": "CS2", "ts": 1}}
    common_module._steam_title_cache_dirty = True
    path = tmp_path / "cache.json"
    flush_steam_title_cache(path)
    assert path.exists()
    common_module._steam_title_cache = None
    common_module._steam_title_cache_dirty = False


# ── fetch_steam_title_with_source (with mock) ─────────────────────────────────

def test_fetch_steam_title_returns_cached_fresh(tmp_path):
    now = int(time.time())
    common_module._steam_title_cache = {
        "730": {"title": "CS2", "source": "steam-store", "ts": now}
    }
    title, source = fetch_steam_title_with_source("730")
    assert title == "CS2"
    assert source == "steam-title-cache"
    common_module._steam_title_cache = None

def test_fetch_steam_title_negative_cache(tmp_path):
    now = int(time.time())
    common_module._steam_title_cache = {
        "730": {"title": "", "source": "steam-store-empty-name", "ts": now}
    }
    title, source = fetch_steam_title_with_source("730")
    assert title == ""
    common_module._steam_title_cache = None

def test_fetch_steam_title_api_success():
    common_module._steam_title_cache = {}
    api_resp = {"730": {"success": True, "data": {"name": "Counter-Strike 2"}}}
    with patch("scripts.pipeline.common.fetch_json", return_value=api_resp):
        title, source = fetch_steam_title_with_source("730")
    assert title == "Counter-Strike 2"
    assert source == "steam-store"
    common_module._steam_title_cache = None
    common_module._steam_title_cache_dirty = False

def test_fetch_steam_title_api_unsuccessful():
    common_module._steam_title_cache = {}
    api_resp = {"730": {"success": False}}
    with patch("scripts.pipeline.common.fetch_json", return_value=api_resp):
        title, source = fetch_steam_title_with_source("730")
    assert title == ""
    assert "unsuccessful" in source
    common_module._steam_title_cache = None
    common_module._steam_title_cache_dirty = False

def test_fetch_steam_title_api_error():
    common_module._steam_title_cache = {}
    with patch("scripts.pipeline.common.fetch_json", side_effect=Exception("network error")):
        title, source = fetch_steam_title_with_source("730")
    assert title == ""
    assert "error" in source
    common_module._steam_title_cache = None
    common_module._steam_title_cache_dirty = False


# ── clone_repo ────────────────────────────────────────────────────────────────

def test_clone_repo_success():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("subprocess.run", return_value=mock_result) as mock_run:
        clone_repo("https://github.com/foo/bar", "/tmp/target")
        args = mock_run.call_args[0][0]
        assert "git" in args and "clone" in args
        assert "https://github.com/foo/bar" in args

def test_clone_repo_failure_exits():
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stderr = "fatal: not a git url"
    with patch("subprocess.run", return_value=mock_result):
        with pytest.raises(SystemExit):
            clone_repo("https://invalid", "/tmp/target")


# ── fetch_json ────────────────────────────────────────────────────────────────

def test_fetch_json_success():
    payload = b'{"key": "value"}'
    mock_resp = MagicMock()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read.return_value = payload
    with patch("scripts.pipeline.common.request.urlopen", return_value=mock_resp):
        result = fetch_json("https://example.com/data.json")
    assert result == {"key": "value"}

def test_fetch_json_retries_on_failure():
    call_count = 0
    payload = b'{"ok": true}'

    def fake_urlopen(url):
        nonlocal call_count
        call_count += 1
        if call_count < 2:
            raise Exception("transient error")
        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.read.return_value = payload
        return mock_resp

    with patch("scripts.pipeline.common.request.urlopen", side_effect=fake_urlopen):
        result = fetch_json("https://example.com/data.json", retries=3)
    assert result == {"ok": True}
    assert call_count == 2

def test_fetch_json_raises_after_all_retries():
    with patch("scripts.pipeline.common.request.urlopen", side_effect=Exception("always fails")):
        with pytest.raises(Exception, match="always fails"):
            fetch_json("https://example.com/data.json", retries=2)


# ── _scrape_steam_store_title ──────────────────────────────────────────────────

def test_scrape_steam_store_title_success():
    html = b'<div class="apphub_AppName">Counter-Strike 2</div>'
    mock_resp = MagicMock()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read.return_value = html
    with patch("scripts.pipeline.common.request.urlopen", return_value=mock_resp):
        result = _scrape_steam_store_title("730")
    assert result == "Counter-Strike 2"

def test_scrape_steam_store_title_no_match():
    html = b'<html><body>No game name here</body></html>'
    mock_resp = MagicMock()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read.return_value = html
    with patch("scripts.pipeline.common.request.urlopen", return_value=mock_resp):
        result = _scrape_steam_store_title("730")
    assert result == ""

def test_scrape_steam_store_title_network_error():
    with patch("scripts.pipeline.common.request.urlopen", side_effect=Exception("timeout")):
        result = _scrape_steam_store_title("730")
    assert result == ""

def test_scrape_steam_store_title_invalid_title():
    html = b'<div class="apphub_AppName">eemmmpty</div>'
    mock_resp = MagicMock()
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read.return_value = html
    with patch("scripts.pipeline.common.request.urlopen", return_value=mock_resp):
        result = _scrape_steam_store_title("730")
    assert result == ""


# ── fetch_steam_title_with_source (scrape fallback) ───────────────────────────

def test_fetch_steam_title_api_success_empty_name_triggers_scrape():
    common_module._steam_title_cache = {}
    api_resp = {"730": {"success": True, "data": {"name": ""}}}
    with (
        patch("scripts.pipeline.common.fetch_json", return_value=api_resp),
        patch("scripts.pipeline.common._scrape_steam_store_title", return_value="Scraped Title"),
    ):
        title, source = fetch_steam_title_with_source("730")
    assert title == "Scraped Title"
    assert source == "steam-store-scrape"
    common_module._steam_title_cache = None
    common_module._steam_title_cache_dirty = False

def test_fetch_steam_title_scrape_fallback_empty():
    common_module._steam_title_cache = {}
    api_resp = {"730": {"success": True, "data": {"name": ""}}}
    with (
        patch("scripts.pipeline.common.fetch_json", return_value=api_resp),
        patch("scripts.pipeline.common._scrape_steam_store_title", return_value=""),
    ):
        title, source = fetch_steam_title_with_source("730")
    assert title == ""
    assert "empty" in source
    common_module._steam_title_cache = None
    common_module._steam_title_cache_dirty = False


# ── app_id_to_dir / dir_to_app_id / app_type_from_id / is_valid_app_id ────────

def test_app_id_to_dir_steam():
    assert app_id_to_dir("730") == "730"

def test_app_id_to_dir_gog():
    assert app_id_to_dir("gog:1234567890") == "gog_1234567890"

def test_app_id_to_dir_epic():
    assert app_id_to_dir("epic:somegame") == "epic_somegame"

def test_dir_to_app_id_steam():
    assert dir_to_app_id("730") == "730"

def test_dir_to_app_id_gog():
    assert dir_to_app_id("gog_1234567890") == "gog:1234567890"

def test_dir_to_app_id_epic():
    assert dir_to_app_id("epic_somegame") == "epic:somegame"

def test_dir_to_app_id_unknown():
    assert dir_to_app_id("unknown_dir") == "unknown_dir"

def test_app_type_from_id_steam():
    assert app_type_from_id("730") == "steam"

def test_app_type_from_id_gog():
    assert app_type_from_id("gog:1234567890") == "gog"

def test_app_type_from_id_epic():
    assert app_type_from_id("epic:game") == "epic"

def test_is_valid_app_id_steam():
    assert is_valid_app_id("730") is True

def test_is_valid_app_id_gog():
    assert is_valid_app_id("gog:1234567890") is True

def test_is_valid_app_id_epic():
    assert is_valid_app_id("epic:game") is True

def test_is_valid_app_id_invalid():
    assert is_valid_app_id("not-an-id") is False
    assert is_valid_app_id("") is False
