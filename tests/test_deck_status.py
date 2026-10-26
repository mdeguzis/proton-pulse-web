"""Tests for the server-side Steam Deck compatibility fetch (task #37).

Valve's ajaxgetdeckappcompatibilityreport endpoint is not CORS-enabled, so the
pipeline fetches it server-side and publishes deck-status.json. These cover the
category/criteria mapping, the rate-limit-safe caching (same lesson as #185),
and the deck-status.json builder.
"""
import json
import time
from unittest.mock import patch

import pytest

import scripts.pipeline.deck_status as deck
from scripts.pipeline.deck_status import (
    build_deck_status,
    fetch_deck_compat,
    steam_app_ids_with_reports,
)


@pytest.fixture(autouse=True)
def _reset_cache(tmp_path, monkeypatch):
    deck._cache = None
    deck._cache_dirty = False
    monkeypatch.setattr(deck, "CACHE_PATH", tmp_path / "steam-deck-compat-cache.json")
    yield
    deck._cache = None
    deck._cache_dirty = False


def _verified_payload():
    return {
        "success": 1,
        "results": {
            "appid": 1245620,
            "resolved_category": 3,
            "resolved_items": [
                {"display_type": 4, "loc_token": "#...DefaultControllerConfigFullyFunctional"},
                {"display_type": 4, "loc_token": "#...ControllerGlyphsMatchDeckDevice"},
                {"display_type": 4, "loc_token": "#...InterfaceTextIsLegible"},
                {"display_type": 4, "loc_token": "#...DefaultConfigurationIsPerformant"},
            ],
        },
    }


def test_verified_game_maps_category_and_criteria():
    with patch.object(deck, "_fetch_raw", return_value=_verified_payload()) as m:
        out = fetch_deck_compat("1245620")
        assert out == {
            "status": "verified",
            "criteria": [True, True, True, True],
            "machine": "unknown",
            "steamos": "unknown",
            "machine_criteria": [],
            "steamos_criteria": [],
        }
        # second call is served from cache -- no re-fetch
        assert fetch_deck_compat("1245620") == out
        assert m.call_count == 1


def test_machine_and_steamos_per_criterion_items_captured():
    """TF2-shape payload: Deck + Machine + SteamOS all rated, with per-criterion
    resolved_items on each side. Store the machine + steamos arrays as
    [[display_type, short_token], ...] so the frontend can render a checklist
    matching Valve's own tabs."""
    payload = {
        "success": 1,
        "results": {
            "resolved_category": 2,
            "resolved_items": [
                {"display_type": 3, "loc_token": "#SteamDeckVerified_TestResult_DefaultControllerConfigNotFullyFunctional"},
                {"display_type": 3, "loc_token": "#SteamDeckVerified_TestResult_ControllerGlyphsDoNotMatchDeckDevice"},
                {"display_type": 3, "loc_token": "#SteamDeckVerified_TestResult_InterfaceTextIsNotLegible"},
                {"display_type": 4, "loc_token": "#SteamDeckVerified_TestResult_DefaultConfigurationIsPerformant"},
            ],
            "machine_resolved_category": 2,
            "machine_resolved_items": [
                {"display_type": 3, "loc_token": "#SteamMachine_TestResult_DefaultControllerConfigNotFullyFunctional"},
                {"display_type": 4, "loc_token": "#SteamMachine_TestResult_DefaultConfigurationIsPerformant"},
            ],
            "steamos_resolved_category": 2,
            "steamos_resolved_items": [
                {"display_type": 4, "loc_token": "#SteamOS_TestResult_GameStartupFunctional"},
                {"display_type": 1, "loc_token": "#SteamOS_TestResult_DefaultControllerConfigNotFullyFunctional"},
            ],
        },
    }
    with patch.object(deck, "_fetch_raw", return_value=payload):
        out = fetch_deck_compat("440")
    assert out["machine"] == "playable"
    assert out["steamos"] == "compatible"
    # Prefix stripped, display_type preserved for the frontend to render.
    assert out["machine_criteria"] == [
        [3, "DefaultControllerConfigNotFullyFunctional"],
        [4, "DefaultConfigurationIsPerformant"],
    ]
    assert out["steamos_criteria"] == [
        [4, "GameStartupFunctional"],
        [1, "DefaultControllerConfigNotFullyFunctional"],
    ]


def test_extract_criteria_handles_missing_or_bad_input():
    assert deck._extract_criteria(None, "#pfx") == []
    assert deck._extract_criteria([], "#pfx") == []
    assert deck._extract_criteria([None, "not a dict"], "#pfx") == []
    # Item with no loc_token gets an empty short_token but is still recorded.
    assert deck._extract_criteria([{"display_type": 4}], "#pfx") == [[4, ""]]
    # Token that doesn't match the prefix is left as-is (defensive).
    assert deck._extract_criteria(
        [{"display_type": 4, "loc_token": "#Other_Prefix_Something"}], "#pfx"
    ) == [[4, "#Other_Prefix_Something"]]


def test_display_type_mapping_pass_info_fail():
    payload = {
        "success": 1,
        "results": {
            "resolved_category": 2,
            "resolved_items": [
                {"display_type": 4},  # pass
                {"display_type": 3},  # info/caveat
                {"display_type": 2},  # fail
                {"display_type": 4},  # pass
            ],
        },
    }
    with patch.object(deck, "_fetch_raw", return_value=payload):
        out = fetch_deck_compat("42")
        assert out["status"] == "playable"
        assert out["criteria"] == [True, None, False, True]


def test_unknown_category_returns_none_and_is_not_written():
    payload = {"success": 1, "results": {"resolved_category": 0, "resolved_items": []}}
    with patch.object(deck, "_fetch_raw", return_value=payload):
        assert fetch_deck_compat("99999") is None


def test_success_false_returns_none():
    with patch.object(deck, "_fetch_raw", return_value={"success": 0}):
        assert fetch_deck_compat("12345") is None


def test_network_error_does_not_poison_cache(tmp_path):
    # A failed fetch must not cache a negative -- next run retries and succeeds.
    with patch.object(deck, "_fetch_raw", side_effect=OSError("429")) as m1:
        assert fetch_deck_compat("1245620") is None
        assert m1.call_count == 1
    with patch.object(deck, "_fetch_raw", return_value=_verified_payload()) as m2:
        assert fetch_deck_compat("1245620")["status"] == "verified"
        assert m2.call_count == 1


def test_steam_app_ids_scopes_to_steam_and_ranks_reported_first(tmp_path):
    """Unreported Steam games are INCLUDED, just ranked lower.

    This test used to assert that 0-report games were skipped. That was the
    bug: the scope keyed off (protondb_count + pulse_count) > 0, so when #474
    decoupled ProtonDB and zeroed every protondb_count, the fetch list
    collapsed to a handful of games and Counter-Strike 2's page claimed Valve
    had not evaluated it. Every catalog stub has a game page, so every Steam
    row is in scope; the ordering decides who gets fetched first.
    """
    rows = [
        ["480", "No reports", "", 0, 0, "steam", None, None, False],
        ["1245620", "Elden Ring", "platinum", 100, 2, "steam", None, None, False],
        ["gog:123", "GOG game", "gold", 5, 0, "gog"],   # still skipped: not Steam
    ]
    (tmp_path / "search-index.json").write_text(json.dumps(rows))
    ids = steam_app_ids_with_reports(tmp_path)
    assert ids == ["1245620", "480"]
    assert "gog:123" not in ids


def test_build_writes_only_evaluated_games(tmp_path):
    rows = [
        ["1245620", "Elden Ring", "platinum", 100, 2, "steam", None, None, False],
        ["70", "Half-Life", "gold", 10, 0, "steam", None, None, False],
    ]
    (tmp_path / "search-index.json").write_text(json.dumps(rows))

    def fake_fetch(app_id):
        # Elden Ring verified; Half-Life has no verdict (unknown -> omitted)
        return _verified_payload() if str(app_id) == "1245620" else {"success": 1, "results": {"resolved_category": 0}}

    with patch.object(deck, "_fetch_raw", side_effect=fake_fetch):
        result = build_deck_status(tmp_path)

    on_disk = json.loads((tmp_path / "deck-status.json").read_text())
    assert list(on_disk.keys()) == ["1245620"]
    assert on_disk["1245620"]["status"] == "verified"
    assert result == on_disk


def test_build_survives_verdict_reassignment_bug(tmp_path):
    """Regression guard for #273's `out` shadowing bug.

    build_deck_status used to reassign the loop-local `out` variable (originally
    the output directory Path) to the per-app entry dict. When the loop hit any
    game with a verdict, `out` became a dict and the trailing `out / "deck-status.json"`
    path build blew up with `unsupported operand type(s) for /: 'dict' and 'str'`.
    That crashed every scheduled pipeline run for a day. This test forces at
    least one verdict through the loop and asserts the file is written to disk.
    """
    rows = [
        ["1", "A", "gold", 5, 0, "steam", None, None, False],
        ["2", "B", "gold", 5, 0, "steam", None, None, False],
        ["3", "C", "gold", 5, 0, "steam", None, None, False],
    ]
    (tmp_path / "search-index.json").write_text(json.dumps(rows))
    with patch.object(deck, "_fetch_raw", return_value=_verified_payload()):
        build_deck_status(tmp_path)
    written = json.loads((tmp_path / "deck-status.json").read_text())
    assert set(written.keys()) == {"1", "2", "3"}
    for entry in written.values():
        assert entry["status"] == "verified"


# --- #258: expired entries are refreshed under a budget, not all at once ---

def _seed_cache(entries):
    """Write the on-disk cache: {app_id: (val, ts, ok)}."""
    deck.CACHE_PATH.write_text(json.dumps({k: {"val": v, "ts": ts, "ok": ok} for k, (v, ts, ok) in entries.items()}))
    deck._cache = None


def _verdict():
    return {"status": "verified", "criteria": [True, True, True, True], "machine": "unknown",
            "steamos": "unknown", "machine_criteria": [], "steamos_criteria": []}


def test_expired_entries_over_budget_keep_their_cached_verdict(tmp_path):
    # Regression: every expired entry was refetched with no limit, so a wave
    # of expiries (the 3-day negative TTL) cost 23 minutes on one night.
    long_ago = int(time.time()) - deck.CACHE_MAX_AGE_SECONDS - 60
    _seed_cache({str(i): (_verdict(), long_ago, True) for i in range(1, 6)})
    with patch.object(deck, "_fetch_raw", return_value=_verified_payload()) as fetch:
        result = build_deck_status(tmp_path, app_ids=[str(i) for i in range(1, 6)], refresh_budget=2)
    assert fetch.call_count == 2
    # All five still published: two refreshed, three served from cache.
    assert sorted(result) == ["1", "2", "3", "4", "5"]


def test_fresh_entries_cost_no_fetch_and_new_ids_ignore_the_refresh_budget(tmp_path):
    now = int(time.time())
    _seed_cache({"1": (_verdict(), now, True)})
    with patch.object(deck, "_fetch_raw", return_value=_verified_payload()) as fetch:
        result = build_deck_status(tmp_path, app_ids=["1", "2", "3"], refresh_budget=0)
    # "1" is fresh (no fetch); "2" and "3" are missing, which the scope's own
    # DECK_FETCH_BUDGET already caps, so the refresh budget does not apply.
    assert fetch.call_count == 2
    assert sorted(result) == ["1", "2", "3"]


def test_failed_refresh_keeps_the_stale_verdict(tmp_path):
    import urllib.error
    long_ago = int(time.time()) - deck.CACHE_MAX_AGE_SECONDS - 60
    _seed_cache({"1": (_verdict(), long_ago, True)})
    with patch.object(deck, "_fetch_raw", side_effect=urllib.error.URLError("timeout")):
        result = build_deck_status(tmp_path, app_ids=["1"])
    # Before, a failed refresh dropped the app from deck-status.json for the run.
    assert result["1"]["status"] == "verified"


def test_build_logs_a_cache_summary(tmp_path):
    long_ago = int(time.time()) - deck.CACHE_NEGATIVE_TTL_SECONDS - 60
    _seed_cache({"1": (None, long_ago, False), "2": (None, long_ago, False)})
    with patch.object(deck, "_fetch_raw", return_value={"success": 1, "results": {"resolved_category": 0}}), \
         patch.object(deck, "log") as log:
        build_deck_status(tmp_path, app_ids=["1", "2", "3"], refresh_budget=1)
    summary = [c.args[0] for c in log.call_args_list if "[deck-status] cache:" in c.args[0]]
    assert len(summary) == 1
    assert "1 new fetched" in summary[0]
    assert "1 expired refreshed (budget 1)" in summary[0]
    assert "1 expired still served" in summary[0]


def test_delay_only_applies_to_actual_fetches(tmp_path):
    now = int(time.time())
    _seed_cache({str(i): (_verdict(), now, True) for i in range(1, 4)})
    with patch.object(deck, "_fetch_raw", return_value=_verified_payload()), \
         patch.object(deck.time, "sleep") as sleep:
        build_deck_status(tmp_path, app_ids=["1", "2", "3", "4"], delay=0.5)
    sleep.assert_called_once_with(0.5)
