"""Tests for scripts/pipeline/pcgamingwiki.py (#377 slice 1 + hotfix).

Covers the Cargo row -> Steam-appid mapping (real schema: aliased fields,
`Available_on` platform list, `Engine:` namespace prefix), the enricher's
column placement (14 + 15), and the fallback-to-cache-on-network-failure
branch. Cargo fetches are always mocked -- these tests never hit the
network.
"""
import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.pcgamingwiki import (
    CACHE_FILENAME,
    CARGO_LIMIT,
    _all_numeric,
    _cargo_get,
    _fetch_infobox_rows,
    _first_engine,
    _first_numeric,
    _index_by_appid,
    _paginate_cargo,
    _parse_available_on,
    enrich_search_index_with_pcgamingwiki,
    refresh_cache,
)


def _write_index(tmp_path: Path, entries: list) -> Path:
    out = tmp_path / "search-index.json"
    out.write_text(json.dumps(entries), encoding="utf-8")
    return out


def _row(page: str, appid: str, engines=None, available=None) -> dict:
    """Build one unwrapped Cargo title dict matching the aliased shape."""
    return {"page": page, "appId": appid, "engines": engines, "available": available}


# ---- _first_numeric / _all_numeric ----------------------------------------


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


def test_all_numeric_returns_every_digit_token_in_order():
    # PCGW encodes multi-appid pages as "220,219, 323140" -- we want them all
    # so a lookup by any of the appids in the bundle hits the enrichment.
    assert _all_numeric("220,219, 323140, 466270") == ["220", "219", "323140", "466270"]


def test_all_numeric_dedupes():
    assert _all_numeric("1, 1, 2") == ["1", "2"]


def test_all_numeric_empty_on_missing():
    assert _all_numeric(None) == []
    assert _all_numeric("") == []
    assert _all_numeric("TBA") == []


# ---- _first_engine ---------------------------------------------------------


def test_first_engine_strips_wiki_namespace_prefix():
    # Real PCGW payload: "Engine:Source,Engine:Unity" -- keep first, drop prefix.
    assert _first_engine("Engine:Source,Engine:Unity") == "Source"
    assert _first_engine("Engine:Unreal Engine 4") == "Unreal Engine 4"


def test_first_engine_handles_unprefixed_values():
    # Defensive: if PCGW ever ships a bare engine name, keep it as-is.
    assert _first_engine("Godot") == "Godot"
    assert _first_engine("Unity, X") == "Unity"


def test_first_engine_none_on_missing_or_empty():
    assert _first_engine(None) is None
    assert _first_engine("") is None
    assert _first_engine("  ") is None
    # A row that carries only the bare prefix collapses to nothing usable.
    assert _first_engine("Engine:") is None


# ---- _parse_available_on --------------------------------------------------


def test_parse_available_on_lowercases_sorts_and_dedupes():
    # PCGW format: "Windows,OS X,Linux". Case + trim + de-dupe.
    assert _parse_available_on("Windows,OS X,Linux") == ["linux", "os x", "windows"]
    assert _parse_available_on("windows, Windows") == ["windows"]


def test_parse_available_on_filters_unknown_platforms():
    # Anything not in the whitelist (windows / os x / linux / dos) is discarded
    # so an experimental value ("Web") never surfaces without a schema review.
    assert _parse_available_on("Windows, Web, PlayStation") == ["windows"]


def test_parse_available_on_empty_on_missing():
    assert _parse_available_on(None) == []
    assert _parse_available_on("") == []


# ---- _index_by_appid -------------------------------------------------------


def test_indexer_parses_available_on_and_strips_engine_prefix():
    # Half-Life 2 shape from a real Cargo response.
    rows = [_row("Half-Life 2", "220,219, 323140", engines="Engine:Source", available="Windows,OS X,Linux")]
    out = _index_by_appid(rows)
    expected_entry = {"os": ["linux", "os x", "windows"], "engine": "Source"}
    # Every appid in the bundle inherits the page enrichment.
    assert out == {"220": expected_entry, "219": expected_entry, "323140": expected_entry}


def test_indexer_skips_rows_without_useful_data():
    # Missing engine + missing OS -> not worth caching.
    rows = [_row("Bare", "999", engines=None, available=None)]
    assert _index_by_appid(rows) == {}


def test_indexer_first_writer_wins_on_duplicate_appid():
    # Two pages could theoretically claim the same appid (bundle overlap).
    # First one wins so a lookup stays deterministic.
    rows = [
        _row("First",  "5", available="Windows"),
        _row("Second", "5", available="Linux"),
    ]
    out = _index_by_appid(rows)
    assert out == {"5": {"os": ["windows"], "engine": None}}


def test_indexer_skips_non_dict_rows_and_missing_fields():
    rows = [
        None,                                           # not a dict
        _row("", "100", available="Windows"),           # blank page
        _row("Foo", "", available="Windows"),           # blank appid
        _row("Foo", "abc", engines="Engine:Y"),         # non-numeric appid
    ]
    assert _index_by_appid(rows) == {}


# ---- refresh_cache ---------------------------------------------------------


def test_refresh_cache_uses_disk_when_fresh(tmp_path):
    cache_path = tmp_path / CACHE_FILENAME
    cache_path.write_text(json.dumps({
        "fetched_at": 10 ** 12,  # far in the future so cache is always fresh
        "by_appid": {"1": {"os": ["linux"], "engine": "Godot"}},
    }))
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows") as m_infobox:
        result = refresh_cache(tmp_path)
    assert result == {"1": {"os": ["linux"], "engine": "Godot"}}
    m_infobox.assert_not_called()


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
    infobox = [_row("Foo", "7", engines="Engine:Godot", available="Linux")]
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox):
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
    infobox = [_row("Foo", "100", engines="Engine:Unity", available="Windows,Linux")]
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox):
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
    infobox = [_row("Foo", "100", engines="Engine:Godot", available="Linux")]
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox):
        enrich_search_index_with_pcgamingwiki(tmp_path)
    published = json.loads((tmp_path / "pcgamingwiki.json").read_text())
    assert published == {"100": {"os": ["linux"], "engine": "Godot"}}


def test_enricher_pads_short_rows_before_writing(tmp_path):
    # 6-column row from an older pipeline run: enricher must pad to 16 so
    # cols 14 + 15 land at the right index and the in-between slots
    # (10-13, owned by other enrichers) get None.
    _write_index(tmp_path, [["100", "Foo", "gold", 5, 2, "steam"]])
    infobox = [_row("Foo", "100", engines="Engine:Unity")]
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox):
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
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=[]):
        enrich_search_index_with_pcgamingwiki(tmp_path)
    # File left untouched.
    assert json.loads(idx.read_text()) == {"not": "a list"}


# ---- _cargo_get ------------------------------------------------------------


def _fake_response(body: str):
    """Context-manager fake for opener.open() -- returns `body` on read."""
    class _Resp:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self):
            return body.encode("utf-8")
    return _Resp()


class _FakeOpener:
    """Stand-in for the urllib opener returned by _build_session_opener.
    Captures every call to .open() so tests can assert on the URL / Request
    args after the fact. Tests provide `responder(url_or_req) -> str` for the
    body. Returning None for the body simulates a transport error via raise.
    """
    def __init__(self, responder):
        self._responder = responder
        self.addheaders = []
        self.calls = []
    def open(self, url_or_req, timeout=None):
        self.calls.append(url_or_req)
        body = self._responder(url_or_req)
        if body is None:
            raise OSError("mocked transport error")
        return _fake_response(body)


def _mock_session(responder):
    """Patch _build_session_opener to return a _FakeOpener configured with
    the given body responder. Also resets the module-level session cache so
    the fake actually gets constructed on the next call.
    """
    from scripts.pipeline import pcgamingwiki as _pgw
    _pgw._reset_session_for_tests()
    opener = _FakeOpener(responder)
    return opener, patch("scripts.pipeline.pcgamingwiki._build_session_opener", return_value=opener)


def test_cargo_get_returns_parsed_json_on_success():
    payload = '{"cargoquery": [{"title": {"page": "X"}}]}'
    opener, patcher = _mock_session(lambda _u: payload)
    with patcher:
        result = _cargo_get({"action": "cargoquery"})
    assert result == {"cargoquery": [{"title": {"page": "X"}}]}


def test_cargo_get_sends_descriptive_user_agent():
    # MediaWiki API etiquette: every request must identify our tool. The
    # opener's addheaders list carries User-Agent; tests spy on it.
    opener, patcher = _mock_session(lambda _u: '{"cargoquery": []}')
    with patcher:
        _cargo_get({"action": "cargoquery"})
    # _build_session_opener sets a User-Agent on the opener's addheaders.
    # Since we patched _build_session_opener the addheaders on this fake
    # opener are empty -- that's fine. What we're really asserting is that
    # the module TRUSTS the opener's addheaders instead of pinning UA
    # per-request. Guard against a future edit that per-request sets UA
    # (which would bypass the session cookie plumbing).
    import scripts.pipeline.pcgamingwiki as _pgw
    # Rebuild the real opener to inspect its default headers.
    _pgw._reset_session_for_tests()
    real = _pgw._build_session_opener()
    headers = dict(real.addheaders)
    ua = headers.get("User-Agent", "")
    assert "proton-pulse-web" in ua
    assert "proton-pulse.com" in ua


def test_cargo_get_returns_none_on_transport_failure():
    opener, patcher = _mock_session(lambda _u: None)
    with patcher:
        assert _cargo_get({"action": "cargoquery"}) is None


def test_cargo_get_returns_none_on_json_parse_failure():
    opener, patcher = _mock_session(lambda _u: "not json")
    with patcher:
        assert _cargo_get({"action": "cargoquery"}) is None


def test_cargo_get_returns_none_when_response_is_not_a_dict():
    opener, patcher = _mock_session(lambda _u: "[1, 2, 3]")
    with patcher:
        assert _cargo_get({"action": "cargoquery"}) is None


def test_cargo_get_always_sends_maxlag_param():
    # #387: MediaWiki etiquette. Every request carries maxlag=5 so the
    # server can 503 us politely during high load instead of falling
    # over. Regression guard against a future edit that drops the param.
    opener, patcher = _mock_session(lambda _u: '{"cargoquery": []}')
    with patcher:
        _cargo_get({"action": "cargoquery", "tables": "Infobox_game"})
    assert len(opener.calls) == 1
    url = opener.calls[0]
    assert "maxlag=5" in url


def test_cargo_get_logs_when_server_reports_maxlag_pressure(capsys):
    # A 200 body carrying {error: {code: "maxlag"}} means the server is
    # under load. Surface it in the logs so a human eyeballing the run can
    # see why some pages came back short.
    body = json.dumps({"error": {"code": "maxlag", "info": "waiting for a slave"}})
    opener, patcher = _mock_session(lambda _u: body)
    with patcher:
        _cargo_get({"action": "cargoquery"})
    captured = capsys.readouterr()
    assert "maxlag" in captured.err


# ---- Session opener (anonymous by design; PCGamingWiki:API contract) ------


def test_build_session_opener_is_anonymous_with_contact_ua():
    # PCGW's API contract: anonymous access, descriptive User-Agent WITH
    # contact info. No credentials, no cookies, no login round-trip.
    from scripts.pipeline import pcgamingwiki as _pgw
    _pgw._reset_session_for_tests()
    opener = _pgw._build_session_opener()
    headers = dict(opener.addheaders)
    assert "proton-pulse-web" in headers["User-Agent"]
    assert "mdeguzis@gmail.com" in headers["User-Agent"]  # contact info required per PCGW API rules


def test_build_session_opener_is_memoized_across_calls():
    from scripts.pipeline import pcgamingwiki as _pgw
    _pgw._reset_session_for_tests()
    first = _pgw._build_session_opener()
    second = _pgw._build_session_opener()
    assert first is second


def test_cargo_delay_respects_pcgw_rate_limit():
    # PCGW enforces 30 req/min per IP (429 + 60s block past it). The
    # inter-request delay must keep us at or under that: >= 2.0 seconds.
    from scripts.pipeline import pcgamingwiki as _pgw
    assert _pgw.CARGO_DELAY_SEC >= 2.0


def test_cargo_get_retries_once_after_429(capsys):
    # First response 429 (rate limited), retry succeeds after cooldown.
    import urllib.error as _uerr
    from scripts.pipeline import pcgamingwiki as _pgw
    _pgw._reset_session_for_tests()
    good = json.dumps({"cargoquery": []})
    calls = {"n": 0}

    class _Resp:
        def read(self):
            return good.encode("utf-8")
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_open(url, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _uerr.HTTPError(url, 429, "Too Many Requests", None, None)
        return _Resp()

    opener = _pgw._build_session_opener()
    with patch.object(opener, "open", side_effect=fake_open), \
         patch("scripts.pipeline.pcgamingwiki.time.sleep") as slept:
        result = _pgw._cargo_get({"action": "cargoquery"})
    assert result == {"cargoquery": []}
    assert calls["n"] == 2
    slept.assert_called_once_with(_pgw.RATE_LIMIT_COOLDOWN_SEC)
    assert "429" in capsys.readouterr().err



# ---- _paginate_cargo ------------------------------------------------------


def _cargo_page(rows: list) -> dict:
    return {"cargoquery": [{"title": r} for r in rows]}


def test_paginate_cargo_walks_multiple_pages():
    # First page returns a full page (CARGO_LIMIT rows), second returns fewer -> stop.
    full = [_row(f"P{i}", str(i), available="Windows") for i in range(CARGO_LIMIT)]
    tail = [_row("PN", "9", available="Linux")]
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", side_effect=[_cargo_page(full), _cargo_page(tail)]):
        with patch("scripts.pipeline.pcgamingwiki.time.sleep"):
            out = _paginate_cargo(tables="Infobox_game", fields="foo", where="bar")
    assert len(out) == CARGO_LIMIT + 1
    assert out[-1]["page"] == "PN"


def test_paginate_cargo_stops_when_page_is_none():
    # Transport error mid-pagination returns whatever we've collected so far.
    full = [_row("P0", "1", available="Windows")] * CARGO_LIMIT
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", side_effect=[_cargo_page(full), None]):
        with patch("scripts.pipeline.pcgamingwiki.time.sleep"):
            out = _paginate_cargo(tables="Infobox_game", fields="foo", where="bar")
    assert len(out) == CARGO_LIMIT


def test_paginate_cargo_stops_when_rows_missing_or_empty():
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", return_value={"cargoquery": []}):
        assert _paginate_cargo(tables="Infobox_game", fields="foo", where="bar") == []


# ---- _fetch_infobox_rows --------------------------------------------------


def test_fetch_infobox_returns_none_on_first_page_failure():
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", return_value=None):
        assert _fetch_infobox_rows() is None


def test_fetch_infobox_returns_first_page_only_when_short():
    single = _cargo_page([_row("Foo", "1", engines="Engine:X")])
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", return_value=single):
        rows = _fetch_infobox_rows()
    assert rows == [_row("Foo", "1", engines="Engine:X")]


def test_fetch_infobox_uses_correct_field_aliases_and_bulk_where():
    # Guards against regressions to the pre-hotfix shape (Engines_used /
    # missing __full / underscored aliases).
    captured = {}
    def _spy(params):
        captured.update(params)
        return None
    with patch("scripts.pipeline.pcgamingwiki._cargo_get", side_effect=_spy):
        _fetch_infobox_rows()
    assert captured["tables"] == "Infobox_game"
    # Aliases must not start with underscore + must project the real field names.
    assert "_pageName=page" in captured["fields"]
    assert "Steam_AppID=appId" in captured["fields"]
    assert "Engines=engines" in captured["fields"]
    assert "Available_on=available" in captured["fields"]
    # Bulk WHERE uses the __full companion of the virtual list field.
    assert "Steam_AppID__full" in captured["where"]


def test_fetch_infobox_paginates_past_first_page():
    # First page is CARGO_LIMIT rows -> continuation kicks in.
    page1 = _cargo_page([_row(f"A{i}", str(i)) for i in range(CARGO_LIMIT)])
    tail_page = _cargo_page([_row("TAIL", "9999")])
    # `_paginate_cargo` re-fetches from offset=0, so its first page duplicates
    # what _fetch_infobox_rows already read. The helper slices off that
    # duplicate. Then it walks to the tail page.
    with (
        patch("scripts.pipeline.pcgamingwiki._cargo_get", side_effect=[page1, page1, tail_page]),
        patch("scripts.pipeline.pcgamingwiki.time.sleep"),
    ):
        rows = _fetch_infobox_rows()
    assert rows is not None
    assert rows[-1]["page"] == "TAIL"
    assert len(rows) == CARGO_LIMIT + 1


# ---- _load_cache error paths ----------------------------------------------


def test_load_cache_ignores_non_dict_on_disk(tmp_path):
    (tmp_path / CACHE_FILENAME).write_text("[1, 2, 3]")
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
    infobox = [_row("Foo", "100", engines="Engine:Unity")]
    with patch("scripts.pipeline.pcgamingwiki._fetch_infobox_rows", return_value=infobox):
        enrich_search_index_with_pcgamingwiki(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    # Empty row untouched.
    assert written[0] == []
    # Non-empty row padded + enriched.
    assert written[1][15] == "Unity"
