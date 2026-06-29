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
    """
    _write_primary(tmp_path, [])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"2881370": "Thank You For Your Application"},
    )
    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    assert entries == [["2881370", "Thank You For Your Application", "", 0, 0, "steam"]]


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
    assert entries == [["2881370", "Thank You For Your Application", "", 0, 0, "steam"]]


def test_extended_index_uses_same_row_shape_as_primary(tmp_path):
    """Frontend reuses renderIndexSearchResult for both files, so columns
    must line up: [appId, title, tier, pdbCount, pulseCount, appType].
    """
    _write_primary(tmp_path, [])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"111": "Some Game"},
    )
    entry = json.loads((tmp_path / "search-index-steam-extended.json").read_text())[0]
    assert len(entry) == 6
    assert entry[2] == ""      # tier
    assert entry[3] == 0       # protondbCount
    assert entry[4] == 0       # pulseCount
    assert entry[5] == "steam" # appType


def test_extended_index_sorted_by_title_case_insensitive(tmp_path):
    """Sort order matches the primary's stub passes for predictable diffs."""
    _write_primary(tmp_path, [])
    generate_extended_steam_index(
        tmp_path,
        steam_catalog={"1": "Zeta", "2": "alpha", "3": "Beta"},
    )
    entries = json.loads((tmp_path / "search-index-steam-extended.json").read_text())
    titles = [e[1] for e in entries]
    assert titles == ["alpha", "Beta", "Zeta"]
