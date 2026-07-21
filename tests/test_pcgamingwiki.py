"""Tests for scripts/pipeline/pcgamingwiki.py (#377 slice 1).

Covers the Cargo row -> Steam-appid mapping, the two-table merge, the
enricher's column placement (14 + 15), and the fallback-to-cache-on-
network-failure branch. Cargo fetches are always mocked -- these tests
never hit the network.
"""
import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.pcgamingwiki import (
    CACHE_FILENAME,
    CARGO_LIMIT,
    _cargo_get,
    _fetch_infobox_rows,
    _fetch_os_rows,
    _first_engine,
    _first_numeric,
    _index_by_appid,
    _paginate_cargo,
    enrich_search_index_with_pcgamingwiki,
    refresh_cache,
)


def _write_index(tmp_path: Path, entries: list) -> Path:
    out = tmp_path / "search-index.json"
    out.write_text(json.dumps(entries), encoding="utf-8")
    return out


# ---- _first_numeric --------------------------------------------------------


def test_first_numeric_extracts_leading_appid():
    assert _first_numeric("42") == "42"
    assert _first_numeric("42, 43") == "42"
    assert _first_numeric("42; 43") == "42"


def test_first_numeric_skips_non_digit_tokens():
    # PCGW sometimes ships a leading "TBA" or blank -- skip until a digit token appears.
    assert _first_numeric("TBA, 500") == "500"
    assert _first_numeric("  , 7 ") == "7"


def test_first_numeric_returns_none_when_no_digits():
    assert _first_numeric("") is None
    assert _first_numeric("nope") is None
    assert _first_numeric(None) is None


# ---- _first_engine ---------------------------------------------------------


def test_first_engine_takes_first_comma_token():
    assert _first_engine("Unreal Engine 4, PhysX") == "Unreal Engine 4"
    assert _first_engine("Godot") == "Godot"


def test_first_engine_none_on_missing_or_empty():
    assert _first_engine(None) is None
    assert _first_engine("") is None
    assert _first_engine("  ") is None


# ---- _index_by_appid -------------------------------------------------------


def test_indexer_merges_infobox_and_os_by_pagename():
    infobox = [
        {"_pageName": "Foo", "Steam_AppID": "100", "Engines_used": "Unity"},
    ]
    os_rows = [
        {"_pageName": "Foo", "OS": "Windows"},
        {"_pageName": "Foo", "OS": "Linux"},
    ]
    out = _index_by_appid(infobox, os_rows)
    assert out == {"100": {"os": ["linux", "windows"], "engine": "Unity"}}


def test_indexer_drops_unknown_os_values():
    # Anything not in the whitelist (windows / os x / linux / dos) is discarded.
    infobox = [{"_pageName": "Foo", "Steam_AppID": "100", "Engines_used": "Unity"}]
    os_rows = [
        {"_pageName": "Foo", "OS": "Web"},         # unknown -> dropped
        {"_pageName": "Foo", "OS": "windows"},     # kept, already lowercase
    ]
    out = _index_by_appid(infobox, os_rows)
    assert out["100"]["os"] == ["windows"]


def test_indexer_skips_rows_without_useful_data():
    # Missing engine + missing OS -> not worth caching.
    infobox = [{"_pageName": "Bare", "Steam_AppID": "999", "Engines_used": ""}]
    out = _index_by_appid(infobox, [])
    assert out == {}


def test_indexer_handles_multi_appid_bundles():
    # PCGW encodes multi-appid bundles as "123, 456". Take the first token.
    infobox = [{"_pageName": "Bundle", "Steam_AppID": "111, 222", "Engines_used": "X"}]
    out = _index_by_appid(infobox, [])
    assert list(out.keys()) == ["111"]


def test_indexer_skips_non_dict_rows_and_missing_fields():
    infobox = [
        None,                                          # not a dict
        {"_pageName": "", "Steam_AppID": "100"},       # blank page
        {"_pageName": "Foo", "Steam_AppID": ""},       # blank appid
        {"_pageName": "Foo", "Steam_AppID": "abc", "Engines_used": "Y"},  # non-numeric
    ]
    out = _index_by_appid(infobox, [])
    assert out == {}


# ---- refresh_cache ---------------------------------------------------------


def test_refresh_cache_uses_disk_when_fresh(tmp_path):
    cache_path = tmp_path / CACHE_FILENAME
    cache_path.write_text(json.dumps({
        "fetched_at": 10 ** 12,  # far in the future so cache is always fresh
        "by_appid": {"1": {"os": ["linux"], "engine": "Godot"}},
    }))
    with (
        patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows") as m_infobox,
        patch("scripts.pipeline.pcgamingwiki._fetch_os_rows") as m_os,
    ):
        result = refresh_cache(tmp_path)
    assert result == {"1": {"os": ["linux"], "engine": "Godot"}}
    m_infobox.assert_not_called()
    m_os.assert_not_called()


def test_refresh_cache_falls_back_to_disk_on_network_failure(tmp_path):
    cache_path = tmp_path / CACHE_FILENAME
    cache_path.write_text(json.dumps({
        "fetched_at": 1,  # ancient -> refresh triggered
        "by_appid": {"9": {"os": ["windows"], "engine": None}},
    }))
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=None):
        result = refresh_cache(tmp_path)
    assert result == {"9": {"os": ["windows"], "engine": None}}


def test_refresh_cache_persists_new_data(tmp_path):
    infobox = [{"_pageName": "Foo", "Steam_AppID": "7", "Engines_used": "Godot"}]
    os_rows = [{"_pageName": "Foo", "OS": "Linux"}]
    with (
        patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox),
        patch("scripts.pipeline.pcgamingwiki._fetch_os_rows", return_value=os_rows),
    ):
        result = refresh_cache(tmp_path, force=True)
    assert result == {"7": {"os": ["linux"], "engine": "Godot"}}
    written = json.loads((tmp_path / CACHE_FILENAME).read_text())
    assert written["by_appid"] == result
    assert written["fetched_at"] > 0


# ---- enrich_search_index_with_pcgamingwiki ---------------------------------


def test_enricher_writes_columns_14_and_15(tmp_path):
    # Seed rows with existing values at cols 10-13 (owned by earlier enrichers)
    # and assert those are preserved while PGW lands at 14 + 15.
    _write_index(tmp_path, [
        ["100", "Foo", "gold", 5, 2, "steam", 2021, None, False, "", "300", "game", "broken", ["EAC"]],
        ["200", "Bar", "silver", 1, 1, "steam", None, None, False, "", None, None, None, None],
    ])
    infobox = [{"_pageName": "Foo", "Steam_AppID": "100", "Engines_used": "Unity"}]
    os_rows = [{"_pageName": "Foo", "OS": "Linux"}, {"_pageName": "Foo", "OS": "Windows"}]
    with (
        patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox),
        patch("scripts.pipeline.pcgamingwiki._fetch_os_rows", return_value=os_rows),
    ):
        enrich_search_index_with_pcgamingwiki(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    # Row 0: previous enrichers preserved, PGW at 14 + 15.
    assert written[0][10] == "300"
    assert written[0][11] == "game"
    assert written[0][12] == "broken"
    assert written[0][13] == ["EAC"]
    assert written[0][14] == ["linux", "windows"]
    assert written[0][15] == "Unity"
    # Row 1: not in PGW -> both new slots stay None.
    assert written[1][14] is None
    assert written[1][15] is None


def test_enricher_publishes_data_pcgamingwiki_json(tmp_path):
    _write_index(tmp_path, [["100", "Foo", "gold", 0, 0, "steam", None, None, False, ""]])
    infobox = [{"_pageName": "Foo", "Steam_AppID": "100", "Engines_used": "Godot"}]
    os_rows = [{"_pageName": "Foo", "OS": "Linux"}]
    with (
        patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox),
        patch("scripts.pipeline.pcgamingwiki._fetch_os_rows", return_value=os_rows),
    ):
        enrich_search_index_with_pcgamingwiki(tmp_path)
    published = json.loads((tmp_path / "pcgamingwiki.json").read_text())
    assert published == {"100": {"os": ["linux"], "engine": "Godot"}}


def test_enricher_pads_short_rows_before_writing(tmp_path):
    # 6-column row from an older pipeline run: enricher must pad to 16 so
    # cols 14 + 15 land at the right index and the in-between slots
    # (10-13, owned by other enrichers) get None.
    _write_index(tmp_path, [["100", "Foo", "gold", 5, 2, "steam"]])
    infobox = [{"_pageName": "Foo", "Steam_AppID": "100", "Engines_used": "Unity"}]
    with (
        patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox),
        patch("scripts.pipeline.pcgamingwiki._fetch_os_rows", return_value=[]),
    ):
        enrich_search_index_with_pcgamingwiki(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    assert len(written[0]) == 16
    assert written[0][10] is None
    assert written[0][11] is None
    assert written[0][12] is None
    assert written[0][13] is None
    # Empty OS list normalized to None so the frontend can check `if os` cheaply.
    assert written[0][14] is None
    assert written[0][15] == "Unity"


def test_enricher_no_op_when_index_missing(tmp_path):
    enrich_search_index_with_pcgamingwiki(tmp_path)
    assert not (tmp_path / "search-index.json").exists()


def test_enricher_no_op_on_malformed_index(tmp_path):
    # Non-list root is malformed -- do not touch the file.
    idx = tmp_path / "search-index.json"
    idx.write_text('{"not": "a list"}', encoding="utf-8")
    with (
        patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=[]),
        patch("scripts.pipeline.pcgamingwiki._fetch_os_rows", return_value=[]),
    ):
        enrich_search_index_with_pcgamingwiki(tmp_path)
    # File left untouched.
    assert json.loads(idx.read_text()) == {"not": "a list"}


# ---- _cargo_get ------------------------------------------------------------


def _fake_urlopen(body: str):
    """Context-manager fake for urllib.request.urlopen -- returns `body` on read."""
    class _Resp:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self):
            return body.encode("utf-8")
    return _Resp()


def test_cargo_get_returns_parsed_json_on_success():
    payload = '{"cargoquery": [{"title": {"_pageName": "X"}}]}'
    with patch("scripts.pipeline.pcgamingwiki.urllib.request.urlopen", return_value=_fake_urlopen(payload)):
        result = _cargo_get({"action": "cargoquery"})
    assert result == {"cargoquery": [{"title": {"_pageName": "X"}}]}


def test_cargo_get_returns_none_on_transport_failure():
    with patch("scripts.pipeline.pcgamingwiki.urllib.request.urlopen", side_effect=OSError("boom")):
        assert _cargo_get({"action": "cargoquery"}) is None


def test_cargo_get_returns_none_on_json_parse_failure():
    with patch("scripts.pipeline.pcgamingwiki.urllib.request.urlopen", return_value=_fake_urlopen("not json")):
        assert _cargo_get({"action": "cargoquery"}) is None


def test_cargo_get_returns_none_when_response_is_not_a_dict():
    with patch("scripts.pipeline.pcgamingwiki.urllib.request.urlopen", return_value=_fake_urlopen("[1, 2, 3]")):
        assert _cargo_get({"action": "cargoquery"}) is None


# ---- _paginate_cargo ------------------------------------------------------


def _cargo_page(rows: list) -> dict:
    return {"cargoquery": [{"title": r} for r in rows]}


def test_paginate_cargo_walks_multiple_pages():
    # First page returns a full page (CARGO_LIMIT rows), second returns fewer -> stop.
    full = [{"_pageName": f"P{i}", "OS": "Windows"} for i in range(CARGO_LIMIT)]
    tail = [{"_pageName": "PN", "OS": "Linux"}]
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", side_effect=[_cargo_page(full), _cargo_page(tail)]):
        out = _paginate_cargo(tables="OS", fields="_pageName,OS", where="OS IS NOT NULL")
    assert len(out) == CARGO_LIMIT + 1
    assert out[-1]["_pageName"] == "PN"


def test_paginate_cargo_stops_when_page_is_none():
    # Transport error mid-pagination returns whatever we've collected so far.
    full = [{"_pageName": "P0", "OS": "Windows"}] * CARGO_LIMIT
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", side_effect=[_cargo_page(full), None]):
        with patch("scripts.pipeline.pcgamingwiki.time.sleep"):
            out = _paginate_cargo(tables="OS", fields="_pageName,OS", where="OS IS NOT NULL")
    assert len(out) == CARGO_LIMIT


def test_paginate_cargo_stops_when_rows_missing_or_empty():
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", return_value={"cargoquery": []}):
        assert _paginate_cargo(tables="OS", fields="_pageName,OS", where="OS IS NOT NULL") == []


# ---- _fetch_infobox_rows / _fetch_os_rows ---------------------------------


def test_fetch_infobox_returns_none_on_first_page_failure():
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", return_value=None):
        assert _fetch_infobox_rows() is None


def test_fetch_infobox_returns_first_page_only_when_short():
    single = _cargo_page([{"_pageName": "Foo", "Steam_AppID": "1", "Engines_used": "X"}])
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", return_value=single):
        rows = _fetch_infobox_rows()
    assert rows == [{"_pageName": "Foo", "Steam_AppID": "1", "Engines_used": "X"}]


def test_fetch_os_rows_returns_empty_on_failure():
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", return_value=None):
        assert _fetch_os_rows() == []


def test_fetch_infobox_paginates_past_first_page():
    # First page is CARGO_LIMIT rows -> continuation kicks in.
    page1 = _cargo_page([{"_pageName": f"A{i}", "Steam_AppID": str(i)} for i in range(CARGO_LIMIT)])
    tail_page = _cargo_page([{"_pageName": "TAIL", "Steam_AppID": "9999"}])
    # `_paginate_cargo` re-fetches from offset=0, so its first page duplicates
    # what _fetch_infobox_rows already read. The helper slices off that
    # duplicate. Then it walks to the tail page.
    with (
        patch("scripts.pipeline.pcgamingwiki._cargo_get", side_effect=[page1, page1, tail_page]),
        patch("scripts.pipeline.pcgamingwiki.time.sleep"),
    ):
        rows = _fetch_infobox_rows()
    assert rows is not None
    assert rows[-1]["_pageName"] == "TAIL"
    assert len(rows) == CARGO_LIMIT + 1


# ---- _load_cache error paths ----------------------------------------------


def test_load_cache_ignores_non_dict_on_disk(tmp_path):
    (tmp_path / CACHE_FILENAME).write_text("[1, 2, 3]")
    # refresh_cache triggers _load_cache; a non-dict cache means we treat
    # it as empty and go to the network (which we stub to fail here so we
    # exercise the "empty cache after non-dict" branch).
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=None):
        assert refresh_cache(tmp_path) == {}


def test_load_cache_ignores_unreadable_file(tmp_path):
    (tmp_path / CACHE_FILENAME).write_text("not json {[")
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=None):
        assert refresh_cache(tmp_path) == {}


# ---- enrich unhappy paths --------------------------------------------------


def test_enricher_no_op_on_unreadable_index(tmp_path):
    idx = tmp_path / "search-index.json"
    idx.write_text("this is not json")
    with patch("scripts.pipeline.pcgamingwiki.refresh_cache") as m:
        enrich_search_index_with_pcgamingwiki(tmp_path)
    m.assert_not_called()


def test_enricher_skips_empty_rows(tmp_path):
    # Row that is a list but empty -> skip without erroring, do not pad.
    _write_index(tmp_path, [[], ["100", "Foo", "gold", 0, 0, "steam"]])
    infobox = [{"_pageName": "Foo", "Steam_AppID": "100", "Engines_used": "Unity"}]
    with (
        patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox),
        patch("scripts.pipeline.pcgamingwiki._fetch_os_rows", return_value=[]),
    ):
        enrich_search_index_with_pcgamingwiki(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    # Empty row untouched.
    assert written[0] == []
    # Non-empty row padded + enriched.
    assert written[1][15] == "Unity"
