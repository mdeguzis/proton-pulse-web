"""Tests for Steam content-descriptor fetching + caching used by the
adult-games hide-by-default feature.

The pipeline attaches `adult: true` to a row whenever Steam's appdetails
response for that app includes any of ADULT_DESCRIPTOR_IDS (1, 3, 4).
The frontend hides those rows unless the user opts in via the site
options "Show adult games" toggle.
"""
import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

import scripts.pipeline.common as common_module
from scripts.pipeline.common import (
    ADULT_DESCRIPTOR_IDS,
    fetch_steam_content_descriptors,
    is_adult_app,
    flush_steam_descriptors_cache,
)


@pytest.fixture(autouse=True)
def _reset_descriptor_cache(tmp_path, monkeypatch):
    """Isolate each test with a fresh cache path + in-memory state."""
    common_module._steam_descriptors_cache = None
    common_module._steam_descriptors_cache_dirty = False
    cache = tmp_path / "steam-content-descriptors-cache.json"
    monkeypatch.setattr(
        common_module,
        "DEFAULT_STEAM_DESCRIPTORS_CACHE_PATH",
        cache,
    )
    yield cache
    common_module._steam_descriptors_cache = None
    common_module._steam_descriptors_cache_dirty = False


def test_adult_descriptor_ids_covers_the_three_relevant_flags():
    # Steam publishes these IDs for nudity / sexual content descriptors.
    # 1 = some, 3 = adult only, 4 = frequent. ID 5 is "General Mature
    # Content" (CS2 / DBD / Rust get it) -- NOT adult, do not include.
    # ID 2 is violence/gore. Adding a new ID is a conscious edit here.
    assert ADULT_DESCRIPTOR_IDS == {1, 3, 4}


def test_fetch_returns_empty_list_when_appdetails_is_unsuccessful():
    with patch(
        "scripts.pipeline.common.fetch_json",
        return_value={"12345": {"success": False}},
    ):
        assert fetch_steam_content_descriptors("12345") == []


def test_fetch_returns_ids_when_present_and_caches_them(_reset_descriptor_cache):
    payload = {
        "12345": {
            "success": True,
            "data": {"content_descriptors": {"ids": [1, 4], "notes": "..."}},
        },
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload) as m:
        assert fetch_steam_content_descriptors("12345") == [1, 4]
        # Second call hits the in-memory cache -- no additional network fetch.
        assert fetch_steam_content_descriptors("12345") == [1, 4]
        assert m.call_count == 1


def test_fetch_survives_a_network_exception_and_returns_empty():
    with patch(
        "scripts.pipeline.common.fetch_json",
        side_effect=RuntimeError("network"),
    ):
        assert fetch_steam_content_descriptors("12345") == []


def test_is_adult_app_true_when_any_adult_id_is_present():
    payload = {
        "77777": {
            "success": True,
            "data": {"content_descriptors": {"ids": [2, 4]}},
        },
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload):
        # 4 (frequent nudity) is in ADULT_DESCRIPTOR_IDS -> adult; 2 (violence) is not.
        assert is_adult_app("77777") is True


def test_is_adult_app_false_when_only_mature_content_id_5_present():
    # ID 5 = "General Mature Content" (M-rated games like CS2, Rust, DBD).
    # NOT filtered -- those are mainstream titles the user wants to see.
    payload = {
        "cs2": {
            "success": True,
            "data": {"content_descriptors": {"ids": [2, 5]}},
        },
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload):
        assert is_adult_app("cs2") is False


def test_is_adult_app_false_when_only_non_adult_ids_present():
    payload = {
        "88888": {
            "success": True,
            "data": {"content_descriptors": {"ids": [2, 3]}},
        },
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload):
        assert is_adult_app("88888") is False


def test_is_adult_app_false_when_no_descriptors_at_all():
    payload = {
        "99999": {"success": True, "data": {"content_descriptors": {"ids": []}}},
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload):
        assert is_adult_app("99999") is False


def test_flush_persists_cache_to_disk(_reset_descriptor_cache):
    payload = {
        "42": {
            "success": True,
            "data": {"content_descriptors": {"ids": [4]}},
        },
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload):
        fetch_steam_content_descriptors("42")
    flush_steam_descriptors_cache(_reset_descriptor_cache)
    on_disk = json.loads(_reset_descriptor_cache.read_text())
    assert on_disk["42"]["ids"] == [4]
    assert isinstance(on_disk["42"]["ts"], int)


def test_expired_cache_entry_triggers_a_fresh_fetch(_reset_descriptor_cache):
    # Seed the cache with a stale entry (older than the 30d TTL).
    old_ts = int(time.time()) - (common_module.STEAM_DESCRIPTORS_CACHE_MAX_AGE_SECONDS + 3600)
    common_module._load_steam_descriptors_cache()  # initialize memory cache
    common_module._steam_descriptors_cache["stale"] = {"ids": [3], "ts": old_ts}

    payload = {
        "stale": {
            "success": True,
            "data": {"content_descriptors": {"ids": [1]}},
        },
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload) as m:
        assert fetch_steam_content_descriptors("stale") == [1]
        assert m.call_count == 1
