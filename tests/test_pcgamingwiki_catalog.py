"""Tests for scripts/pipeline/pcgamingwiki_catalog.py (#377 slice 3).

Covers the WHERE clause + fetched-row -> catalog-entry mapping, the
merge-into-search-index behavior (add-once, no dup), and the fallback
to on-disk cache on network failure. Cargo fetches are always mocked --
these tests never hit the network.
"""
import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.pcgamingwiki_catalog import (
    CACHE_FILENAME,
    OUTPUT_FILENAME,
    _CARGO_WHERE,
    _build_entries,
    _clean_cover_url,
    _slugify_page_name,
    _split_company_list,
    _year_from_iso,
    merge_catalog_into_search_index,
    refresh_catalog,
)


def _row(page, appid=None, gogid=None, engines=None, available="Windows",
         relWin=None, developers=None, publishers=None, coverUrl=None):
    return {
        "page": page,
        "appId": appid,
        "gogId": gogid,
        "engines": engines,
        "available": available,
        "relWin": relWin,
        "developers": developers,
        "publishers": publishers,
        "coverUrl": coverUrl,
    }


def _write_index(tmp_path: Path, entries: list) -> Path:
    out = tmp_path / "search-index.json"
    out.write_text(json.dumps(entries), encoding="utf-8")
    return out


# ---- WHERE clause + small helpers -----------------------------------------


def test_where_clause_filters_steam_gog_and_requires_windows():
    # Regression guard against a schema-drift edit that would loosen the query.
    # Wrong criteria == thousands of unwanted DOS-only entries or duplicates.
    assert "Steam_AppID__full IS NULL" in _CARGO_WHERE
    assert "GOGcom_ID__full IS NULL" in _CARGO_WHERE
    assert 'Available_on HOLDS "Windows"' in _CARGO_WHERE


def test_slugify_page_name_matches_mediawiki_convention():
    # Wiki URLs replace spaces with underscores. Preserve other chars so the
    # slug is still recognizable to a human reading a URL.
    assert _slugify_page_name("The Chronicles of Riddick: Escape from Butcher Bay") == (
        "The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay"
    )
    assert _slugify_page_name("!4RC4N01D!") == "!4RC4N01D!"


def test_year_from_iso_extracts_leading_year():
    assert _year_from_iso("2004-12-03") == 2004
    assert _year_from_iso("2004") == 2004
    assert _year_from_iso(None) is None
    assert _year_from_iso("TBA") is None


def test_split_company_list_strips_company_namespace():
    field = "Company:Starbreeze Studios,Company:Tigon Studios"
    assert _split_company_list(field) == ["Starbreeze Studios", "Tigon Studios"]


def test_split_company_list_dedupes_and_handles_missing():
    assert _split_company_list("Company:Foo, Company:Foo") == ["Foo"]
    assert _split_company_list(None) == []
    assert _split_company_list("") == []


# ---- _build_entries -------------------------------------------------------


def test_build_entries_maps_riddick_shape_end_to_end():
    # This is the real Cargo payload for Riddick (confirmed via live query).
    riddick = _row(
        "The Chronicles of Riddick: Escape from Butcher Bay",
        engines="Engine:Starbreeze Engine",
        available="Windows",
        relWin="2004-12-03",
        developers="Company:Starbreeze Studios,Company:Tigon Studios",
        publishers="Company:Sierra Entertainment",
    )
    out = _build_entries([riddick])
    entry = out["pgwiki:The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay"]
    assert entry["name"] == "The Chronicles of Riddick: Escape from Butcher Bay"
    assert entry["engine"] == "Starbreeze Engine"
    assert entry["developers"] == ["Starbreeze Studios", "Tigon Studios"]
    assert entry["publishers"] == ["Sierra Entertainment"]
    assert entry["release_year"] == 2004
    assert entry["os"] == ["windows"]
    assert entry["wiki_url"].startswith("https://www.pcgamingwiki.com/wiki/The_Chronicles_of_Riddick")


def test_build_entries_skips_rows_that_ended_up_with_a_steam_id():
    # Belt-and-braces guard against Cargo schema drift that could relax our WHERE clause.
    row = _row("Half-Life 2", appid="220", available="Windows,Linux")
    assert _build_entries([row]) == {}


def test_build_entries_skips_rows_with_gog_id():
    row = _row("Some GOG game", gogid="123", available="Windows")
    assert _build_entries([row]) == {}


def test_build_entries_requires_windows_in_available_on():
    # DOS-only entries are excluded on purpose (Proton does not play DOS).
    row = _row("Old DOS game", available="DOS")
    assert _build_entries([row]) == {}


def test_build_entries_first_writer_wins_on_slug_collision():
    a = _row("Ambiguous", engines="Engine:A")
    b = _row("Ambiguous", engines="Engine:B")
    out = _build_entries([a, b])
    assert out["pgwiki:Ambiguous"]["engine"] == "A"


def test_build_entries_skips_non_dict_and_blank_pages():
    rows = [None, _row("", available="Windows"), _row("Ok", available="Windows")]
    out = _build_entries(rows)
    assert list(out.keys()) == ["pgwiki:Ok"]


# ---- refresh_catalog ------------------------------------------------------


def test_refresh_catalog_uses_disk_when_fresh(tmp_path):
    (tmp_path / CACHE_FILENAME).write_text(json.dumps({
        "fetched_at": 10 ** 12,  # far future -> always fresh
        "entries": {"pgwiki:Foo": {"name": "Foo"}},
    }))
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages") as m:
        result = refresh_catalog(tmp_path)
    assert result == {"pgwiki:Foo": {"name": "Foo"}}
    m.assert_not_called()


def test_refresh_catalog_falls_back_to_disk_on_network_failure(tmp_path):
    (tmp_path / CACHE_FILENAME).write_text(json.dumps({
        "fetched_at": 1,  # ancient
        "entries": {"pgwiki:Fallback": {"name": "Fallback"}},
    }))
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=None):
        result = refresh_catalog(tmp_path)
    assert result == {"pgwiki:Fallback": {"name": "Fallback"}}


def test_refresh_catalog_persists_new_data(tmp_path):
    rows = [_row("Foo", engines="Engine:Bar", available="Windows", relWin="2010")]
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=rows):
        result = refresh_catalog(tmp_path, force=True)
    assert "pgwiki:Foo" in result
    written = json.loads((tmp_path / CACHE_FILENAME).read_text())
    assert written["entries"] == result
    assert written["fetched_at"] > 0


# ---- merge_catalog_into_search_index --------------------------------------


def test_merge_appends_new_stub_rows_with_correct_shape(tmp_path):
    _write_index(tmp_path, [
        ["220", "Half-Life 2", "gold", 5, 2, "steam", 2004, None, False, ""],
    ])
    riddick = _row(
        "The Chronicles of Riddick: Escape from Butcher Bay",
        engines="Engine:Starbreeze Engine",
        available="Windows",
        relWin="2004-12-03",
        developers="Company:Starbreeze Studios",
        publishers="Company:Sierra Entertainment",
    )
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[riddick]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    assert len(written) == 2
    stub = written[1]
    assert stub[0] == "pgwiki:The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay"
    assert stub[1] == "The Chronicles of Riddick: Escape from Butcher Bay"
    assert stub[2] == "pending"
    assert stub[3] == 0
    assert stub[4] == 0
    assert stub[5] == "pgwiki"
    assert stub[6] == 2004
    assert stub[14] == ["windows"]
    assert stub[15] == "Starbreeze Engine"


def test_merge_skips_ids_already_in_index(tmp_path):
    _write_index(tmp_path, [
        ["pgwiki:Existing", "Existing", "pending", 0, 0, "pgwiki"],
    ])
    row = _row("Existing", available="Windows")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    assert len(written) == 1


def test_merge_publishes_catalog_json(tmp_path):
    _write_index(tmp_path, [])
    row = _row("Foo", engines="Engine:Bar", available="Windows", relWin="2010")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    published = json.loads((tmp_path / OUTPUT_FILENAME).read_text())
    assert "pgwiki:Foo" in published
    assert published["pgwiki:Foo"]["engine"] == "Bar"


def test_merge_no_op_when_index_missing(tmp_path):
    merge_catalog_into_search_index(tmp_path)
    assert not (tmp_path / "search-index.json").exists()


def test_merge_no_op_on_empty_catalog(tmp_path):
    _write_index(tmp_path, [["100", "Foo", "gold", 1, 0, "steam"]])
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    assert len(written) == 1


def test_merge_no_op_on_malformed_index(tmp_path):
    idx = tmp_path / "search-index.json"
    idx.write_text('{"not": "a list"}', encoding="utf-8")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[]):
        merge_catalog_into_search_index(tmp_path)
    assert json.loads(idx.read_text()) == {"not": "a list"}


def test_merge_no_op_on_unreadable_index(tmp_path):
    idx = tmp_path / "search-index.json"
    idx.write_text("this is not json")
    with patch("scripts.pipeline.pcgamingwiki_catalog.refresh_catalog") as m:
        merge_catalog_into_search_index(tmp_path)
    m.assert_not_called()


# ---- app_type_from_id lockstep (regression) --------------------------------


def test_clean_cover_url_accepts_pcgamingwiki_https():
    ok = "https://images.pcgamingwiki.com/9/96/foo.jpg"
    assert _clean_cover_url(ok) == ok
    # Trims whitespace.
    assert _clean_cover_url("  " + ok + "  ") == ok


def test_clean_cover_url_rejects_wrong_scheme_or_host():
    # Belt-and-braces: only the PGWiki CDN, only https.
    assert _clean_cover_url("http://images.pcgamingwiki.com/x.jpg") is None
    assert _clean_cover_url("https://evil.example.com/x.jpg") is None
    assert _clean_cover_url("data:image/png;base64,AAAA") is None
    assert _clean_cover_url("javascript:alert(1)") is None
    assert _clean_cover_url("") is None
    assert _clean_cover_url(None) is None


def test_build_entries_captures_cover_url_when_present():
    riddick = _row(
        "The Chronicles of Riddick: Escape from Butcher Bay",
        available="Windows",
        coverUrl="https://images.pcgamingwiki.com/9/96/The_Chronicles_of_Riddick_Escape_from_Butcher_Bay_cover.jpg",
    )
    out = _build_entries([riddick])
    entry = out["pgwiki:The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay"]
    assert entry["cover_url"] == "https://images.pcgamingwiki.com/9/96/The_Chronicles_of_Riddick_Escape_from_Butcher_Bay_cover.jpg"


def test_build_entries_leaves_cover_url_none_when_missing_or_off_cdn():
    a = _row("NoCover", available="Windows", coverUrl=None)
    b = _row("BadCover", available="Windows", coverUrl="http://evil/x.jpg")
    out = _build_entries([a, b])
    assert out["pgwiki:NoCover"]["cover_url"] is None
    assert out["pgwiki:BadCover"]["cover_url"] is None


def test_common_recognizes_pgwiki_prefix():
    # Slice 3 hinges on the pipeline + frontend recognizing pgwiki: IDs. If
    # this test breaks, the whole catalog gets classified as "steam" and the
    # store label / filter chip / card icon all wire up wrong.
    from scripts.pipeline.common import app_type_from_id, is_valid_app_id
    assert app_type_from_id("pgwiki:The_Chronicles_of_Riddick") == "pgwiki"
    assert is_valid_app_id("pgwiki:Any_Slug")
    # Existing prefixes unchanged.
    assert app_type_from_id("gog:12345") == "gog"
    assert app_type_from_id("epic:foo") == "epic"
    assert app_type_from_id("220") == "steam"
