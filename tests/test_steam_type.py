"""Tests for scripts/pipeline/steam_type.py.

Covers cache-hit skipping, the search-index rewrite that lands the type in
column 11, the cap-per-run PROBE budget, and the non-game type constants
the frontend depends on. Network is mocked -- these tests never hit
Steam.
"""
import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline import steam_type
from scripts.pipeline.steam_type import (
    NON_GAME_TYPES,
    enrich_search_index_with_steam_type,
)


def _write_index(tmp_path: Path, entries: list) -> Path:
    out = tmp_path / "search-index.json"
    out.write_text(json.dumps(entries), encoding="utf-8")
    return out


def test_non_game_types_covers_valve_null_categories():
    # Steam classifies non-purchasable media as movie / series / episode
    # (Twitch-style content), plus music tracks and hardware (Index, Deck).
    # None of these can have Proton compat data -- keeping the set explicit
    # so the frontend can trust it.
    assert {"movie", "music", "series", "episode", "hardware"} <= set(NON_GAME_TYPES)


def test_missing_search_index_is_a_noop(tmp_path):
    """No file, no crash -- pipeline can run partial without this enricher."""
    with patch("scripts.pipeline.steam_type._fetch_type") as fetcher:
        enrich_search_index_with_steam_type(tmp_path)
    fetcher.assert_not_called()


def test_populates_column_11_for_steam_entries(tmp_path):
    """Steam numeric ids get their type written into column 11. Non-Steam
    ids (gog:*, epic:*) get no probe and no column touched."""
    _write_index(tmp_path, [
        ["570",    "Dota 2",            "platinum", 100, 0, "steam"],
        ["220",    "Half-Life 2",       "platinum", 500, 0, "steam"],
        ["gog:123", "Some GOG Game",    "gold",     10,  0, "gog"],
    ])

    def fake_fetch(app_id):
        return {"570": ("game", True), "220": ("game", True)}[app_id]

    with patch("scripts.pipeline.steam_type._fetch_type", side_effect=fake_fetch), \
         patch("scripts.pipeline.steam_type.time.sleep"):
        enrich_search_index_with_steam_type(tmp_path)

    out = json.loads((tmp_path / "search-index.json").read_text())
    assert out[0][11] == "game"
    assert out[1][11] == "game"
    # GOG entry untouched -- steam-type only applies to numeric Steam ids
    assert len(out[2]) == 6


def test_cache_skips_already_fetched(tmp_path):
    """Cached ids do not trigger a fetch on a subsequent run."""
    _write_index(tmp_path, [
        ["570", "Dota 2",      "platinum", 100, 0, "steam"],
        ["220", "Half-Life 2", "platinum", 500, 0, "steam"],
    ])
    (tmp_path / "steam-type-cache.json").write_text(
        json.dumps({"570": "game", "220": "game"}), encoding="utf-8"
    )
    with patch("scripts.pipeline.steam_type._fetch_type") as fetcher:
        enrich_search_index_with_steam_type(tmp_path)
    fetcher.assert_not_called()
    out = json.loads((tmp_path / "search-index.json").read_text())
    assert out[0][11] == "game"
    assert out[1][11] == "game"


def test_delisted_apps_cache_negative_result(tmp_path):
    """appdetails returning success=false caches None; search-index stays
    at its pre-existing length so no phantom column is created."""
    _write_index(tmp_path, [
        ["999999", "Delisted App", "", 0, 0, "steam"],
    ])
    # ok=True here means Steam replied "delisted" (valid negative), which
    # we cache as None so we do not re-probe it next run.
    with patch("scripts.pipeline.steam_type._fetch_type", return_value=(None, True)), \
         patch("scripts.pipeline.steam_type.time.sleep"):
        enrich_search_index_with_steam_type(tmp_path)
    cache = json.loads((tmp_path / "steam-type-cache.json").read_text())
    assert cache == {"999999": None}
    out = json.loads((tmp_path / "search-index.json").read_text())
    # Nothing to write, row keeps its original 6-column length
    assert len(out[0]) == 6


def test_dlc_and_mod_types_land_in_column_11(tmp_path):
    """DLC and mod entries land the raw string -- filtering / dropping
    is a downstream decision so downstream can inspect the value."""
    _write_index(tmp_path, [
        ["570",  "Dota 2 DLC pack", "", 0, 0, "steam"],
        ["220",  "A Steam Mod",     "", 0, 0, "steam"],
    ])

    def fake_fetch(app_id):
        return {"570": ("dlc", True), "220": ("mod", True)}[app_id]

    with patch("scripts.pipeline.steam_type._fetch_type", side_effect=fake_fetch), \
         patch("scripts.pipeline.steam_type.time.sleep"):
        enrich_search_index_with_steam_type(tmp_path)

    out = json.loads((tmp_path / "search-index.json").read_text())
    assert out[0][11] == "dlc"
    assert out[1][11] == "mod"


def test_probe_cap_limits_per_run(tmp_path, monkeypatch):
    """PROBE_CAP caps fetches per run; overflow entries are picked up
    on the next run once the cache-lookup path filters them out."""
    monkeypatch.setattr(steam_type, "PROBE_CAP", 2)
    _write_index(tmp_path, [
        ["100", "One",   "", 0, 0, "steam"],
        ["200", "Two",   "", 0, 0, "steam"],
        ["300", "Three", "", 0, 0, "steam"],
        ["400", "Four",  "", 0, 0, "steam"],
    ])
    fetch_calls: list[str] = []

    def fake_fetch(app_id):
        fetch_calls.append(app_id)
        return "game", True

    with patch("scripts.pipeline.steam_type._fetch_type", side_effect=fake_fetch), \
         patch("scripts.pipeline.steam_type.time.sleep"):
        enrich_search_index_with_steam_type(tmp_path)

    # Only the first two entries were probed this run
    assert len(fetch_calls) == 2
    cache = json.loads((tmp_path / "steam-type-cache.json").read_text())
    assert set(cache.keys()) == {"100", "200"}


def test_consecutive_failures_short_circuit(tmp_path, monkeypatch):
    """When Steam is rate-limiting, N failed probes in a row should stop
    the enricher instead of chewing through the full budget."""
    monkeypatch.setattr(steam_type, "CONSECUTIVE_FAILURE_LIMIT", 3)
    monkeypatch.setattr(steam_type, "CACHE_SAVE_EVERY", 100)
    _write_index(tmp_path, [
        ["100", "One",   "", 0, 0, "steam"],
        ["200", "Two",   "", 0, 0, "steam"],
        ["300", "Three", "", 0, 0, "steam"],
        ["400", "Four",  "", 0, 0, "steam"],
        ["500", "Five",  "", 0, 0, "steam"],
    ])
    calls = []

    def fake_fetch(app_id):
        calls.append(app_id)
        return None, False  # transport failure every time

    with patch("scripts.pipeline.steam_type._fetch_type", side_effect=fake_fetch), \
         patch("scripts.pipeline.steam_type.time.sleep"):
        enrich_search_index_with_steam_type(tmp_path)

    # Only the failure limit's worth were attempted; nothing after that.
    assert len(calls) == 3
    # No successful writes, so the cache should still be empty.
    cache_path = tmp_path / "steam-type-cache.json"
    if cache_path.exists():
        assert json.loads(cache_path.read_text()) == {}


def test_successful_probe_resets_consecutive_failures(tmp_path, monkeypatch):
    """A single good probe in the middle of a bad streak should keep the
    enricher going -- we only bail on a truly sustained failure streak."""
    monkeypatch.setattr(steam_type, "CONSECUTIVE_FAILURE_LIMIT", 3)
    monkeypatch.setattr(steam_type, "CACHE_SAVE_EVERY", 100)
    _write_index(tmp_path, [
        ["100", "One",   "", 0, 0, "steam"],
        ["200", "Two",   "", 0, 0, "steam"],
        ["300", "Three", "", 0, 0, "steam"],
        ["400", "Four",  "", 0, 0, "steam"],
        ["500", "Five",  "", 0, 0, "steam"],
    ])

    # fail, fail, success (resets), fail, fail -- 5 probes, no bail
    outcomes = [
        (None, False),
        (None, False),
        ("game", True),
        (None, False),
        (None, False),
    ]
    calls = []

    def fake_fetch(app_id):
        calls.append(app_id)
        return outcomes.pop(0)

    with patch("scripts.pipeline.steam_type._fetch_type", side_effect=fake_fetch), \
         patch("scripts.pipeline.steam_type.time.sleep"):
        enrich_search_index_with_steam_type(tmp_path)

    assert len(calls) == 5


def test_wall_clock_budget_bails_out(tmp_path, monkeypatch):
    """When the wall-clock budget elapses mid-run, the enricher should bail
    even if not every failure was consecutive."""
    monkeypatch.setattr(steam_type, "WALL_CLOCK_BUDGET_SEC", 0)  # instant bail
    monkeypatch.setattr(steam_type, "CACHE_SAVE_EVERY", 100)
    _write_index(tmp_path, [
        ["100", "One", "", 0, 0, "steam"],
        ["200", "Two", "", 0, 0, "steam"],
    ])
    calls = []

    def fake_fetch(app_id):
        calls.append(app_id)
        return "game", True

    with patch("scripts.pipeline.steam_type._fetch_type", side_effect=fake_fetch), \
         patch("scripts.pipeline.steam_type.time.sleep"):
        enrich_search_index_with_steam_type(tmp_path)

    # Wall clock already past, no probes attempted
    assert len(calls) == 0


def test_incremental_cache_survives_mid_run_bail(tmp_path, monkeypatch):
    """Cache is persisted every CACHE_SAVE_EVERY probes so a cancelled run
    does not lose the work already done. Simulate a run that succeeds a
    few times and then bails on consecutive failures; the successful
    entries should still be present in the on-disk cache."""
    monkeypatch.setattr(steam_type, "CACHE_SAVE_EVERY", 1)
    monkeypatch.setattr(steam_type, "CONSECUTIVE_FAILURE_LIMIT", 2)
    _write_index(tmp_path, [
        ["100", "One",   "", 0, 0, "steam"],
        ["200", "Two",   "", 0, 0, "steam"],
        ["300", "Three", "", 0, 0, "steam"],
        ["400", "Four",  "", 0, 0, "steam"],
        ["500", "Five",  "", 0, 0, "steam"],
    ])
    outcomes = [
        ("game", True),   # 100 -> success
        ("dlc", True),    # 200 -> success
        (None, False),    # 300 -> transport fail #1
        (None, False),    # 400 -> transport fail #2 -> bail
    ]

    def fake_fetch(app_id):
        return outcomes.pop(0)

    with patch("scripts.pipeline.steam_type._fetch_type", side_effect=fake_fetch), \
         patch("scripts.pipeline.steam_type.time.sleep"):
        enrich_search_index_with_steam_type(tmp_path)

    cache_path = tmp_path / "steam-type-cache.json"
    cache = json.loads(cache_path.read_text())
    # The two successful probes made it into the on-disk cache before we
    # bailed on the consecutive failures. 500 was never touched.
    assert cache.get("100") == "game"
    assert cache.get("200") == "dlc"
    assert "500" not in cache
