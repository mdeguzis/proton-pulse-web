"""Tests for Steam content-descriptor fetching + caching used by the
adult-games hide-by-default feature.

The pipeline attaches `adult: true` to a row whenever Steam's appdetails
response for that app includes any of ADULT_DESCRIPTOR_IDS (3, 4).
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
    is_adult_app_cached,
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
    # 3 = Adult Only Sexual Content, 4 = Frequent Nudity or Sexual Content.
    # ID 1 (Some Nudity or Sexual Content) is too broad -- catches BG3,
    # Cyberpunk 2077, Rust, GTA V, etc. ID 2 is violence/gore. ID 5 is
    # "General Mature Content" (CS2 / DBD / Rust). Trust Steam devs to
    # self-flag genuine adult games with 3 or 4.
    assert ADULT_DESCRIPTOR_IDS == {3, 4}


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
    # 2 = violence/gore, 1 = "Some Nudity or Sexual Content" (mainstream
    # M-rated flag, deliberately not filtered). Neither triggers adult.
    payload = {
        "88888": {
            "success": True,
            "data": {"content_descriptors": {"ids": [1, 2]}},
        },
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload):
        assert is_adult_app("88888") is False


def test_is_adult_app_false_when_only_descriptor_1_present_bg3_case():
    # Regression: BG3 / Cyberpunk 2077 / Rust / GTA V all set descriptor 1
    # ("Some Nudity or Sexual Content"). Filtering them under the adult
    # gate is a broken UX. Only IDs 3 (adult only) and 4 (frequent) count.
    payload = {
        "1086940": {  # Baldur's Gate 3
            "success": True,
            "data": {"content_descriptors": {"ids": [1, 2]}},
        },
    }
    with patch("scripts.pipeline.common.fetch_json", return_value=payload):
        assert is_adult_app("1086940") is False


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


def test_network_exception_does_not_poison_the_cache(_reset_descriptor_cache):
    # Regression for #185: a rate-limited / failed fetch must NOT cache an
    # empty (false-negative) result. The old code cached [] for 30 days,
    # locking adult games as "not adult" whenever their fetch was throttled.
    with patch("scripts.pipeline.common.fetch_json", side_effect=RuntimeError("429")) as m1:
        assert fetch_steam_content_descriptors("bf6") == []
        assert m1.call_count == 1
    # Nothing was cached, so the next run re-fetches and can succeed.
    payload = {"bf6": {"success": True, "data": {"content_descriptors": {"ids": [3, 4]}}}}
    with patch("scripts.pipeline.common.fetch_json", return_value=payload) as m2:
        assert fetch_steam_content_descriptors("bf6") == [3, 4]
        assert m2.call_count == 1


def test_legacy_empty_entry_uses_short_ttl_and_self_heals(_reset_descriptor_cache):
    # The Naughty Chat (3580330) case: a legacy entry (no "ok" flag) with an
    # empty id list is a suspect false negative. It gets the short negative
    # TTL, so once it ages past that it re-fetches and picks up the real
    # descriptors [1, 3, 4, 5] -> flagged adult.
    stale_ts = int(time.time()) - (common_module.STEAM_DESCRIPTORS_NEGATIVE_TTL_SECONDS + 3600)
    common_module._load_steam_descriptors_cache()
    common_module._steam_descriptors_cache["naughty"] = {"ids": [], "ts": stale_ts}
    payload = {"naughty": {"success": True, "data": {"content_descriptors": {"ids": [1, 3, 4, 5]}}}}
    with patch("scripts.pipeline.common.fetch_json", return_value=payload) as m:
        assert fetch_steam_content_descriptors("naughty") == [1, 3, 4, 5]
        assert m.call_count == 1
    assert is_adult_app("naughty") is True


def test_legacy_nonempty_entry_is_treated_as_confirmed(_reset_descriptor_cache):
    # A legacy entry WITH descriptors came from a real success:true fetch --
    # keep the full TTL, don't re-fetch (avoids a rate-limit storm on games
    # that already have a good result).
    ts = int(time.time()) - (common_module.STEAM_DESCRIPTORS_NEGATIVE_TTL_SECONDS + 3600)
    common_module._load_steam_descriptors_cache()
    common_module._steam_descriptors_cache["confirmed"] = {"ids": [4], "ts": ts}
    with patch("scripts.pipeline.common.fetch_json", side_effect=AssertionError("should not fetch")) as m:
        assert fetch_steam_content_descriptors("confirmed") == [4]
        assert m.call_count == 0


def test_force_refresh_bypasses_a_fresh_poisoned_entry(_reset_descriptor_cache):
    # A recent poisoned empty entry (well within TTL) would normally be reused;
    # force_refresh re-fetches anyway so a hint-titled adult game heals now
    # instead of waiting for the negative TTL to expire.
    common_module._load_steam_descriptors_cache()
    common_module._steam_descriptors_cache["3580330"] = {"ids": [], "ts": int(time.time()), "ok": False}
    payload = {"3580330": {"success": True, "data": {"content_descriptors": {"ids": [1, 3, 4, 5]}}}}
    with patch("scripts.pipeline.common.fetch_json", return_value=payload) as m:
        assert fetch_steam_content_descriptors("3580330", force_refresh=True) == [1, 3, 4, 5]
        assert m.call_count == 1
    assert is_adult_app("3580330") is True  # cache now holds the fresh result


def test_success_false_uses_short_negative_ttl(_reset_descriptor_cache):
    # success:false is stored ok=False and re-fetched after the short TTL, in
    # case it was a transient rate-limit response rather than a removed app.
    stale_ts = int(time.time()) - (common_module.STEAM_DESCRIPTORS_NEGATIVE_TTL_SECONDS + 3600)
    common_module._load_steam_descriptors_cache()
    common_module._steam_descriptors_cache["x"] = {"ids": [], "ts": stale_ts, "ok": False}
    payload = {"x": {"success": True, "data": {"content_descriptors": {"ids": [3]}}}}
    with patch("scripts.pipeline.common.fetch_json", return_value=payload) as m:
        assert fetch_steam_content_descriptors("x") == [3]
        assert m.call_count == 1


# --- is_adult_app_cached (#176) ---

def test_is_adult_app_cached_returns_none_on_cache_miss():
    """No cache entry = None, so callers can decide whether to spend
    their per-run appdetails budget. Distinguishes from a cached-false
    (which is a definitive 'not adult'). #176 gradual enrichment."""
    common_module._load_steam_descriptors_cache()
    assert is_adult_app_cached("nonexistent") is None


def test_is_adult_app_cached_returns_true_when_cached_with_adult_id():
    common_module._load_steam_descriptors_cache()
    common_module._steam_descriptors_cache["777"] = {"ids": [3], "ts": int(time.time()), "ok": True}
    assert is_adult_app_cached("777") is True


def test_is_adult_app_cached_returns_false_when_cached_with_no_adult_ids():
    common_module._load_steam_descriptors_cache()
    common_module._steam_descriptors_cache["888"] = {"ids": [1, 5], "ts": int(time.time()), "ok": True}
    assert is_adult_app_cached("888") is False


def test_is_adult_app_cached_treats_stale_negative_as_miss():
    """An unresolved negative (ok=False) past the short TTL is a miss --
    lets the caller spend budget to re-fetch rather than leaving a
    poisoned cache entry as authoritative. #185 self-heal."""
    old_ts = int(time.time()) - (common_module.STEAM_DESCRIPTORS_NEGATIVE_TTL_SECONDS + 3600)
    common_module._load_steam_descriptors_cache()
    common_module._steam_descriptors_cache["999"] = {"ids": [], "ts": old_ts, "ok": False}
    assert is_adult_app_cached("999") is None
