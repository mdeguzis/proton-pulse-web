"""#241: native-linux.json from Steam's batched GetItems."""
import json
import urllib.error
from pathlib import Path

import pytest

from scripts.pipeline import steam_platforms as sp


def _item(appid, native=None, success=1):
    platforms = {"windows": True}
    if native:
        platforms["steamos_linux"] = True
    return {"appid": appid, "success": success, "platforms": platforms}


def test_url_carries_ids_and_platform_request():
    url = sp._getitems_url([570, 730])
    assert url.startswith(sp.GETITEMS_URL + "?input_json=")
    decoded = json.loads(sp.urllib.parse.unquote(url.split("input_json=", 1)[1]))
    assert decoded["ids"] == [{"appid": 570}, {"appid": 730}]
    assert decoded["data_request"] == {"include_platforms": True}


def test_url_for_a_full_batch_stays_under_steams_limit():
    # 300 ids returned HTTP 414 on 2026-10-28; 200 worked at ~5.8k chars.
    assert len(sp._getitems_url(list(range(9_999_000, 9_999_000 + sp.BATCH_SIZE)))) < 8000


def test_native_flags_batches_and_classifies():
    calls = []

    def fetch(batch):
        calls.append(list(batch))
        return [_item(i, native=(i % 2 == 0)) for i in batch if i != 7]

    r = sp.native_flags(range(1, 402), fetch=fetch, sleep=lambda s: None)
    assert [len(c) for c in calls] == [200, 200, 1]
    assert r["checked"] == 400  # id 7 never answered
    assert r["unknown"] == 1
    assert "2" in r["native"] and "3" not in r["native"]
    assert r["failed_batches"] == 0 and r["error"] is None


def test_unsuccessful_items_are_unknown_not_native():
    r = sp.native_flags([10, 20], fetch=lambda b: [_item(10, native=True, success=2), _item(20)],
                        sleep=lambda s: None)
    assert r == {"native": set(), "checked": 1, "unknown": 1, "failed_batches": 0, "error": None}


def test_a_failing_batch_is_retried_then_left_unknown():
    attempts = {"n": 0}

    def fetch(batch):
        attempts["n"] += 1
        raise urllib.error.URLError("boom")

    sleeps = []
    r = sp.native_flags([1, 2, 3], fetch=fetch, sleep=sleeps.append)
    assert attempts["n"] == sp.RETRIES + 1
    assert sleeps == [1, 2]
    assert r["checked"] == 0 and r["unknown"] == 3 and r["failed_batches"] == 1
    assert "URLError" in r["error"]


def test_fetch_batch_raises_on_a_malformed_response():
    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"response": {}}'

    with pytest.raises(ValueError, match="store_items"):
        sp._fetch_batch([1], opener=lambda req, timeout: Resp())


def test_fetch_batch_parses_store_items():
    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps({"response": {"store_items": [_item(570, native=True)]}}).encode()

    seen = {}

    def opener(req, timeout):
        seen["ua"] = req.get_header("User-agent")
        seen["timeout"] = timeout
        return Resp()

    assert sp._fetch_batch([570], opener=opener)[0]["appid"] == 570
    assert seen == {"ua": "proton-pulse-pipeline", "timeout": sp.REQUEST_TIMEOUT}


def _write_index(tmp_path: Path, ids):
    (tmp_path / "search-index.json").write_text(json.dumps([[i, "t"] for i in ids]))


def test_build_writes_native_linux_json_for_steam_ids_only(tmp_path):
    _write_index(tmp_path, ["570", "1245620", "gog:123", "730", "pw_abc"])
    seen = []

    def fetch(batch):
        seen.extend(batch)
        return [_item(570, native=True), _item(1245620), _item(730, native=True)]

    payload = sp.build_native_linux(tmp_path, fetch=fetch, sleep=lambda s: None)
    assert sorted(seen) == [570, 730, 1245620]
    on_disk = json.loads((tmp_path / "native-linux.json").read_text())
    assert on_disk == payload
    assert payload["native"] == ["570", "730"]
    assert payload["checked"] == 3 and payload["unknown"] == 0
    assert payload["source"] == "IStoreBrowseService/GetItems"
    assert "error" not in payload


def test_build_still_writes_the_file_when_steam_answers_nothing(tmp_path):
    _write_index(tmp_path, ["570"])

    def fetch(batch):
        raise OSError("down")

    payload = sp.build_native_linux(tmp_path, fetch=fetch, sleep=lambda s: None)
    assert payload["checked"] == 0 and payload["native"] == []
    assert "OSError" in payload["error"]
    assert (tmp_path / "native-linux.json").exists()


# --- #261: one sweep feeds type and platforms -----------------------------

def _typed(appid, type_num, native=False):
    item = _item(appid, native=native)
    item["type"] = type_num
    return item


def test_store_sweep_maps_store_types_and_native():
    r = sp.store_sweep([570, 431960, 1675200, 99],
                       fetch=lambda b: [_typed(570, 0, True), _typed(431960, 6), _typed(1675200, 10), _typed(99, 77)],
                       sleep=lambda s: None)
    assert r["items"] == {
        "570": {"type": "game", "native": True},
        "431960": {"type": "software", "native": False},
        "1675200": {"type": "hardware", "native": False},
        "99": {"type": None, "native": False},  # unknown store type number
    }
    assert r["checked"] == 4 and r["unknown"] == 0


def test_native_flags_and_build_reuse_a_given_sweep(tmp_path):
    def no_fetch(batch):
        raise AssertionError("must not call Steam when a sweep is passed in")

    sweep = {"items": {"570": {"type": "game", "native": True}, "730": {"type": "game", "native": False}},
             "checked": 2, "unknown": 1, "failed_batches": 0, "error": None}
    r = sp.native_flags([570, 730, 1], fetch=no_fetch, sweep=sweep)
    assert r["native"] == {"570"} and r["unknown"] == 1
    _write_index(tmp_path, ["570", "730", "1"])
    payload = sp.build_native_linux(tmp_path, fetch=no_fetch, sweep=sweep)
    assert payload["native"] == ["570"]


def test_finalize_sweeps_once_and_passes_it_to_both_steps():
    src = (Path(__file__).resolve().parents[1] / "scripts/pipeline/finalize.py").read_text()
    assert src.count("store_sweep(") == 1
    sweep_at = src.index("store_items = store_sweep(steam_ids_in_index(output_path))")
    assert sweep_at < src.index("enrich_search_index_with_steam_type(output_path, sweep=store_items)")
    assert "build_native_linux(output_path, sweep=store_items)" in src
