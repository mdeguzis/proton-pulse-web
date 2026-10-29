"""#571: admin-hidden games are dropped from the published search indexes."""
import json
import urllib.error

import pytest

from scripts.pipeline import game_hides as gh


class _Resp:
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def read(self):
        return self.body


def test_fetch_reads_only_app_id_with_anon_credentials(monkeypatch):
    monkeypatch.setattr(gh, "_resolve_credentials", lambda: ("https://sb.example/rest/v1", "anon"))
    seen = {}

    def opener(req, timeout):
        seen["url"] = req.full_url
        seen["key"] = req.get_header("Apikey")
        return _Resp(json.dumps([{"app_id": "43129"}, {"app_id": 629}, {"app_id": ""}, "junk"]).encode())

    assert gh.fetch_game_hides(opener=opener) == {"43129", "629"}
    assert seen == {"url": "https://sb.example/rest/v1/game_hides?select=app_id", "key": "anon"}


def test_fetch_raises_on_a_non_list(monkeypatch):
    monkeypatch.setattr(gh, "_resolve_credentials", lambda: ("https://sb.example/rest/v1", "anon"))
    with pytest.raises(ValueError, match="expected a list"):
        gh.fetch_game_hides(opener=lambda req, timeout: _Resp(b'{"message":"denied"}'))


def _write(tmp_path, name, ids):
    (tmp_path / name).write_text(json.dumps([[i, f"title {i}"] for i in ids]))


def _ids(tmp_path, name):
    return [r[0] for r in json.loads((tmp_path / name).read_text())]


def test_apply_drops_hidden_rows_from_both_indexes(tmp_path):
    _write(tmp_path, "search-index.json", ["10", "43129", "gog:1"])
    _write(tmp_path, "search-index-steam-extended.json", ["629", "700"])
    removed = gh.apply_game_hides(tmp_path, fetch=lambda: {"43129", "629"})
    assert removed == 2
    assert _ids(tmp_path, "search-index.json") == ["10", "gog:1"]
    assert _ids(tmp_path, "search-index-steam-extended.json") == ["700"]


def test_apply_skips_a_missing_extended_index(tmp_path):
    _write(tmp_path, "search-index.json", ["10", "43129"])
    assert gh.apply_game_hides(tmp_path, fetch=lambda: {"43129"}) == 1


def test_apply_with_no_hides_leaves_files_untouched(tmp_path):
    _write(tmp_path, "search-index.json", ["10"])
    before = (tmp_path / "search-index.json").stat().st_mtime_ns
    assert gh.apply_game_hides(tmp_path, fetch=lambda: set()) == 0
    assert (tmp_path / "search-index.json").stat().st_mtime_ns == before


def test_a_failed_fetch_warns_and_leaves_the_index_unchanged(tmp_path, monkeypatch):
    _write(tmp_path, "search-index.json", ["10", "43129"])
    logs = []
    monkeypatch.setattr(gh, "log", logs.append)

    def fetch():
        raise urllib.error.URLError("supabase down")

    assert gh.apply_game_hides(tmp_path, fetch=fetch) == 0
    assert _ids(tmp_path, "search-index.json") == ["10", "43129"]
    assert any("WARN: could not read game_hides" in m and "URLError" in m for m in logs)


def test_finalize_runs_it_after_the_extended_index_and_before_the_sync():
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "scripts/pipeline/finalize.py").read_text()
    ext = src.index("generate_extended_steam_index(output_path")
    hides = src.index("apply_game_hides(output_path)")
    sync = src.index("sync_search_index(output_path)")
    assert ext < hides < sync
