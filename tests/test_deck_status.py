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
        }
        # second call is served from cache -- no re-fetch
        assert fetch_deck_compat("1245620") == out
        assert m.call_count == 1


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


def test_steam_app_ids_with_reports_scopes_to_reported_steam_games(tmp_path):
    rows = [
        ["1245620", "Elden Ring", "platinum", 100, 2, "steam", None, None, False],
        ["480", "No reports", "", 0, 0, "steam", None, None, False],   # skipped: 0 reports
        ["gog:123", "GOG game", "gold", 5, 0, "gog"],                    # skipped: not steam
    ]
    (tmp_path / "search-index.json").write_text(json.dumps(rows))
    assert steam_app_ids_with_reports(tmp_path) == ["1245620"]


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
