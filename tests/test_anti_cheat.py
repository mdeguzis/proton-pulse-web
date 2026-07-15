"""Tests for scripts/pipeline/anti_cheat.py (#242).

Covers the upstream JSON -> Steam-appid mapping, the enricher's column
placement, and the fallback-to-cache-on-network-failure branch. The
upstream fetch is always mocked -- these tests never hit the network.
"""
import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.anti_cheat import (
    CACHE_FILENAME,
    _index_by_appid,
    enrich_search_index_with_anti_cheat,
    refresh_cache,
)


def _write_index(tmp_path: Path, entries: list) -> Path:
    out = tmp_path / "search-index.json"
    out.write_text(json.dumps(entries), encoding="utf-8")
    return out


# ---- _index_by_appid --------------------------------------------------------


def test_indexer_skips_rows_without_steam_id():
    rows = [
        {"name": "GOG only", "storeIds": {"gog": "123"}, "status": "Broken"},
        {"name": "Steam ok", "storeIds": {"steam": "42"}, "status": "Broken", "anticheats": ["EAC"]},
    ]
    out = _index_by_appid(rows)
    assert list(out.keys()) == ["42"]


def test_indexer_lowercases_status_and_dedupes_vendors():
    rows = [{
        "name": "Foo", "storeIds": {"steam": "1"},
        "status": "Running",
        "anticheats": ["EAC", "EAC", " BattlEye ", ""],
    }]
    out = _index_by_appid(rows)
    assert out["1"]["status"] == "running"
    assert out["1"]["vendors"] == ["BattlEye", "EAC"]


def test_indexer_drops_unknown_status():
    rows = [{"storeIds": {"steam": "1"}, "status": "MysteryBucket"}]
    assert _index_by_appid(rows) == {}


def test_indexer_handles_missing_or_wrong_types():
    rows = [
        None,  # not a dict
        {"storeIds": {"steam": ""}, "status": "Broken"},  # blank id
        {"storeIds": {}, "status": "Broken"},  # no steam key
        {"storeIds": {"steam": "5"}, "status": "Broken", "anticheats": "not a list"},
    ]
    out = _index_by_appid(rows)
    assert out == {"5": {"status": "broken", "vendors": []}}


# ---- refresh_cache ----------------------------------------------------------


def test_refresh_cache_uses_disk_when_fresh(tmp_path):
    cache_path = tmp_path / CACHE_FILENAME
    cache_path.write_text(json.dumps({
        "fetched_at": 10 ** 12,  # far in the future so cache is always fresh
        "by_appid": {"1": {"status": "broken", "vendors": ["EAC"]}},
    }))
    with patch("scripts.pipeline.anti_cheat._fetch_upstream") as m_fetch:
        result = refresh_cache(tmp_path)
    assert result == {"1": {"status": "broken", "vendors": ["EAC"]}}
    m_fetch.assert_not_called()


def test_refresh_cache_falls_back_to_disk_on_network_failure(tmp_path):
    cache_path = tmp_path / CACHE_FILENAME
    cache_path.write_text(json.dumps({
        "fetched_at": 1,  # ancient -> refresh triggered
        "by_appid": {"9": {"status": "supported", "vendors": []}},
    }))
    with patch("scripts.pipeline.anti_cheat._fetch_upstream", return_value=None):
        result = refresh_cache(tmp_path)
    assert result == {"9": {"status": "supported", "vendors": []}}


def test_refresh_cache_persists_new_upstream_data(tmp_path):
    upstream = [{"storeIds": {"steam": "7"}, "status": "Denied", "anticheats": ["Vanguard"]}]
    with patch("scripts.pipeline.anti_cheat._fetch_upstream", return_value=upstream):
        result = refresh_cache(tmp_path, force=True)
    assert result == {"7": {"status": "denied", "vendors": ["Vanguard"]}}
    # Cache file was written and can be re-read.
    written = json.loads((tmp_path / CACHE_FILENAME).read_text())
    assert written["by_appid"] == result
    assert written["fetched_at"] > 0


# ---- enrich_search_index_with_anti_cheat ------------------------------------


def test_enricher_writes_columns_10_and_11(tmp_path):
    _write_index(tmp_path, [
        ["100", "Foo", "gold", 5, 2, "steam", 2021, None, False, ""],
        ["200", "Bar", "borked", 1, 1, "steam", None, None, False, ""],
    ])
    upstream = [{"storeIds": {"steam": "100"}, "status": "Broken", "anticheats": ["EAC"]}]
    with patch("scripts.pipeline.anti_cheat._fetch_upstream", return_value=upstream):
        enrich_search_index_with_anti_cheat(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    # Row 0 got a hit
    assert written[0][10] == "broken"
    assert written[0][11] == ["EAC"]
    # Row 1 has no upstream entry -> None in both slots
    assert written[1][10] is None
    assert written[1][11] is None


def test_enricher_publishes_data_anti_cheat_json(tmp_path):
    _write_index(tmp_path, [["100", "Foo", "gold", 0, 0, "steam", None, None, False, ""]])
    upstream = [{"storeIds": {"steam": "100"}, "status": "Running", "anticheats": ["BattlEye"]}]
    with patch("scripts.pipeline.anti_cheat._fetch_upstream", return_value=upstream):
        enrich_search_index_with_anti_cheat(tmp_path)
    published = json.loads((tmp_path / "anti-cheat.json").read_text())
    assert published == {"100": {"status": "running", "vendors": ["BattlEye"]}}


def test_enricher_pads_short_rows_before_writing_columns(tmp_path):
    # 6-column row from an older pipeline run: enricher must pad to 12.
    _write_index(tmp_path, [["100", "Foo", "gold", 5, 2, "steam"]])
    upstream = [{"storeIds": {"steam": "100"}, "status": "Supported", "anticheats": []}]
    with patch("scripts.pipeline.anti_cheat._fetch_upstream", return_value=upstream):
        enrich_search_index_with_anti_cheat(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    assert len(written[0]) == 12
    assert written[0][10] == "supported"
    # Empty vendors list normalized to None so the frontend can check `if
    # vendors` cheaply.
    assert written[0][11] is None


def test_enricher_no_op_when_index_missing(tmp_path):
    # No search-index.json -> return without exploding.
    enrich_search_index_with_anti_cheat(tmp_path)
    assert not (tmp_path / "search-index.json").exists()
