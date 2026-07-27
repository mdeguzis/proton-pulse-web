"""Tests for scripts/pipeline/flightless_benchmarks.py (#410).

All network access is mocked; the fetch tests drive _http_get_json
directly. Matching tests encode the matching bar: exact or >= 0.90 similarity
auto-matches, near-misses go to review, unknown games get mango_ stubs.
"""
import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.flightless_benchmarks import (
    CACHE_FILENAME,
    MATCH_THRESHOLD,
    OUTPUT_FILENAME,
    REVIEW_QUEUE_FILENAME,
    build_benchmark_map,
    fetch_all_benchmarks,
    match_benchmark_title,
    normalize_title,
    run_flightless_benchmarks,
    search_url_for_title,
    title_to_mango_id,
)

INDEX = [
    ["730", "Counter-Strike 2", "gold", 5, 2, "steam"],
    ["1245620", "ELDEN RING", "platinum", 9, 1, "steam"],
    ["239140", "Dying Light", "gold", 4, 0, "steam"],
    ["534380", "Dying Light 2 Stay Human: Reloaded Edition", "gold", 3, 0, "steam"],
    ["753640", "Outer Wilds", "gold", 2, 0, "steam"],
    ["2357570", "Overwatch 2", "silver", 6, 0, "steam"],
]


def _bench(bid, title, **kw):
    return {"id": bid, "title": title, "created_at": "2026-07-01T00:00:00Z",
            "run_count": kw.get("run_count", 1), "specifications": kw.get("specs", "")}


# ---- normalize + ids -------------------------------------------------------


def test_normalize_title_mirrors_frontend_normalizeSearchable():
    assert normalize_title("Counter-Strike 2!") == "counter strike 2"
    assert normalize_title("  ELDEN   RING  ") == "elden ring"
    assert normalize_title("") == ""


def test_title_to_mango_id_is_deterministic_and_normalized():
    a = title_to_mango_id("RDR2 - scx vs eevdf")
    assert a == title_to_mango_id("RDR2 - scx vs eevdf")
    # Normalization folds punctuation/case, so near-identical spellings share a stub.
    assert title_to_mango_id("Some Game!") == title_to_mango_id("some game")
    assert a.startswith("mango_") and len(a) == 6 + 8


def test_search_url_for_title():
    assert search_url_for_title("Overwatch 2") == (
        "https://flightlesssomething.ambrosia.one/?search=overwatch+2"
    )


# ---- matching bar ----------------------------------------------------------


def _titles():
    out = {}
    for r in INDEX:
        out.setdefault(normalize_title(r[1]), []).append(str(r[0]))
    return out


def test_exact_normalized_title_matches_at_similarity_1():
    app_ids, matched, sim = match_benchmark_title("Counter-Strike 2", _titles())
    assert (app_ids, sim) == (["730"], 1.0)


def test_leading_slice_match_clears_the_bar():
    # "Game - settings" shape: the game title matches the leading slice.
    app_ids, _, sim = match_benchmark_title("ELDEN RING: Descriptor Heap", _titles())
    assert app_ids == ["1245620"]
    assert sim >= MATCH_THRESHOLD


def test_sequel_guard_sends_dying_light_2_to_review_not_dying_light():
    # Regression from live data: benchmark "Dying Light 2" must NOT
    # auto-attach to "Dying Light". The digit after the matched slice caps
    # similarity below the bar.
    app_ids, _, sim = match_benchmark_title("Dying Light 2", _titles())
    assert app_ids == ["239140"]  # best candidate, but...
    assert sim < MATCH_THRESHOLD  # ...never auto-matched


def test_unrelated_title_matches_nothing():
    app_ids, _, sim = match_benchmark_title("Kubuntu 26.04 (Tkg Kernel)", _titles())
    assert app_ids == []
    assert sim == 0.0


def test_token_guard_keeps_ow1_benchmarks_off_ow2():
    # Live regression: 'Overwatch proton-cachyos tests' leading-slice-matched
    # 'overwatch 2' at 0.909 ('overwatch p' vs 'overwatch 2' -- one lucky
    # char over the bar) and OW1 runs landed on the OW2 page. Every game
    # token must appear in the benchmark title or the score caps below the
    # auto-match bar.
    titles = {"overwatch 2": ["2357570"]}
    for t in ["Overwatch proton-cachyos tests", "Overwatch, Low Settings", "overwatch cake nightly"]:
        _ids, _m, sim = match_benchmark_title(t, titles)
        assert sim < MATCH_THRESHOLD, t
    # The real thing still auto-matches -- including wordy settings
    # suffixes (live regression: the half-the-tokens penalty knocked
    # every 'Overwatch 2 - <settings>' benchmark into review, so only
    # ONE of nine OW2 benchmarks attached).
    for t in [
        "Overwatch 2 Sched-ext",
        "Overwatch 2 - EEVDF vs scx_cake",
        "Overwatch 2 - linux-cachyos 6.17.5 vs linux-tkg-bore-llvm 6.17.5",
        "Overwatch 2 - EEVDF vs bpfland Auto vs bpfland Gaming",
    ]:
        ids, _, sim = match_benchmark_title(t, titles)
        assert ids == ["2357570"] and sim >= MATCH_THRESHOLD, t


def test_single_token_common_word_titles_still_get_penalized():
    # The long-suffix penalty now applies ONLY to single-token game titles
    # ("Portal", "Control") where a prefix hit on a wordy benchmark is weak
    # evidence. Multi-token titles with all tokens present are specific.
    titles = {"control": ["870780"]}
    _ids, _m, sim = match_benchmark_title("Control scheduler comparison testing run", titles)
    assert sim < MATCH_THRESHOLD


def test_multi_storefront_title_attaches_to_every_store_entry():
    # The same game on Steam + GOG + Epic: a benchmark cannot know which
    # store the runner used, so it self-assigns to all of them.
    idx = INDEX + [
        ["gog:555", "Counter-Strike 2", "gold", 0, 0, "gog"],
        ["epic:cs2ns", "Counter-Strike 2", "gold", 0, 0, "epic"],
    ]
    per_app, review = build_benchmark_map([_bench(1, "Counter-Strike 2")], idx)
    assert per_app["730"]["count"] == 1
    assert per_app["gog:555"]["count"] == 1
    assert per_app["epic:cs2ns"]["count"] == 1
    assert review == []


# ---- build_benchmark_map ---------------------------------------------------


def test_map_buckets_exact_fuzzy_review_and_mango():
    benches = [
        _bench(1, "Counter-Strike 2"),                    # exact
        _bench(2, "ELDEN RING: Descriptor Heap"),         # fuzzy >= bar
        _bench(3, "Dying Light 2"),                       # sequel guard -> review
        _bench(4, "Sched-Ext FFXIV Dawntrail stress"),    # unknown -> mango
    ]
    per_app, review = build_benchmark_map(benches, INDEX)
    assert per_app["730"]["count"] == 1
    assert per_app["1245620"]["benchmarks"][0]["id"] == 2
    assert [r["benchmark_id"] for r in review] == [3]
    mango_keys = [k for k in per_app if k.startswith("mango_")]
    assert len(mango_keys) == 1
    assert per_app[mango_keys[0]]["benchmarks"][0]["id"] == 4


def test_map_entry_shape_carries_search_url_and_summary():
    per_app, _ = build_benchmark_map([_bench(9, "Overwatch 2", specs="RTX 4080")], INDEX)
    entry = per_app["2357570"]
    assert entry["search_url"] == "https://flightlesssomething.ambrosia.one/?search=overwatch+2"
    b = entry["benchmarks"][0]
    assert b["url"] == "https://flightlesssomething.ambrosia.one/benchmarks/9"
    assert b["specs"] == "RTX 4080"


def test_manual_override_beats_the_matcher():
    # Admin assignment (future panel) must always win, even over an exact match.
    benches = [_bench(5, "Counter-Strike 2")]
    per_app, review = build_benchmark_map(benches, INDEX, manual_overrides={"5": "1245620"})
    assert "730" not in per_app
    assert per_app["1245620"]["count"] == 1
    assert review == []


def test_blank_titles_are_skipped():
    per_app, review = build_benchmark_map([_bench(6, ""), _bench(7, "   ")], INDEX)
    assert per_app == {} and review == []


# ---- fetch + run ----------------------------------------------------------


def test_fetch_all_benchmarks_paginates_and_stops_on_total_pages():
    pages = {
        1: {"benchmarks": [_bench(1, "A")], "total_pages": 2},
        2: {"benchmarks": [_bench(2, "B")], "total_pages": 2},
    }
    calls = []

    def fake_get(url):
        page = int(url.split("page=")[1].split("&")[0])
        calls.append(page)
        return pages[page]

    with patch("scripts.pipeline.flightless_benchmarks._http_get_json", side_effect=fake_get), \
         patch("scripts.pipeline.flightless_benchmarks.time.sleep"):
        out = fetch_all_benchmarks()
    assert [b["id"] for b in out] == [1, 2]
    assert calls == [1, 2]


def test_fetch_returns_none_when_first_page_fails():
    with patch("scripts.pipeline.flightless_benchmarks._http_get_json", return_value=None):
        assert fetch_all_benchmarks() is None


def test_fetch_keeps_partial_sweep_on_midway_failure():
    responses = iter([{"benchmarks": [_bench(1, "A")], "total_pages": 3}, None])
    with patch("scripts.pipeline.flightless_benchmarks._http_get_json", side_effect=lambda _u: next(responses)), \
         patch("scripts.pipeline.flightless_benchmarks.time.sleep"):
        out = fetch_all_benchmarks()
    assert [b["id"] for b in out] == [1]


def test_run_publishes_map_review_and_uses_cache_fallback(tmp_path):
    (tmp_path / "search-index.json").write_text(json.dumps(INDEX))
    (tmp_path / CACHE_FILENAME).write_text(json.dumps({
        "fetched_at": 1,  # stale -> forces a sweep attempt
        "benchmarks": [_bench(1, "Counter-Strike 2")],
    }))
    # Sweep fails entirely -> the cached benchmark list still gets published.
    with patch("scripts.pipeline.flightless_benchmarks.fetch_all_benchmarks", return_value=None):
        run_flightless_benchmarks(tmp_path)
    per_app = json.loads((tmp_path / OUTPUT_FILENAME).read_text())
    assert per_app["730"]["count"] == 1
    assert json.loads((tmp_path / REVIEW_QUEUE_FILENAME).read_text()) == []


def test_run_survives_missing_search_index(tmp_path):
    with patch("scripts.pipeline.flightless_benchmarks.fetch_all_benchmarks", return_value=[_bench(1, "X")]):
        run_flightless_benchmarks(tmp_path)  # must not raise
    assert not (tmp_path / OUTPUT_FILENAME).exists()


def test_run_writes_metadata_flags(tmp_path):
    (tmp_path / "search-index.json").write_text(json.dumps(INDEX))
    data_dir = tmp_path / "data"
    # 730 matched with an existing dir -> flag true. 1245620 has a stale
    # true but no longer matches -> flipped false.
    (data_dir / "730").mkdir(parents=True)
    (data_dir / "1245620").mkdir(parents=True)
    (data_dir / "1245620" / "metadata.json").write_text(json.dumps({"has_flightlessmango_status": True}))
    with patch("scripts.pipeline.flightless_benchmarks.fetch_all_benchmarks",
               return_value=[_bench(1, "Counter-Strike 2")]):
        run_flightless_benchmarks(tmp_path, data_output_path=data_dir, force=True)
    m730 = json.loads((data_dir / "730" / "metadata.json").read_text())
    assert m730["has_flightlessmango_status"] is True
    m_elden = json.loads((data_dir / "1245620" / "metadata.json").read_text())
    assert m_elden["has_flightlessmango_status"] is False


def test_http_get_json_returns_none_and_logs_on_failure():
    # The wrapper swallows every fetch error into a WARN + None so a
    # FlightlessSomething outage can never raise out of the pipeline.
    from scripts.pipeline.flightless_benchmarks import _http_get_json
    with patch("scripts.pipeline.flightless_benchmarks.urllib.request.urlopen",
               side_effect=OSError("connection refused")):
        assert _http_get_json("https://flightlesssomething.ambrosia.one/api/benchmarks") is None


def test_match_skips_blank_and_oversized_candidate_titles():
    # Empty normalized game titles and games far longer than the benchmark
    # title are pre-filtered without scoring.
    titles = {"": ["1"], "a very long game title that is much longer": ["2"], "outer wilds": ["3"]}
    ids, matched, sim = match_benchmark_title("Outer Wilds", titles)
    assert ids == ["3"] and sim == 1.0


def test_run_respects_fresh_cache_and_skips_sweep(tmp_path):
    import time as _time
    (tmp_path / "search-index.json").write_text(json.dumps(INDEX))
    (tmp_path / CACHE_FILENAME).write_text(json.dumps({
        "fetched_at": int(_time.time()),  # fresh -> no sweep
        "benchmarks": [_bench(1, "Outer Wilds")],
    }))
    with patch("scripts.pipeline.flightless_benchmarks.fetch_all_benchmarks") as sweep:
        run_flightless_benchmarks(tmp_path)
    sweep.assert_not_called()
    per_app = json.loads((tmp_path / OUTPUT_FILENAME).read_text())
    assert per_app["753640"]["count"] == 1


def test_fetch_stops_on_empty_page():
    responses = iter([{"benchmarks": [_bench(1, "A")], "total_pages": 0},
                      {"benchmarks": []}])
    with patch("scripts.pipeline.flightless_benchmarks._http_get_json", side_effect=lambda _u: next(responses)), \
         patch("scripts.pipeline.flightless_benchmarks.time.sleep"):
        out = fetch_all_benchmarks()
    assert [b["id"] for b in out] == [1]


def test_metadata_flags_skip_dirless_apps_and_malformed_json(tmp_path):
    from scripts.pipeline.flightless_benchmarks import _update_metadata_flags
    data_dir = tmp_path / "data"
    (data_dir / "730").mkdir(parents=True)
    (data_dir / "730" / "metadata.json").write_text("{not json")
    # 999 matched but has no dir; 730 has a corrupt metadata file (treated
    # as empty), both must not raise.
    set_true, set_false = _update_metadata_flags(data_dir, {"999", "730"})
    assert set_true == 1  # 730 written fresh
    meta = json.loads((data_dir / "730" / "metadata.json").read_text())
    assert meta["has_flightlessmango_status"] is True
