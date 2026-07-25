"""Tests for the Steam catalog stub pass in generate_search_index.

Mirrors the existing GOG/Epic stub behavior: a Steam app with no local data
gets a searchable entry when it is in both the Steam catalog and the ProtonDB
known set (signal + probe). Apps outside the known set are intentionally
skipped so the index does not balloon to the full 250k+ Steam catalog.
"""
import json
from pathlib import Path

from scripts.pipeline.finalize import generate_search_index


def _data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    return d


def test_steam_stub_emitted_for_protondb_known_app(tmp_path):
    """Prey 480490 has no local data but is in steam_catalog AND in ProtonDB's
    known set. It should appear as a stub so search by name or appId finds it.
    """
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        steam_catalog={"480490": "Prey"},
        protondb_known_app_ids={"480490"},
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert entries == [["480490", "Prey", "", 0, 0, "steam", None, None, False, ""]]


def test_steam_stub_skipped_when_not_in_protondb_known_set(tmp_path):
    """A Steam app that ProtonDB has never seen (e.g. niche tool, soundtrack)
    is intentionally not stubbed -- the goal is searchable coverage, not
    indexing every app on Steam.
    """
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        steam_catalog={"999999": "Some Random Tool"},
        protondb_known_app_ids=set(),
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert entries == []


def test_steam_stub_not_emitted_when_local_data_exists(tmp_path):
    """If we already emit a real entry from index_keys/local data, the stub
    pass must not duplicate it -- seen_ids guards against that.
    """
    data = _data_dir(tmp_path)
    app_dir = data / "570"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([
        {"appId": "570", "title": "Dota 2", "rating": "Platinum", "timestamp": 1700000000,
         "duration": 60, "protonVersion": "8.0"}
    ]))
    generate_search_index(
        index_keys={("570", "2023")},
        data_output_path=data,
        output_path=tmp_path,
        steam_catalog={"570": "Dota 2"},
        protondb_known_app_ids={"570"},
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    steam_rows = [e for e in entries if e[0] == "570"]
    assert len(steam_rows) == 1  # no duplicate stub row alongside the real entry


def test_steam_stub_pass_is_noop_without_catalog(tmp_path):
    """Missing steam_catalog (no STEAM_API_KEY in env) must not raise and must
    not emit any stubs.
    """
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        protondb_known_app_ids={"480490"},  # signal exists but no catalog
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert entries == []


def test_steam_stub_pass_is_noop_without_protondb_known_set(tmp_path):
    """Without the ProtonDB known set we cannot scope the stub pass, so it
    skips entirely rather than ballooning to 250k+ entries.
    """
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        steam_catalog={"480490": "Prey", "570": "Dota 2"},
        protondb_known_app_ids=None,
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert entries == []


def test_steam_stub_skips_empty_titles(tmp_path):
    """An entry without a title is unsearchable -- skip it so we do not
    pollute the index with empty rows.
    """
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        steam_catalog={"480490": "Prey", "999999": ""},
        protondb_known_app_ids={"480490", "999999"},
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert len(entries) == 1
    assert entries[0][0] == "480490"


def test_steam_and_gog_stubs_coexist(tmp_path):
    """Both stub passes run; their entries should not collide because Steam
    ids are numeric strings and GOG ids are prefixed with 'gog:'.
    """
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        gog_catalog={"1158493447": "Prey"},
        steam_catalog={"480490": "Prey"},
        protondb_known_app_ids={"480490"},
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    ids = sorted(e[0] for e in entries)
    assert ids == ["480490", "gog:1158493447"]


def test_protondb_signal_stub_for_app_absent_from_steam_catalog(tmp_path):
    """An app that ProtonDB knows about but Steam dropped from GetAppList
    falls through the steam_catalog stub pass. The signal-catalog fallback
    picks it up using ProtonDB's stored title -- the #122 case.
    """
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        steam_catalog={},  # Steam dropped this app
        protondb_known_app_ids={"236830"},
        protondb_signal_titles={"236830": "Some Delisted Game"},
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert entries == [["236830", "Some Delisted Game", "", 0, 0, "steam", None, None, False, ""]]


def test_protondb_signal_stub_does_not_duplicate_steam_catalog_entry(tmp_path):
    """When an app is in BOTH steam_catalog and signal_titles, only one row
    -- the steam_catalog pass owns it because that is the canonical title.
    """
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        steam_catalog={"480490": "Prey"},
        protondb_known_app_ids={"480490"},
        protondb_signal_titles={"480490": "Prey (ProtonDB title)"},
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert entries == [["480490", "Prey", "", 0, 0, "steam", None, None, False, ""]]


def test_protondb_signal_stub_skips_empty_title(tmp_path):
    """Some signal-catalog entries lack a title -- still cannot stub them."""
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        steam_catalog={},
        protondb_known_app_ids={"236830"},
        protondb_signal_titles={"236830": ""},
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert entries == []


def test_protondb_signal_stub_pass_is_noop_without_signal_titles(tmp_path):
    """No signal_titles param -> no signal-catalog stub pass."""
    _data_dir(tmp_path)
    generate_search_index(
        index_keys=set(),
        data_output_path=tmp_path / "data",
        output_path=tmp_path,
        steam_catalog={"480490": "Prey"},
        protondb_known_app_ids={"480490"},
        protondb_signal_titles=None,
    )
    entries = json.loads((tmp_path / "search-index.json").read_text())
    assert entries == [["480490", "Prey", "", 0, 0, "steam", None, None, False, ""]]
