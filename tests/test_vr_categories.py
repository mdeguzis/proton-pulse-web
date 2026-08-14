"""Steam VR category capture in the shared appdetails cache (#246).

The three-state return of vr_support_cached is the part that matters and the
part easiest to get wrong:

    'only' / 'supported'  Steam told us, definitively
    ''                    Steam told us, and it is not a VR title
    None                  we have never asked

None is NOT "not VR". Roughly 47k cache entries predate this field, and
treating their None as "no VR support" would permanently mark real VR games
as flatscreen instead of letting the backfill fill them in.
"""

import scripts.pipeline.common as common
from scripts.pipeline.common import (
    VR_ONLY_CATEGORY_ID,
    VR_SUPPORTED_CATEGORY_IDS,
    _vr_category_ids,
    vr_support_cached,
)


def _seed_cache(monkeypatch, entries):
    monkeypatch.setattr(common, "_steam_descriptors_cache", entries)


def test_extracts_only_the_vr_categories():
    payload = {"categories": [
        {"id": 2, "description": "Single-player"},
        {"id": 54, "description": "VR Only"},
        {"id": 31, "description": "VR Support"},
    ]}
    assert sorted(_vr_category_ids(payload)) == [31, 54]


def test_ignores_non_vr_categories_entirely():
    payload = {"categories": [{"id": 2, "description": "Single-player"}]}
    assert _vr_category_ids(payload) == []


def test_tolerates_malformed_category_entries():
    # Steam payloads are not schema-guaranteed; a bad entry must not crash the
    # whole pipeline run.
    payload = {"categories": ["nope", None, {"no_id": 1}, {"id": "54"}, {"id": True}, {"id": 54}]}
    assert _vr_category_ids(payload) == [54]


def test_handles_a_payload_with_no_categories():
    assert _vr_category_ids({}) == []
    assert _vr_category_ids(None) == []


def test_vr_only_wins_over_vr_supported(monkeypatch):
    # Half-Life: Alyx carries BOTH 54 and 31. "Only" is the answer a
    # flatscreen player needs, so it must not be masked by the softer flag.
    _seed_cache(monkeypatch, {"546560": {"ids": [], "ts": 0, "ok": True, "vr_cats": [54, 31]}})
    assert vr_support_cached("546560") == "only"


def test_reports_supported_for_the_softer_flags(monkeypatch):
    for cat in sorted(VR_SUPPORTED_CATEGORY_IDS):
        _seed_cache(monkeypatch, {"275850": {"ids": [], "ts": 0, "ok": True, "vr_cats": [cat]}})
        assert vr_support_cached("275850") == "supported"


def test_empty_string_means_checked_and_not_vr(monkeypatch):
    _seed_cache(monkeypatch, {"730": {"ids": [], "ts": 0, "ok": True, "vr_cats": []}})
    assert vr_support_cached("730") == ""


def test_none_means_never_checked_not_absence_of_vr(monkeypatch):
    # A pre-#246 entry: valid and unexpired, but with no vr_cats key at all.
    _seed_cache(monkeypatch, {"730": {"ids": [3], "ts": 0, "ok": True}})
    assert vr_support_cached("730") is None


def test_none_for_an_app_absent_from_the_cache(monkeypatch):
    _seed_cache(monkeypatch, {})
    assert vr_support_cached("999999") is None


def test_none_for_a_corrupt_cache_entry(monkeypatch):
    _seed_cache(monkeypatch, {"730": "not a dict"})
    assert vr_support_cached("730") is None


def test_none_when_vr_cats_is_not_a_list(monkeypatch):
    _seed_cache(monkeypatch, {"730": {"ids": [], "ts": 0, "ok": True, "vr_cats": "54"}})
    assert vr_support_cached("730") is None


def test_the_only_category_id_is_the_one_steam_uses():
    # Guards against a copy-paste swap of the two constants: 54 is "VR Only"
    # and 53/31 are the supported markers, verified against live appdetails.
    assert VR_ONLY_CATEGORY_ID == 54
    assert VR_SUPPORTED_CATEGORY_IDS == {53, 31}
    assert VR_ONLY_CATEGORY_ID not in VR_SUPPORTED_CATEGORY_IDS
