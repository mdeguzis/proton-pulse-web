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
    ID_MAP_FILENAME,
    OUTPUT_FILENAME,
    _CARGO_WHERE,
    _build_entries,
    _clean_cover_url,
    _slugify_page_name,
    _split_company_list,
    _year_from_iso,
    merge_catalog_into_search_index,
    refresh_catalog,
    slug_to_pw_id,
)

# Canonical fixture: the Riddick hash verified byte-identical across the
# Python, JS (SubtleCrypto), and SQL (pgcrypto) implementations.
RIDDICK_SLUG = "The_Chronicles_of_Riddick:_Escape_from_Butcher_Bay"
RIDDICK_PW_ID = "pw_xd71ad9b"



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


def test_where_clause_requires_windows_and_no_longer_excludes_stores():
    # #406: EVERY Windows game gets a PCGW entry (physical-copy owners need
    # somewhere to report). The old Steam/GOG exclusion must stay gone.
    assert 'Available_on HOLDS "Windows"' in _CARGO_WHERE
    assert "Steam_AppID" not in _CARGO_WHERE
    assert "GOGcom_ID" not in _CARGO_WHERE


def test_slug_to_pw_id_matches_verified_cross_language_vectors():
    # These exact outputs were verified byte-identical against the JS
    # (SubtleCrypto) and SQL (pgcrypto) implementations. If this test
    # breaks, every stored pw_ id and redirect breaks with it.
    assert slug_to_pw_id(RIDDICK_SLUG) == RIDDICK_PW_ID
    assert slug_to_pw_id(".kkrieger") == "pw_sv4bfe7j"
    assert slug_to_pw_id("0_A.D.") == "pw_0zfciqa5"
    assert slug_to_pw_id("Half-Life_2") == "pw_v04maqpz"
    assert slug_to_pw_id("\u00dcn\u00efc\u00f6d\u00e9_T\u00eetle") == "pw_vhlpoxdg"


def test_slug_to_pw_id_shape_and_determinism():
    a = slug_to_pw_id("Some_Game")
    assert a == slug_to_pw_id("Some_Game")
    assert a.startswith("pw_") and len(a) == 11
    assert a != slug_to_pw_id("Some_Game_2")


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
    entry = out[RIDDICK_PW_ID]
    assert entry["slug"] == RIDDICK_SLUG
    assert entry["name"] == "The Chronicles of Riddick: Escape from Butcher Bay"
    assert entry["engine"] == "Starbreeze Engine"
    assert entry["developers"] == ["Starbreeze Studios", "Tigon Studios"]
    assert entry["publishers"] == ["Sierra Entertainment"]
    assert entry["release_year"] == 2004
    assert entry["os"] == ["windows"]
    assert entry["wiki_url"].startswith("https://www.pcgamingwiki.com/wiki/The_Chronicles_of_Riddick")


def test_build_entries_includes_steam_and_gog_games_with_cross_refs():
    # #406: physical-copy owners report against the PCGW entry even when the
    # game is also on Steam / GOG. The store ids ride along as cross-refs.
    steam_row = _row("Half-Life 2", appid="220", available="Windows,Linux")
    gog_row = _row("Some GOG game", gogid="123", available="Windows")
    out = _build_entries([steam_row, gog_row])
    assert len(out) == 2
    hl2 = out[slug_to_pw_id("Half-Life_2")]
    assert hl2["steam_app_id"] == "220"
    assert hl2["gog_id"] is None
    gog = out[slug_to_pw_id("Some_GOG_game")]
    assert gog["gog_id"] == "123"
    assert gog["steam_app_id"] is None


def test_build_entries_requires_windows_in_available_on():
    # DOS-only entries are excluded on purpose (Proton does not play DOS).
    row = _row("Old DOS game", available="DOS")
    assert _build_entries([row]) == {}


def test_build_entries_first_writer_wins_on_slug_collision():
    a = _row("Ambiguous", engines="Engine:A")
    b = _row("Ambiguous", engines="Engine:B")
    out = _build_entries([a, b])
    assert out[slug_to_pw_id("Ambiguous")]["engine"] == "A"


def test_build_entries_skips_non_dict_and_blank_pages():
    rows = [None, _row("", available="Windows"), _row("Ok", available="Windows")]
    out = _build_entries(rows)
    assert list(out.keys()) == [slug_to_pw_id("Ok")]


# ---- refresh_catalog ------------------------------------------------------


def test_refresh_catalog_uses_disk_when_fresh(tmp_path):
    (tmp_path / CACHE_FILENAME).write_text(json.dumps({
        "fetched_at": 10 ** 12,  # far future -> always fresh
        "entries": {"pw_abcdefgh": {"name": "Foo", "slug": "Foo"}},
    }))
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages") as m:
        result = refresh_catalog(tmp_path)
    assert result == {"pw_abcdefgh": {"name": "Foo", "slug": "Foo"}}
    m.assert_not_called()


def test_refresh_catalog_migrates_legacy_pgwiki_cache_and_forces_refetch(tmp_path):
    # A pre-#406 cache is keyed pgwiki:<slug> and only holds the no-Steam
    # subset. It must re-key to pw_ ids (so a network-down fallback still
    # serves usable ids) AND read as stale so the expanded catalog fetches.
    (tmp_path / CACHE_FILENAME).write_text(json.dumps({
        "fetched_at": 10 ** 12,  # would be "fresh" without the migration
        "entries": {"pgwiki:Foo": {"name": "Foo"}},
    }))
    rows = [_row("Foo", available="Windows"), _row("Bar", available="Windows")]
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=rows):
        result = refresh_catalog(tmp_path)
    assert slug_to_pw_id("Foo") in result
    assert slug_to_pw_id("Bar") in result
    assert not any(k.startswith("pgwiki:") for k in result)


def test_refresh_catalog_falls_back_to_disk_on_network_failure(tmp_path):
    (tmp_path / CACHE_FILENAME).write_text(json.dumps({
        "fetched_at": 1,  # ancient
        "entries": {"pw_fallback": {"name": "Fallback", "slug": "Fallback"}},
    }))
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=None):
        result = refresh_catalog(tmp_path)
    assert result == {"pw_fallback": {"name": "Fallback", "slug": "Fallback"}}


def test_refresh_catalog_persists_new_data(tmp_path):
    rows = [_row("Foo", engines="Engine:Bar", available="Windows", relWin="2010")]
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=rows):
        result = refresh_catalog(tmp_path, force=True)
    assert slug_to_pw_id("Foo") in result
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
    assert stub[0] == RIDDICK_PW_ID
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
        [slug_to_pw_id("Existing"), "Existing", "pending", 0, 0, "pgwiki"],
    ])
    row = _row("Existing", available="Windows")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    assert len(written) == 1


def test_merge_drops_legacy_pgwiki_rows_and_rekeys(tmp_path):
    # #406: rows from pre-hash runs are removed so a game never shows twice
    # (once under pgwiki:<slug>, once under pw_<hash>).
    _write_index(tmp_path, [
        ["220", "Half-Life 2", "gold", 5, 2, "steam"],
        ["pgwiki:Existing", "Existing", "pending", 0, 0, "pgwiki"],
    ])
    row = _row("Existing", available="Windows")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    ids = [r[0] for r in written]
    assert ids == ["220", slug_to_pw_id("Existing")]


def test_merge_publishes_catalog_json(tmp_path):
    _write_index(tmp_path, [])
    row = _row("Foo", engines="Engine:Bar", available="Windows", relWin="2010")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    published = json.loads((tmp_path / OUTPUT_FILENAME).read_text())
    foo_id = slug_to_pw_id("Foo")
    assert foo_id in published
    assert published[foo_id]["engine"] == "Bar"
    # #406: the id map ships alongside, mapping pw_ id -> slug for redirects
    # and the Supabase remap tooling.
    id_map = json.loads((tmp_path / ID_MAP_FILENAME).read_text())
    assert id_map == {foo_id: "Foo"}


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
    entry = out[RIDDICK_PW_ID]
    assert entry["slug"] == RIDDICK_SLUG
    assert entry["cover_url"] == "https://images.pcgamingwiki.com/9/96/The_Chronicles_of_Riddick_Escape_from_Butcher_Bay_cover.jpg"


def test_build_entries_leaves_cover_url_none_when_missing_or_off_cdn():
    a = _row("NoCover", available="Windows", coverUrl=None)
    b = _row("BadCover", available="Windows", coverUrl="http://evil/x.jpg")
    out = _build_entries([a, b])
    assert out[slug_to_pw_id("NoCover")]["cover_url"] is None
    assert out[slug_to_pw_id("BadCover")]["cover_url"] is None


# ---- #434 delisted cross-check ---------------------------------------------


def test_merge_flags_rule_a_when_steam_appid_absent(tmp_path):
    """Rule A: PCGW knows a Steam appid but Steam side of index has no row
    for it. The pw_ stub lands with delisted=True + replaced_by=steam:<appid>.
    """
    _write_index(tmp_path, [])  # zero Steam rows -> every appid is absent
    row = _row("Ghost Game", appid="9999999", available="Windows")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    stub = written[0]
    assert stub[5] == "pgwiki"
    assert stub[7] is True                    # delisted col
    assert stub[10] == "steam:9999999"        # replaced_by col


def test_merge_flags_rule_b_when_steam_title_diverged(tmp_path):
    """Rule B: Steam appid IS in the index but under a title that scores
    below the Jaccard threshold. Real-world trigger: PCGW keeps 'Solo
    Leveling: Arise' pointing at appid 2373990, while Steam now lists
    'Solo Leveling: ARISE OVERDRIVE Prologue Bundle Complete' at that
    appid.
    """
    _write_index(tmp_path, [
        ["2373990", "Solo Leveling ARISE OVERDRIVE Prologue Bundle Complete", "gold", 11, 0, "steam"],
    ])
    row = _row("Solo Leveling: Arise", appid="2373990", available="Windows")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    assert len(written) == 2  # steam row stays + pw_ stub gets added
    stub = next(r for r in written if r[5] == "pgwiki")
    assert stub[7] is True
    assert stub[10] == "steam:2373990"
    # Candidates file exists + captures the divergence
    candidates = json.loads((tmp_path / "pcgw-delisted-candidates.json").read_text())
    assert len(candidates) == 1
    assert candidates[0]["pcgw_title"] == "Solo Leveling: Arise"
    assert candidates[0]["steam_app_id"] == "2373990"
    assert candidates[0]["jaccard"] <= 0.75


def test_merge_leaves_active_pcgw_entries_alone(tmp_path):
    """When PCGW's title matches Steam's current title (Jaccard >= 0.75),
    the pw_ stub stays not-delisted -- the game is still on Steam and a
    remake / rename has not happened."""
    _write_index(tmp_path, [
        ["220", "Half-Life 2", "gold", 5, 2, "steam"],
    ])
    row = _row("Half-Life 2", appid="220", available="Windows")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    stub = next(r for r in written if r[5] == "pgwiki")
    assert stub[7] is None                    # not delisted
    assert stub[10] is None                   # no replaced_by
    # No candidates file written when nothing hit Rule B
    assert not (tmp_path / "pcgw-delisted-candidates.json").exists()


def test_merge_updates_existing_pw_row_delisted_flag_in_place(tmp_path):
    """A pw_ row that landed on a previous run (before the cross-check
    shipped) must get its delisted flag re-evaluated when the merge is
    run again -- otherwise Solo Leveling: Arise (pw_v5qtvk77 already in
    the index) never picks up its Rule B flag.
    """
    pwid = slug_to_pw_id("Solo_Leveling:_Arise")
    _write_index(tmp_path, [
        # Steam side: appid 2373990 now titled OVERDRIVE (the remake).
        ["2373990", "Solo Leveling ARISE OVERDRIVE Prologue Bundle", "gold", 11, 0, "steam"],
        # pw_ row from a prior run: no delisted flag, no replaced_by.
        [pwid, "Solo Leveling: Arise", "pending", 0, 0, "pgwiki",
         2024, None, False, "", None, None, None, None, ["windows"], "Unity"],
    ])
    row = _row("Solo Leveling: Arise", appid="2373990", available="Windows")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    # Still exactly 2 rows -- no duplicate appended.
    assert len(written) == 2
    pw_row = next(r for r in written if r[5] == "pgwiki")
    # Cross-check ran on the existing row and updated the flag in place.
    assert pw_row[7] is True
    assert pw_row[10] == "steam:2373990"
    # Non-delisted fields untouched.
    assert pw_row[1] == "Solo Leveling: Arise"
    assert pw_row[6] == 2024
    assert pw_row[14] == ["windows"]


def test_merge_no_steam_appid_never_delists(tmp_path):
    """PCGW entries with no steam_app_id at all (physical CD-only games,
    for example) are never delisted -- the cross-check has nothing to
    compare against, so the pw_ stub stays neutral."""
    _write_index(tmp_path, [])
    row = _row("Physical Only Game", appid=None, available="Windows")
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[row]):
        merge_catalog_into_search_index(tmp_path)
    written = json.loads((tmp_path / "search-index.json").read_text())
    stub = written[0]
    assert stub[7] is None
    assert stub[10] is None


def test_common_recognizes_pgwiki_prefix():
    # Slice 3 hinges on the pipeline + frontend recognizing pgwiki: IDs. If
    # this test breaks, the whole catalog gets classified as "steam" and the
    # store label / filter chip / card icon all wire up wrong.
    from scripts.pipeline.common import app_type_from_id, is_valid_app_id
    assert app_type_from_id("pgwiki:The_Chronicles_of_Riddick") == "pgwiki"
    assert is_valid_app_id("pgwiki:Any_Slug")
    # #406: the short hash form classifies identically.
    assert app_type_from_id("pw_xd71ad9b") == "pgwiki"
    assert is_valid_app_id("pw_xd71ad9b")
    # Existing prefixes unchanged.
    assert app_type_from_id("gog:12345") == "gog"
    assert app_type_from_id("epic:foo") == "epic"
    assert app_type_from_id("220") == "steam"


# ---------------------------------------------------------------------------
# #497: a rejected Cargo query must not be read as an empty catalog
# ---------------------------------------------------------------------------
#
# PCGW restricted Cargo and now answers HTTP 200 with an error body:
#   {"error":{"code":"permissiondenied",
#             "info":"You don't have permission to run arbitrary Cargo queries."}}
# There is no `cargoquery` key, so _fetch_all_pages saw an empty page and
# returned [], refresh_catalog read that as a successful empty result, and
# _save_cache wrote {} over the real catalog. Every run after that repeated it
# from the now-empty cache, logging "cached 0 entries" like a normal day.


def _seeded_cache(tmp_path, n=3):
    """Write a cache that looks like a healthy previous run."""
    entries = {f"pw_test{i:04d}": {"name": f"Game {i}", "steam_app_id": str(i)} for i in range(n)}
    (tmp_path / CACHE_FILENAME).write_text(
        json.dumps({"fetched_at": 0, "entries": entries}), encoding="utf-8"
    )
    return entries


def test_rejected_query_keeps_the_existing_catalog(tmp_path):
    """A permissiondenied response must leave the cached catalog intact."""
    seeded = _seeded_cache(tmp_path)
    # _cargo_get returns None for an error payload, so pagination reports the
    # unreachable path and refresh_catalog falls back to disk.
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=None):
        out = refresh_catalog(tmp_path, force=True)
    assert out == seeded
    on_disk = json.loads((tmp_path / CACHE_FILENAME).read_text())
    assert on_disk["entries"] == seeded, "cache was overwritten despite the query failing"


def test_empty_result_does_not_wipe_a_populated_cache(tmp_path):
    """Even a 'successful' empty row list must not replace a real catalog.

    Belt and braces for the case where some future upstream change returns an
    empty page without an error key. PCGW having zero Windows games is not a
    real state, so an empty refresh is always a bug somewhere.
    """
    seeded = _seeded_cache(tmp_path)
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[]):
        out = refresh_catalog(tmp_path, force=True)
    assert out == seeded
    on_disk = json.loads((tmp_path / CACHE_FILENAME).read_text())
    assert on_disk["entries"] == seeded


def test_empty_result_is_still_written_on_a_cold_cache(tmp_path):
    """With nothing cached there is nothing to protect, so don't block a write.

    Keeps first-run behaviour unchanged -- the guard is about not destroying
    known-good data, not about refusing to ever store an empty result.
    """
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=[]):
        out = refresh_catalog(tmp_path, force=True)
    assert out == {}


def test_real_rows_still_replace_the_cache(tmp_path):
    """The guard must not freeze the catalog once it is populated."""
    _seeded_cache(tmp_path)
    rows = [{
        "page": "Half-Life 2",
        "appId": "220",
        "gogId": "",
        "engines": "Source",
        "available": "Windows",
        "relWin": "2004-11-16",
        "developers": "Valve",
        "publishers": "Valve",
        "coverUrl": "https://images.pcgamingwiki.com/x/hl2.jpg",
    }]
    with patch("scripts.pipeline.pcgamingwiki_catalog._fetch_all_pages", return_value=rows):
        out = refresh_catalog(tmp_path, force=True)
    assert len(out) == 1
    assert any(e["name"] == "Half-Life 2" for e in out.values())
