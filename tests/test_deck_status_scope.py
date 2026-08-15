"""Deck-status fetch scope (regression for the CS2 "Unknown" bug).

The scope used to be `(protondb_count + pulse_count) > 0`. That held while
ProtonDB counts populated the search index. #474 decoupled ProtonDB, every
protondb_count became 0, and the scope silently collapsed from thousands of
games to 17 -- deck-status.json shipped 16 entries for a 32k-row Steam
catalog. Nothing errored; the file wrote fine and the log reported the count
as though it were normal. Counter-Strike 2 rendered "Valve has not evaluated
this title yet" while the store page said Playable.
"""

import json

import pytest

from scripts.pipeline import deck_status as ds


@pytest.fixture(autouse=True)
def _empty_cache(monkeypatch):
    monkeypatch.setattr(ds, "_load_cache", lambda: {})


def _write_index(tmp_path, rows):
    (tmp_path / "search-index.json").write_text(json.dumps(rows), encoding="utf-8")


def test_scope_does_not_depend_on_report_counts(tmp_path):
    # The exact shape that broke: real Steam games, zero reports on all of them.
    _write_index(tmp_path, [
        ["730", "Counter-Strike 2", "pending", 0, 0, "steam"],
        ["570", "Dota 2", "pending", 0, 0, "steam"],
    ])
    ids = ds.steam_app_ids_for_deck_status(tmp_path)
    assert "730" in ids and "570" in ids


def test_reported_games_come_first(tmp_path):
    _write_index(tmp_path, [
        ["111", "No reports", "pending", 0, 0, "steam"],
        ["730", "Has a report", "gold", 0, 3, "steam"],
    ])
    ids = ds.steam_app_ids_for_deck_status(tmp_path)
    assert ids[0] == "730"


def test_most_played_outranks_the_long_tail(tmp_path):
    _write_index(tmp_path, [
        ["111", "Long tail", "pending", 0, 0, "steam"],
        ["222", "Long tail 2", "pending", 0, 0, "steam"],
        ["730", "Charting", "pending", 0, 0, "steam"],
    ])
    (tmp_path / "most_played.json").write_text(json.dumps([{"appId": "730"}]), encoding="utf-8")
    ids = ds.steam_app_ids_for_deck_status(tmp_path)
    assert ids[0] == "730"


def test_recent_reports_outrank_the_long_tail(tmp_path):
    _write_index(tmp_path, [
        ["111", "Long tail", "pending", 0, 0, "steam"],
        ["999", "Recently reported", "pending", 0, 0, "steam"],
    ])
    (tmp_path / "recent-reports.json").write_text(json.dumps([{"appId": "999"}]), encoding="utf-8")
    ids = ds.steam_app_ids_for_deck_status(tmp_path)
    assert ids[0] == "999"


def test_missing_side_files_are_not_fatal(tmp_path):
    # A finalize-only run may not have regenerated most_played.json. Absent
    # means "no priority hint", not an error.
    _write_index(tmp_path, [["730", "CS2", "pending", 0, 0, "steam"]])
    assert ds.steam_app_ids_for_deck_status(tmp_path) == ["730"]


def test_budget_caps_new_fetches(tmp_path):
    _write_index(tmp_path, [[str(i), f"G{i}", "pending", 0, 0, "steam"] for i in range(1000, 1100)])
    ids = ds.steam_app_ids_for_deck_status(tmp_path, budget=10)
    assert len(ids) == 10


def test_cached_ids_ride_along_free(tmp_path, monkeypatch):
    # A cached verdict costs no request, so it must not consume the budget --
    # otherwise the published map churns instead of accumulating.
    monkeypatch.setattr(ds, "_load_cache", lambda: {"730": {}, "570": {}})
    _write_index(tmp_path, [
        ["730", "Cached", "pending", 0, 0, "steam"],
        ["570", "Cached too", "pending", 0, 0, "steam"],
        ["111", "New", "pending", 0, 0, "steam"],
    ])
    ids = ds.steam_app_ids_for_deck_status(tmp_path, budget=1)
    assert set(ids) == {"730", "570", "111"}


def test_non_steam_and_malformed_rows_are_skipped(tmp_path):
    _write_index(tmp_path, [
        ["gog:1", "GOG game", "pending", 0, 0, "gog"],
        ["pw_abc", "PCGW game", "pending", 0, 0, "pgwiki"],
        "not a row",
        ["730"],
        ["730", "CS2", "pending", 0, 0, "steam"],
    ])
    assert ds.steam_app_ids_for_deck_status(tmp_path) == ["730"]


def test_no_duplicates_across_priority_groups(tmp_path):
    _write_index(tmp_path, [["730", "CS2", "gold", 0, 2, "steam"]])
    (tmp_path / "most_played.json").write_text(json.dumps([{"appId": "730"}]), encoding="utf-8")
    (tmp_path / "recent-reports.json").write_text(json.dumps([{"appId": "730"}]), encoding="utf-8")
    assert ds.steam_app_ids_for_deck_status(tmp_path) == ["730"]


def test_legacy_alias_still_resolves():
    # Any out-of-tree caller of the old name keeps working.
    assert ds.steam_app_ids_with_reports is ds.steam_app_ids_for_deck_status
