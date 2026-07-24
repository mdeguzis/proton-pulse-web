"""Tests for generate_extended_steam_index (#134).

The extended index is the long-tail companion to search-index.json: every
Steam catalog entry that is NOT already in the primary index, with NO
ProtonDB-known gate. The frontend lazy-loads it only when the user opens
the grouped search results page, so the cost is paid once per session
instead of on every page load.
"""
import json
from pathlib import Path

from scripts.pipeline.finalize import generate_extended_steam_index


def _write_primary(output_path: Path, entries):
    (output_path / "search-index.json").write_text(json.dumps(entries))


def test_extended_index_emits_steam_apps_not_in_primary(tmp_path):
    """The whole point of #134: a Steam game absent from the primary index
    (because ProtonDB's curated signal export does not list it) still gets
    a searchable stub in the extended file.

    9-column shape as of #176: [id, title, tier, pdb, pulse, appType,
    releaseYear, delisted, adult] -- lines up with primary index so the
    frontend's adult filter (adult at column 8) works uniformly.
    """
    _write_primary(tmp_path, [])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"2881370": "Thank You For Your Application"},
    )
    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    assert entries == [["2881370", "Thank You For Your Application", "", 0, 0, "steam", None, None, False, ""]]


def test_extended_index_excludes_apps_already_in_primary(tmp_path):
    """No duplication between primary and extended. Primary always wins so
    the frontend can merge results by appId without ambiguity.
    """
    _write_primary(tmp_path, [["570", "Dota 2", "platinum", 10, 2, "steam"]])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"570": "Dota 2", "2881370": "Thank You For Your Application"},
    )
    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    ids = [e[0] for e in entries]
    assert ids == ["2881370"]


def test_extended_index_no_protondb_gate(tmp_path):
    """Crucial behavior change from the primary index: no ProtonDB-known
    filter. Every Steam catalog entry not already in primary gets a stub.
    """
    _write_primary(tmp_path, [])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"111": "Game A", "222": "Game B", "333": "Game C"},
    )
    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    assert len(entries) == 3
    assert {e[0] for e in entries} == {"111", "222", "333"}


def test_extended_index_skips_empty_titles(tmp_path):
    """An entry without a title is unsearchable -- skip it so we do not
    pollute the index with empty rows.
    """
    _write_primary(tmp_path, [])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"111": "Real Game", "222": "", "333": "   "},
    )
    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    ids = [e[0] for e in entries]
    # Empty string is skipped; whitespace-only title is currently allowed
    # because it has truthy length. Tighten if it ever surfaces in real data.
    assert "111" in ids
    assert "222" not in ids


def test_extended_index_noop_without_steam_catalog(tmp_path):
    """Missing steam_catalog (no STEAM_API_KEY in env) must not raise. No
    file is emitted so the frontend's optional fetch degrades to empty.
    """
    _write_primary(tmp_path, [])
    generate_extended_steam_index(tmp_path, steam_catalog=None)
    assert not (tmp_path / "search-index-steam-extended.json").exists()


def test_extended_index_handles_missing_primary_file(tmp_path):
    """Defensive: if primary is missing for any reason, still emit the
    extended file (with everything from steam_catalog). Prevents a single
    corrupt write from cascading.
    """
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"2881370": "Thank You For Your Application"},
    )
    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    assert entries == [["2881370", "Thank You For Your Application", "", 0, 0, "steam", None, None, False, ""]]


def test_extended_index_uses_same_row_shape_as_primary(tmp_path):
    """Frontend reuses renderIndexSearchResult for both files + the adult
    filter reads column 8, so columns must line up 10-wide:
    [appId, title, tier, pdbCount, pulseCount, appType, releaseYear,
    delisted, adult, trend].
    """
    _write_primary(tmp_path, [])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"111": "Some Game"},
    )
    entry = json.loads((tmp_path / "search-index-steam-extended.json").read_text())[0]
    assert len(entry) == 10
    assert entry[2] == ""       # tier
    assert entry[3] == 0        # protondbCount
    assert entry[4] == 0        # pulseCount
    assert entry[5] == "steam"  # appType
    assert entry[6] is None     # releaseYear (not tracked here)
    assert entry[7] is None     # delisted    (enriched elsewhere)
    assert entry[8] is False    # adult       (#176 gradual enrichment)


def test_extended_index_enriches_adult_flag_within_budget(tmp_path, monkeypatch):
    """#176: extended stubs that are ALREADY in the descriptor cache use
    the cached value for free. Uncached stubs get descriptor-checked up
    to PIPELINE_STUB_ADULT_ENRICH_BUDGET per run; the rest stay adult=false
    until a future run's budget catches them. Deterministic sort keeps
    the sequence stable across runs.
    """
    from unittest.mock import patch
    _write_primary(tmp_path, [])
    monkeypatch.setenv("PIPELINE_STUB_ADULT_ENRICH_BUDGET", "1")

    # Cache says 100 is adult (free hit). 200 and 300 are uncached; only
    # 200 fits the budget of 1. 300 stays adult=false this run.
    def fake_cached(app_id):
        return True if app_id == "100" else None

    def fake_fetch(app_id, force_refresh=False):
        # Only 200 should reach here (budget=1).
        assert app_id == "200"
        return True

    with patch("scripts.pipeline.finalize.is_adult_app_cached", side_effect=fake_cached), \
         patch("scripts.pipeline.finalize.is_adult_app", side_effect=fake_fetch):
        generate_extended_steam_index(
            tmp_path,
            steam_catalog={"100": "Cached Adult", "200": "Uncached Fits Budget", "300": "Uncached No Budget"},
        )

    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    by_id = {e[0]: e[8] for e in entries}
    assert by_id == {"100": True, "200": True, "300": False}


def test_extended_index_hint_matched_stubs_bypass_budget(tmp_path, monkeypatch):
    """Adult-hint titles get force-refreshed regardless of budget so a
    stubs run with budget=0 still catches obvious adult titles. Matches
    the primary-index behaviour for consistency.
    """
    from unittest.mock import patch
    _write_primary(tmp_path, [])
    monkeypatch.setenv("PIPELINE_STUB_ADULT_ENRICH_BUDGET", "0")

    def fake_fetch(app_id, force_refresh=False):
        assert force_refresh, "hint-matched stubs must force-refresh (#185 heal)"
        return True

    with patch("scripts.pipeline.finalize.is_adult_app_cached", return_value=None), \
         patch("scripts.pipeline.finalize.is_adult_app", side_effect=fake_fetch):
        generate_extended_steam_index(
            tmp_path,
            steam_catalog={"111": "Naughty Chat"},
        )

    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    assert entries[0][8] is True


def test_extended_index_sorted_by_numeric_app_id(tmp_path):
    """Since #176 the sort order is by numeric app_id (not title) so the
    gradual adult-enrichment budget pass covers stubs in a stable
    sequence across runs. Frontend still sorts results for display; this
    is a build-order-in-file guarantee.
    """
    _write_primary(tmp_path, [])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"200": "Zeta", "10": "alpha", "500": "Beta"},
    )
    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    ids = [e[0] for e in entries]
    assert ids == ["10", "200", "500"]
