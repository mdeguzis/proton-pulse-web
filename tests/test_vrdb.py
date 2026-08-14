"""VRDB ingest + VR search-index enrichment (#246).

VRDB is community data with free-text fields, so the parsing tests lean on
real spellings observed in the upstream corpus (61 distinct `device` strings
for about a dozen headsets, plus values that are not headsets at all).
"""

import json
import os
import subprocess

import pytest
import yaml

from scripts.pipeline.vrdb import (
    clone_or_update_vrdb,
    backfill_vr_categories,
    VRDB_HEADSETS,
    VRDB_RATINGS,
    build_vrdb_index,
    enrich_search_index_with_vr,
    normalize_headset,
    parse_vrdb_game,
    vr_capable_app_ids,
    write_vrdb_json,
)


def _write_game(games_dir, app_id, opinions, title="Test Game"):
    body = {"id": int(app_id), "title": title, "opinions": opinions}
    path = games_dir / f"{app_id}.md"
    path.write_text("---\n" + yaml.safe_dump(body) + "---\n", encoding="utf-8")
    return path


@pytest.fixture
def games_dir(tmp_path):
    d = tmp_path / "src" / "games"
    d.mkdir(parents=True)
    return d


# ── normalize_headset ────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("Meta Quest 3", "Meta Quest 3"),
    ("Quest 3", "Meta Quest 3"),
    ("quest 3", "Meta Quest 3"),
    ("Quest3", "Meta Quest 3"),
    ("Oculus Quest 3", "Meta Quest 3"),
    ("Meta Quest 3s", "Meta Quest 3S"),
    ("Quest 3S", "Meta Quest 3S"),
    ("Quest 2", "Meta Quest 2"),
    ("Q2", "Meta Quest 2"),
    ("Qest 2", "Meta Quest 2"),          # upstream typo
    ("oculus 2", "Meta Quest 2"),
    ("Quest Pro", "Meta Quest Pro"),
    ("Quest 1", "Meta Quest 1"),
    ("Valve Index", "Valve Index"),
    ("valve index", "Valve Index"),
    ("Valve Index + Knuckles", "Valve Index"),
    ("HTC Vive Pro", "HTC Vive Pro"),
    ("HTV Vive Pro", "HTC Vive Pro"),    # upstream typo for HTC
    ("Vive Pro", "HTC Vive Pro"),
    ("HTC Vive", "HTC Vive"),
    ("HTC Vive (2016)", "HTC Vive"),
    ("Pico 4", "Pico 4"),
    ("PICO 4", "Pico 4"),
    ("Pico Neo 4", "Pico 4"),
    ("HP Reverb G2", "HP Reverb G2"),
    ("Hp Reverb G2 V2", "HP Reverb G2"),
    ("Bigscreen Beyond 2e", "Bigscreen Beyond"),
    ("Pimax 5K", "Pimax"),
    ("Oculus Rift CV1", "Oculus Rift"),
])
def test_normalize_headset_maps_real_upstream_spellings(raw, expected):
    assert normalize_headset(raw) == expected


@pytest.mark.parametrize("raw", ["AMD", "CachyOS", "_No response_", "", "   ", "n/a", None])
def test_normalize_headset_drops_non_headsets(raw):
    # The upstream field is free text, so GPU vendors and distro names land in
    # it. Rendering "AMD" as a headset would be worse than showing nothing.
    assert normalize_headset(raw) is None


def test_normalize_headset_multi_device_takes_the_one_led_with():
    assert normalize_headset("Valve Index, Quest 2") == "Valve Index"
    assert normalize_headset("Pico 4 & Quest 2") == "Pico 4"
    assert normalize_headset("Quest Pro + Index controllers") == "Meta Quest Pro"


def test_normalize_headset_only_returns_canonical_values():
    for raw in ["Quest 3", "Valve index", "Pimax 5K", "Vive Pro"]:
        assert normalize_headset(raw) in VRDB_HEADSETS


# ── parse_vrdb_game ──────────────────────────────────────────────────────────

def test_parse_aggregates_best_and_worst_per_runtime(games_dir):
    path = _write_game(games_dir, 620980, [
        {"steamVR": 0, "monado": 0, "alvr": 0, "wivrn": 1, "device": "Meta Quest 2", "date": "2025-02-23"},
        {"steamVR": 0, "monado": 0, "alvr": 0, "wivrn": 3, "device": "Quest 2", "date": "2025-02-24"},
    ])
    rec = parse_vrdb_game(path)
    assert rec["app_id"] == "620980"
    assert rec["reports"] == 2
    assert rec["runtimes"] == {"wivrn": {"count": 2, "best": 1, "worst": 3}}
    # Both spellings collapse to one canonical headset.
    assert rec["devices"] == ["Meta Quest 2"]
    assert rec["latest"] == "2025-02-24"


def test_parse_treats_zero_as_not_tested(games_dir):
    # 0 is the issue-form default for "did not try this runtime", not a score.
    path = _write_game(games_dir, 1, [
        {"steamVR": 0, "monado": 5, "alvr": 0, "wivrn": 0, "device": "Valve Index", "date": "2025-01-01"},
    ])
    rec = parse_vrdb_game(path)
    assert set(rec["runtimes"]) == {"monado"}


def test_parse_returns_none_when_nothing_was_rated(games_dir):
    path = _write_game(games_dir, 2, [
        {"steamVR": 0, "monado": 0, "alvr": 0, "wivrn": 0, "device": "Valve Index", "date": "2025-01-01"},
    ])
    assert parse_vrdb_game(path) is None


def test_parse_returns_none_for_a_catalog_stub(games_dir):
    path = _write_game(games_dir, 3, [])
    assert parse_vrdb_game(path) is None


def test_parse_ignores_out_of_range_ratings(games_dir):
    path = _write_game(games_dir, 4, [
        {"steamVR": 9, "monado": -1, "alvr": "x", "wivrn": 2, "device": "Pico 4", "date": "2025-01-01"},
    ])
    rec = parse_vrdb_game(path)
    assert set(rec["runtimes"]) == {"wivrn"}


def test_parse_orders_devices_by_report_count(games_dir):
    path = _write_game(games_dir, 5, [
        {"steamVR": 1, "device": "Valve Index", "date": "2025-01-01"},
        {"steamVR": 1, "device": "Quest 3", "date": "2025-01-02"},
        {"steamVR": 2, "device": "Quest 3", "date": "2025-01-03"},
    ])
    rec = parse_vrdb_game(path)
    assert rec["devices"] == ["Meta Quest 3", "Valve Index"]


def test_parse_raises_on_missing_frontmatter(games_dir):
    path = games_dir / "6.md"
    path.write_text("no frontmatter here\n", encoding="utf-8")
    with pytest.raises(ValueError):
        parse_vrdb_game(path)


def test_parse_raises_on_malformed_yaml(games_dir):
    # One upstream file (470130.md) really is malformed. The failure must be
    # visible to the caller, which counts and thresholds it.
    path = games_dir / "7.md"
    path.write_text('---\nid: 7\ntitle: "unterminated\n---\n', encoding="utf-8")
    with pytest.raises(yaml.YAMLError):
        parse_vrdb_game(path)


# ── build_vrdb_index ─────────────────────────────────────────────────────────

def test_build_index_skips_unusable_files_but_keeps_going(games_dir, tmp_path):
    _write_game(games_dir, 100, [{"wivrn": 1, "device": "Quest 3", "date": "2025-01-01"}])
    _write_game(games_dir, 101, [])  # stub, no opinions
    (games_dir / "102.md").write_text('---\nid: 102\ntitle: "oops\n---\n', encoding="utf-8")

    # Threshold relaxed so this test covers only the skip-and-continue path;
    # the ratio guard has its own test below. In production one bad file out
    # of 6079 is 0.02%, nowhere near the 5% default.
    index = build_vrdb_index(tmp_path, max_parse_failure_ratio=0.5)
    assert set(index) == {"100"}


def test_build_index_raises_when_most_files_fail(games_dir, tmp_path):
    # A handful of bad files upstream is noise; a majority means their format
    # changed and publishing a thinned index would look like "VR data vanished".
    for i in range(10):
        (games_dir / f"{200 + i}.md").write_text('---\nid: 1\ntitle: "oops\n---\n', encoding="utf-8")
    with pytest.raises(ValueError, match="parse failure ratio"):
        build_vrdb_index(tmp_path)


def test_build_index_raises_when_the_clone_is_missing(tmp_path):
    with pytest.raises(FileNotFoundError):
        build_vrdb_index(tmp_path / "nope")


def test_build_index_raises_on_an_empty_games_dir(games_dir, tmp_path):
    with pytest.raises(FileNotFoundError):
        build_vrdb_index(tmp_path)


def test_vr_capable_app_ids_covers_stubs_too(games_dir, tmp_path):
    # Their catalog is VR titles, so a file existing is itself the signal --
    # including for games nobody has reported on yet.
    _write_game(games_dir, 300, [{"wivrn": 1, "device": "Quest 3", "date": "2025-01-01"}])
    _write_game(games_dir, 301, [])
    assert vr_capable_app_ids(tmp_path) == {"300", "301"}


def test_write_vrdb_json_carries_attribution(tmp_path, games_dir):
    _write_game(games_dir, 400, [{"wivrn": 1, "device": "Quest 3", "date": "2025-01-01"}])
    index = build_vrdb_index(tmp_path)
    out = write_vrdb_json(tmp_path, index)
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["license"] == "MIT"
    assert "Respuit/VRDB" in payload["source"]
    assert payload["ratings"]["1"] == VRDB_RATINGS[1]
    assert payload["games"]["400"]["reports"] == 1


# ── enrich_search_index_with_vr ──────────────────────────────────────────────

def _write_index(tmp_path, rows):
    (tmp_path / "search-index.json").write_text(json.dumps(rows), encoding="utf-8")


def _read_index(tmp_path):
    return json.loads((tmp_path / "search-index.json").read_text(encoding="utf-8"))


def test_enrich_flags_vrdb_games_as_supported(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: None)
    _write_index(tmp_path, [["620980", "Beat Saber", "gold", 1, 0, "steam"]])
    assert enrich_search_index_with_vr(tmp_path, vr_app_ids={"620980"}) == 1
    assert _read_index(tmp_path)[0][16] == "supported"


def test_enrich_prefers_the_steam_only_verdict(tmp_path, monkeypatch):
    # Steam can tell "only" from "supported"; VRDB cannot, so Steam wins.
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: "only")
    _write_index(tmp_path, [["620980", "Beat Saber", "gold", 1, 0, "steam"]])
    enrich_search_index_with_vr(tmp_path, vr_app_ids={"620980"})
    assert _read_index(tmp_path)[0][16] == "only"


def test_enrich_falls_back_to_vrdb_when_steam_says_not_vr(tmp_path, monkeypatch):
    # '' means Steam checked and found no VR category. VRDB still wins: some
    # VR modes ship as a separate branch or free DLC with no store category.
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: "")
    _write_index(tmp_path, [["12345", "Branch VR Game", "gold", 1, 0, "steam"]])
    enrich_search_index_with_vr(tmp_path, vr_app_ids={"12345"})
    assert _read_index(tmp_path)[0][16] == "supported"


def test_enrich_leaves_non_vr_rows_untouched(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: None)
    _write_index(tmp_path, [["730", "CS2", "gold", 5, 1, "steam"]])
    assert enrich_search_index_with_vr(tmp_path, vr_app_ids=set()) == 0
    assert len(_read_index(tmp_path)[0]) == 6  # not padded


def test_enrich_does_not_clobber_earlier_columns(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: None)
    # 12-13 anti-cheat, 14-15 PCGamingWiki -- VR must land at 16, not on top.
    row = ["620980", "Beat Saber", "gold", 1, 0, "steam", 2018, None, False, "",
           None, "game", "supported", ["EAC"], ["windows"], "Unity"]
    _write_index(tmp_path, [row])
    enrich_search_index_with_vr(tmp_path, vr_app_ids={"620980"})
    out = _read_index(tmp_path)[0]
    assert out[12] == "supported"   # anti-cheat status, untouched
    assert out[15] == "Unity"       # pgwiki engine, untouched
    assert out[16] == "supported"   # vr


def test_enrich_skips_non_steam_ids(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: None)
    _write_index(tmp_path, [["gog:123", "Some GOG Game", "gold", 1, 0, "gog"]])
    assert enrich_search_index_with_vr(tmp_path, vr_app_ids={"gog:123"}) == 0


def test_enrich_writes_the_compact_map(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "scripts.pipeline.common.vr_support_cached",
        lambda a: "only" if a == "620980" else None,
    )
    _write_index(tmp_path, [
        ["620980", "Beat Saber", "gold", 1, 0, "steam"],
        ["275850", "No Man's Sky", "gold", 9, 2, "steam"],
        ["730", "CS2", "gold", 5, 1, "steam"],
    ])
    enrich_search_index_with_vr(tmp_path, vr_app_ids={"275850"})
    vr_map = json.loads((tmp_path / "vr-index.json").read_text(encoding="utf-8"))
    assert vr_map == {"620980": "only", "275850": "supported"}


def test_enrich_is_a_noop_without_a_search_index(tmp_path):
    assert enrich_search_index_with_vr(tmp_path, vr_app_ids={"1"}) == 0


# ── cross-language parity ────────────────────────────────────────────────────

def test_headset_list_matches_the_frontend():
    """VRDB_HEADSETS and VR_HEADSETS in js/shared/vr.js must stay identical.

    The pipeline normalizes VRDB's free text onto this list and the submit form
    offers it. If they drift, an ingested headset stops matching the one a
    reporter can pick and the game page shows two spellings of one device.
    """
    import re
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "js" / "shared" / "vr.js"
    block = re.search(r"export const VR_HEADSETS = Object\.freeze\(\[(.*?)\]\)", src.read_text(encoding="utf-8"), re.S)
    assert block, "VR_HEADSETS not found in js/shared/vr.js"
    js_headsets = tuple(re.findall(r"'([^']+)'", block.group(1)))
    assert js_headsets == VRDB_HEADSETS


def test_rating_table_matches_the_frontend():
    """VRDB_RATINGS must match VRDB_RATINGS in js/shared/vr.js (and upstream)."""
    import re
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "js" / "shared" / "vr.js"
    block = re.search(r"export const VRDB_RATINGS = Object\.freeze\(\{(.*?)\}\)", src.read_text(encoding="utf-8"), re.S)
    assert block, "VRDB_RATINGS not found in js/shared/vr.js"
    # Back-reference the opening quote so "Crashes or won't start" (double
    # quoted, contains an apostrophe) is captured whole.
    js_ratings = {
        int(k): v for k, _q, v in
        [(m[0], m[1], m[2]) for m in re.findall(r"(\d):\s*([\"'])(.*?)\2", block.group(1))]
    }
    assert js_ratings == VRDB_RATINGS


# ── backfill_vr_categories ───────────────────────────────────────────────────

def test_backfill_skips_apps_that_already_have_vr_data(monkeypatch):
    calls = []
    monkeypatch.setattr("scripts.pipeline.common.fetch_steam_content_descriptors",
                        lambda a, force_refresh=False: calls.append(a) or [])
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: "only")
    monkeypatch.setattr("scripts.pipeline.common.flush_steam_descriptors_cache", lambda: None)
    assert backfill_vr_categories({"620980", "546560"}) == 0
    assert calls == []


def test_backfill_forces_a_refresh(monkeypatch):
    """A pre-#246 cache entry is unexpired but has no vr_cats.

    Without force_refresh the fetch returns from cache, the app stays unknown,
    AND it trips the consecutive-failure counter -- aborting a healthy run.
    """
    seen = {}
    def fake_fetch(app_id, force_refresh=False):
        seen[app_id] = force_refresh
        return []
    monkeypatch.setattr("scripts.pipeline.common.fetch_steam_content_descriptors", fake_fetch)
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached",
                        lambda a: None if a not in seen else "")
    monkeypatch.setattr("scripts.pipeline.common.flush_steam_descriptors_cache", lambda: None)
    backfill_vr_categories({"730"}, request_delay=0)
    assert seen == {"730": True}


def test_backfill_respects_the_probe_cap(monkeypatch):
    calls = []
    monkeypatch.setattr("scripts.pipeline.common.fetch_steam_content_descriptors",
                        lambda a, force_refresh=False: calls.append(a) or [])
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached",
                        lambda a: "" if a in calls else None)
    monkeypatch.setattr("scripts.pipeline.common.flush_steam_descriptors_cache", lambda: None)
    ids = {str(600000 + i) for i in range(50)}
    assert backfill_vr_categories(ids, probe_cap=5, request_delay=0) == 5
    assert len(calls) == 5


def test_backfill_bails_after_consecutive_failures(monkeypatch):
    # Proxy for "Steam is rate-limiting"; burning the rest of the budget on
    # requests that will also fail just delays the pipeline.
    calls = []
    monkeypatch.setattr("scripts.pipeline.common.fetch_steam_content_descriptors",
                        lambda a, force_refresh=False: calls.append(a) or [])
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: None)
    monkeypatch.setattr("scripts.pipeline.common.flush_steam_descriptors_cache", lambda: None)
    ids = {str(700000 + i) for i in range(50)}
    backfill_vr_categories(ids, probe_cap=40, request_delay=0)
    assert len(calls) == 8  # VR_CONSECUTIVE_FAILURE_LIMIT


def test_backfill_ignores_non_steam_ids(monkeypatch):
    calls = []
    monkeypatch.setattr("scripts.pipeline.common.fetch_steam_content_descriptors",
                        lambda a, force_refresh=False: calls.append(a) or [])
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: None)
    monkeypatch.setattr("scripts.pipeline.common.flush_steam_descriptors_cache", lambda: None)
    backfill_vr_categories({"gog:123", "epic:abc"}, request_delay=0)
    assert calls == []


def test_backfill_persists_the_cache_even_when_it_bails(monkeypatch):
    # A bail must not throw away the entries already fetched this run.
    flushed = []
    monkeypatch.setattr("scripts.pipeline.common.fetch_steam_content_descriptors",
                        lambda a, force_refresh=False: [])
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: None)
    monkeypatch.setattr("scripts.pipeline.common.flush_steam_descriptors_cache",
                        lambda: flushed.append(True))
    backfill_vr_categories({str(800000 + i) for i in range(20)}, probe_cap=20, request_delay=0)
    assert flushed == [True]


# ── clone_or_update_vrdb ─────────────────────────────────────────────────────

def test_clone_reuses_a_fresh_clone_without_touching_git(tmp_path, monkeypatch):
    (tmp_path / "src" / "games").mkdir(parents=True)
    calls = []
    monkeypatch.setattr("subprocess.run", lambda *a, **k: calls.append(a))
    assert clone_or_update_vrdb(dest=tmp_path) == tmp_path
    assert calls == []


def test_clone_refreshes_a_stale_clone(tmp_path, monkeypatch):
    games = tmp_path / "src" / "games"
    games.mkdir(parents=True)
    os.utime(games, (0, 0))  # far past the TTL
    cmds = []
    monkeypatch.setattr("subprocess.run", lambda cmd, **k: cmds.append(cmd))
    clone_or_update_vrdb(dest=tmp_path)
    assert any("fetch" in c for c in cmds)
    assert any("reset" in c for c in cmds)


def test_clone_falls_back_to_a_full_reclone_when_the_refresh_fails(tmp_path, monkeypatch):
    games = tmp_path / "src" / "games"
    games.mkdir(parents=True)
    os.utime(games, (0, 0))
    cmds = []

    def fake_run(cmd, **kwargs):
        cmds.append(cmd)
        if "fetch" in cmd:
            raise subprocess.CalledProcessError(1, cmd)
        return None

    monkeypatch.setattr("subprocess.run", fake_run)
    clone_or_update_vrdb(dest=tmp_path)
    assert any("clone" in c for c in cmds)


def test_clone_raises_when_git_clone_fails(tmp_path, monkeypatch):
    # An unreachable upstream must fail loudly. finalize catches it and
    # degrades to the Steam-categories half rather than silently shipping a
    # VR panel with no data.
    def fake_run(cmd, **kwargs):
        if "clone" in cmd:
            raise subprocess.CalledProcessError(128, cmd)
        return None

    monkeypatch.setattr("subprocess.run", fake_run)
    with pytest.raises(subprocess.CalledProcessError):
        clone_or_update_vrdb(dest=tmp_path / "fresh")


def test_clone_force_refresh_skips_the_cache_check(tmp_path, monkeypatch):
    (tmp_path / "src" / "games").mkdir(parents=True)
    cmds = []
    monkeypatch.setattr("subprocess.run", lambda cmd, **k: cmds.append(cmd))
    clone_or_update_vrdb(dest=tmp_path, force_refresh=True)
    assert any("clone" in c for c in cmds)


# ── parse edge cases (branch coverage) ───────────────────────────────────────

def test_parse_returns_none_without_an_id(games_dir):
    (games_dir / "8.md").write_text("---\ntitle: No Id\nopinions: []\n---\n", encoding="utf-8")
    assert parse_vrdb_game(games_dir / "8.md") is None


def test_parse_returns_none_for_a_non_numeric_id(games_dir):
    (games_dir / "9.md").write_text("---\nid: not-a-number\nopinions: []\n---\n", encoding="utf-8")
    assert parse_vrdb_game(games_dir / "9.md") is None


def test_parse_raises_when_frontmatter_is_not_a_mapping(games_dir):
    (games_dir / "10.md").write_text("---\n- just\n- a list\n---\n", encoding="utf-8")
    with pytest.raises(ValueError, match="not a mapping"):
        parse_vrdb_game(games_dir / "10.md")


def test_parse_returns_none_when_opinions_is_not_a_list(games_dir):
    (games_dir / "11.md").write_text("---\nid: 11\nopinions: nope\n---\n", encoding="utf-8")
    assert parse_vrdb_game(games_dir / "11.md") is None


def test_parse_skips_non_dict_opinions(games_dir):
    path = _write_game(games_dir, 12, ["a string", {"wivrn": 1, "device": "Quest 3", "date": "2025-01-01"}])
    rec = parse_vrdb_game(path)
    assert rec["reports"] == 1


def test_parse_rejects_booleans_as_ratings(games_dir):
    # bool is an int subclass in Python; True must not read as rating 1.
    path = _write_game(games_dir, 13, [{"wivrn": True, "steamVR": 2, "device": "Quest 3", "date": "2025-01-01"}])
    rec = parse_vrdb_game(path)
    assert set(rec["runtimes"]) == {"steamvr"}


def test_enrich_ignores_malformed_rows(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.pipeline.common.vr_support_cached", lambda _a: None)
    (tmp_path / "search-index.json").write_text(json.dumps(["not a row", [], ["620980", "Beat Saber"]]))
    assert enrich_search_index_with_vr(tmp_path, vr_app_ids={"620980"}) == 1


def test_enrich_returns_zero_for_an_empty_index(tmp_path):
    (tmp_path / "search-index.json").write_text(json.dumps([]))
    assert enrich_search_index_with_vr(tmp_path, vr_app_ids={"1"}) == 0


def test_vr_capable_app_ids_raises_when_missing(tmp_path):
    with pytest.raises(FileNotFoundError):
        vr_capable_app_ids(tmp_path / "nope")
