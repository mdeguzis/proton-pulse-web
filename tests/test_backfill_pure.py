import json
import pytest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from scripts.pipeline.backfill import (
    _coerce_backfill_target,
    load_backfill_targets,
    load_backfill_app_ids,
    compute_js_hash,
    _build_js_hash_fragment,
    compute_live_report_hash,
    compute_live_report_hash_legacy,
    build_live_report_candidate_urls,
    infer_live_rating,
    normalize_live_detailed_reports,
    bucket_reports_by_year,
    write_bucketed_reports,
    BackfillTarget,
)


# ── _coerce_backfill_target ───────────────────────────────────────────────────

def test_coerce_string_app_id():
    t = _coerce_backfill_target("730")
    assert t.app_id == "730"
    assert t.report_urls == ()

def test_coerce_dict_app_id():
    t = _coerce_backfill_target({"appId": 730})
    assert t.app_id == "730"

def test_coerce_dict_with_report_url():
    t = _coerce_backfill_target({"appId": "730", "reportUrl": "https://example.com/report"})
    assert "https://example.com/report" in t.report_urls

def test_coerce_dict_with_report_urls():
    t = _coerce_backfill_target({"appId": "730", "reportUrls": ["https://a.com", "https://b.com"]})
    assert len(t.report_urls) == 2

def test_coerce_invalid_string_raises():
    with pytest.raises(ValueError):
        _coerce_backfill_target("not-an-id")

def test_coerce_invalid_dict_raises():
    with pytest.raises(ValueError):
        _coerce_backfill_target({"appId": "abc"})

def test_coerce_invalid_report_url_raises():
    with pytest.raises(ValueError):
        _coerce_backfill_target({"appId": "730", "reportUrl": ""})

def test_coerce_invalid_report_urls_not_list():
    with pytest.raises(ValueError):
        _coerce_backfill_target({"appId": "730", "reportUrls": "not-a-list"})

def test_coerce_deduplicates_urls():
    t = _coerce_backfill_target({
        "appId": "730",
        "reportUrl": "https://a.com",
        "reportUrls": ["https://a.com", "https://b.com"],
    })
    assert len(t.report_urls) == 2
    assert t.report_urls[0] == "https://a.com"


# ── load_backfill_targets ─────────────────────────────────────────────────────

def test_load_backfill_targets_missing_manifest(tmp_path):
    result = load_backfill_targets(tmp_path / "missing.json")
    assert result == []

def test_load_backfill_targets_string_list(tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(["730", "570"]))
    targets = load_backfill_targets(manifest)
    assert [t.app_id for t in targets] == ["570", "730"]

def test_load_backfill_targets_dict_list(tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps([{"appId": "730"}]))
    targets = load_backfill_targets(manifest)
    assert targets[0].app_id == "730"

def test_load_backfill_targets_merges_duplicate_ids(tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps([
        {"appId": "730", "reportUrl": "https://a.com"},
        {"appId": "730", "reportUrl": "https://b.com"},
    ]))
    targets = load_backfill_targets(manifest)
    assert len(targets) == 1
    assert len(targets[0].report_urls) == 2

def test_load_backfill_targets_not_array_raises(tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"appId": "730"}))
    with pytest.raises(ValueError):
        load_backfill_targets(manifest)

def test_load_backfill_app_ids(tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(["730", "570"]))
    ids = load_backfill_app_ids(manifest)
    assert ids == ["570", "730"]


# ── compute_js_hash ───────────────────────────────────────────────────────────

def test_compute_js_hash_reproducible():
    h1 = compute_js_hash("test-seed")
    h2 = compute_js_hash("test-seed")
    assert h1 == h2

def test_compute_js_hash_different_seeds():
    assert compute_js_hash("seed-a") != compute_js_hash("seed-b")

def test_compute_js_hash_returns_int():
    assert isinstance(compute_js_hash("anything"), int)

def test_compute_js_hash_non_negative():
    assert compute_js_hash("test") >= 0


# ── _build_js_hash_fragment ───────────────────────────────────────────────────

def test_build_js_hash_fragment_numeric():
    result = _build_js_hash_fragment(100, 50, 30)
    assert "p" in result

def test_build_js_hash_fragment_nan_multiplier():
    result = _build_js_hash_fragment("any", 50, 30)
    assert "NaN" in result


# ── compute_live_report_hash ──────────────────────────────────────────────────

def test_compute_live_report_hash_returns_int():
    h = compute_live_report_hash(730, 100, 1000000, "any")
    assert isinstance(h, int)
    assert h >= 0

def test_compute_live_report_hash_consistent():
    h1 = compute_live_report_hash(730, 100, 1000000, "any")
    h2 = compute_live_report_hash(730, 100, 1000000, "any")
    assert h1 == h2

def test_compute_live_report_hash_varies_with_inputs():
    h1 = compute_live_report_hash(730, 100, 1000000, "any")
    h2 = compute_live_report_hash(570, 100, 1000000, "any")
    assert h1 != h2


# ── compute_live_report_hash_legacy ──────────────────────────────────────────

def test_compute_live_report_hash_legacy_returns_int():
    h = compute_live_report_hash_legacy(730, 100, 1000000, "all")
    assert isinstance(h, int)
    assert h >= 0

def test_compute_live_report_hash_legacy_non_int_page():
    h = compute_live_report_hash_legacy(730, 100, 1000000, "bad")
    assert isinstance(h, int)


# ── build_live_report_candidate_urls ─────────────────────────────────────────

def test_build_candidate_urls_returns_list():
    urls = build_live_report_candidate_urls("730", 100, 1000000)
    assert isinstance(urls, list)
    assert len(urls) >= 2

def test_build_candidate_urls_explicit_first():
    explicit = ("https://explicit.com/report",)
    urls = build_live_report_candidate_urls("730", 100, 1000000, explicit_urls=explicit)
    assert urls[0] == "https://explicit.com/report"

def test_build_candidate_urls_deduped():
    urls = build_live_report_candidate_urls("730", 100, 1000000)
    assert len(urls) == len(set(urls))


# ── infer_live_rating ─────────────────────────────────────────────────────────

def test_infer_rating_none_responses():
    assert infer_live_rating(None) == "pending"

def test_infer_rating_empty():
    assert infer_live_rating({}) == "pending"

def test_infer_rating_no_verdict():
    assert infer_live_rating({"verdict": ""}) == "pending"

def test_infer_rating_borked():
    assert infer_live_rating({"verdict": "no"}) == "borked"

def test_infer_rating_not_yes_or_no():
    assert infer_live_rating({"verdict": "maybe"}) == "pending"

def test_infer_rating_gold_no_faults():
    assert infer_live_rating({"verdict": "yes"}) == "gold"

def test_infer_rating_platinum_oob():
    assert infer_live_rating({"verdict": "yes", "triedOob": "yes"}) == "platinum"

def test_infer_rating_gold_one_fault():
    assert infer_live_rating({"verdict": "yes", "audioFaults": "yes"}) == "gold"

def test_infer_rating_silver_two_faults():
    assert infer_live_rating({"verdict": "yes", "audioFaults": "yes", "graphicalFaults": "yes"}) == "silver"

def test_infer_rating_bronze_three_faults():
    r = {"verdict": "yes", "audioFaults": "yes", "graphicalFaults": "yes", "inputFaults": "yes"}
    assert infer_live_rating(r) == "bronze"


# ── normalize_live_detailed_reports ──────────────────────────────────────────

def _make_live_report(timestamp=1700000000, verdict="yes", cpu="Intel i7", gpu="RTX 3080"):
    return {
        "timestamp": timestamp,
        "responses": {"verdict": verdict, "protonVersion": "9.0-4"},
        "device": {"inferred": {"steam": {"cpu": cpu, "gpu": gpu, "os": "Arch", "kernel": "6.5", "ram": "16", "gpuDriver": "535"}}},
        "contributor": {"steam": {"playtimeLinux": 120}},
    }

def test_normalize_returns_list():
    result = normalize_live_detailed_reports("730", [_make_live_report()])
    assert isinstance(result, list)
    assert len(result) == 1

def test_normalize_sets_app_id():
    result = normalize_live_detailed_reports("730", [_make_live_report()])
    assert result[0]["appId"] == "730"

def test_normalize_maps_rating():
    result = normalize_live_detailed_reports("730", [_make_live_report(verdict="no")])
    assert result[0]["rating"] == "borked"

def test_normalize_skips_missing_timestamp():
    report = _make_live_report()
    report["timestamp"] = None
    result = normalize_live_detailed_reports("730", [report])
    assert result == []

def test_normalize_skips_zero_timestamp():
    report = _make_live_report()
    report["timestamp"] = 0
    result = normalize_live_detailed_reports("730", [report])
    assert result == []

def test_normalize_sets_title():
    result = normalize_live_detailed_reports("730", [_make_live_report()], title="CS2")
    assert result[0]["title"] == "CS2"

def test_normalize_empty_input():
    result = normalize_live_detailed_reports("730", [])
    assert result == []

def test_normalize_notes_from_concluding():
    report = _make_live_report()
    report["responses"]["notes"] = {"concludingNotes": "runs great"}
    result = normalize_live_detailed_reports("730", [report])
    assert result[0]["notes"] == "runs great"

def test_normalize_notes_fallback_verdict():
    report = _make_live_report()
    report["responses"]["notes"] = {"verdict": "seems fine"}
    result = normalize_live_detailed_reports("730", [report])
    assert result[0]["notes"] == "seems fine"


# ── bucket_reports_by_year ────────────────────────────────────────────────────

def test_bucket_by_year_basic():
    reports = [{"timestamp": 1700000000}, {"timestamp": 1577836800}]
    buckets = bucket_reports_by_year(reports)
    assert "2023" in buckets
    assert "2020" in buckets

def test_bucket_by_year_unknown():
    reports = [{"timestamp": None}]
    buckets = bucket_reports_by_year(reports)
    assert "unknown" in buckets

def test_bucket_by_year_groups_same_year():
    ts = 1700000000
    reports = [{"timestamp": ts}, {"timestamp": ts + 1000}]
    buckets = bucket_reports_by_year(reports)
    assert len(buckets["2023"]) == 2


# ── write_bucketed_reports ────────────────────────────────────────────────────

def test_write_bucketed_reports_creates_files(tmp_path):
    data_path = tmp_path / "data"
    buckets = {"2023": [{"rating": "gold", "timestamp": 1700000000}]}
    keys = write_bucketed_reports(data_path, "730", buckets)
    assert ("730", "2023") in keys
    assert (data_path / "730" / "2023.json").exists()

def test_write_bucketed_reports_sets_source(tmp_path):
    data_path = tmp_path / "data"
    buckets = {"2023": [{"rating": "gold", "timestamp": 1700000000}]}
    write_bucketed_reports(data_path, "730", buckets)
    written = json.loads((data_path / "730" / "2023.json").read_text())
    assert written[0]["source"] == "protondb"


# ── run_backfill mixed-store input (#114) ─────────────────────────────────────

def test_run_backfill_routes_only_steam_ids_to_protondb(tmp_path, capsys):
    """#114: workflow input now accepts Steam + GOG/Epic canonical ids in
    the same comma-list. Steam ids reach the ProtonDB backfill; non-Steam
    ids are logged as accepted-but-deferred (per-product refresh lands
    with #112). Unrecognized ids get a warning line.
    """
    from scripts.pipeline import backfill as backfill_mod
    # Stub the inner ProtonDB call so we only verify what target_app_ids
    # arrive at it. Pipeline state read is best-effort; empty dir works.
    (tmp_path / "data").mkdir()

    seen = {}
    def fake_backfill(data_output_path, fetch_json_impl=None, manifest_path=None, target_app_ids=None, force=False):
        seen["target_app_ids"] = list(target_app_ids or [])
        return set(), set()

    fake_state = {"index_keys": set(), "backfilled_keys": set(), "parsed_count": 0, "no_data_app_ids": set()}
    with patch.object(backfill_mod, "backfill_missing_apps", side_effect=fake_backfill), \
         patch.object(backfill_mod, "read_pipeline_state", return_value=fake_state), \
         patch.object(backfill_mod, "write_pipeline_state"), \
         patch.object(backfill_mod, "flush_steam_title_cache"):
        backfill_mod.run_backfill(
            tmp_path,
            target_app_ids=["570", "gog:1207658691", "epic:MyGame", "not-a-real-id"],
        )
    # Steam id passed through; GOG/Epic filtered out; unrecognized also filtered.
    assert seen["target_app_ids"] == ["570"]


def test_run_backfill_exits_when_no_steam_ids_after_filter(tmp_path):
    """All GOG/Epic input = nothing for ProtonDB to do. Should return
    cleanly without calling into backfill_missing_apps so the workflow
    step doesn't crash on an empty target list."""
    from scripts.pipeline import backfill as backfill_mod
    (tmp_path / "data").mkdir()

    called = {"count": 0}
    def fake_backfill(**kwargs):
        called["count"] += 1
        return set(), set()

    fake_state = {"index_keys": set(), "backfilled_keys": set(), "parsed_count": 0, "no_data_app_ids": set()}
    with patch.object(backfill_mod, "backfill_missing_apps", side_effect=fake_backfill), \
         patch.object(backfill_mod, "read_pipeline_state", return_value=fake_state):
        backfill_mod.run_backfill(
            tmp_path,
            target_app_ids=["gog:12345", "epic:SomeGame"],
        )
    assert called["count"] == 0
