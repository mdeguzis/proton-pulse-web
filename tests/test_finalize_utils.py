import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.finalize import (
    generate_latest_files,
    derive_index_keys_from_disk,
    reindex_apps,
    generate_search_index,
    generate_recent_reports,
    generate_nonsteam_images,
    _extract_title,
    _resolve_coverage_title,
    _compute_game_summary,
    _score_to_tier,
)


# ── generate_nonsteam_images ──────────────────────────────────────────────────

def test_generate_nonsteam_images_maps_by_canonical_id(tmp_path):
    with patch("scripts.pipeline.finalize.load_gog_covers", return_value={"123": "https://gog/cover.png"}), \
         patch("scripts.pipeline.finalize.load_epic_covers", return_value={"ns1": "https://epic/cover.jpg"}):
        generate_nonsteam_images(tmp_path)
    out = json.loads((tmp_path / "nonsteam-images.json").read_text())
    assert out == {
        "gog:123": "https://gog/cover.png",
        "epic:ns1": "https://epic/cover.jpg",
    }


def test_generate_nonsteam_images_skips_empty_urls(tmp_path):
    with patch("scripts.pipeline.finalize.load_gog_covers", return_value={"123": "", "456": "https://gog/x.png"}), \
         patch("scripts.pipeline.finalize.load_epic_covers", return_value={}):
        generate_nonsteam_images(tmp_path)
    out = json.loads((tmp_path / "nonsteam-images.json").read_text())
    assert out == {"gog:456": "https://gog/x.png"}


def test_generate_nonsteam_images_degrades_when_covers_unavailable(tmp_path):
    with patch("scripts.pipeline.finalize.load_gog_covers", side_effect=RuntimeError("boom")), \
         patch("scripts.pipeline.finalize.load_epic_covers", return_value={}):
        generate_nonsteam_images(tmp_path)
    out = json.loads((tmp_path / "nonsteam-images.json").read_text())
    assert out == {}


# ── _extract_title ────────────────────────────────────────────────────────────

def test_extract_title_from_latest(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([{"title": "CS2", "timestamp": 1}]))
    assert _extract_title(app_dir) == "CS2"

def test_extract_title_missing_latest(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    assert _extract_title(app_dir) == ""

def test_extract_title_empty_list(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([]))
    assert _extract_title(app_dir) == ""

def test_extract_title_corrupt_json(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text("not json")
    assert _extract_title(app_dir) == ""


# ── _resolve_coverage_title ───────────────────────────────────────────────────

def test_resolve_coverage_title_from_indexed_data(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([{"title": "CS2"}]))
    title, source = _resolve_coverage_title("730", tmp_path)
    assert title == "CS2"
    assert source == "indexed-data"

def test_resolve_coverage_title_from_protondb_signal(tmp_path):
    title, source = _resolve_coverage_title("730", tmp_path, protondb_signal_catalog={"730": "CS2"})
    assert title == "CS2"
    assert source == "protondb-signal"

def test_resolve_coverage_title_from_steam_catalog(tmp_path):
    title, source = _resolve_coverage_title("730", tmp_path, steam_catalog={"730": "CS2"})
    assert title == "CS2"
    assert source == "steam-catalog"

def test_resolve_coverage_title_none(tmp_path):
    title, source = _resolve_coverage_title("730", tmp_path)
    assert title == ""
    assert source == "none"


# ── generate_latest_files ─────────────────────────────────────────────────────

def test_generate_latest_files_creates_latest(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text('[{"title":"CS2"}]')
    generate_latest_files(tmp_path)
    assert (app_dir / "latest.json").exists()

def test_generate_latest_files_picks_latest_year(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2022.json").write_text('[{"title":"old"}]')
    (app_dir / "2024.json").write_text('[{"title":"new"}]')
    generate_latest_files(tmp_path)
    content = json.loads((app_dir / "latest.json").read_text())
    assert content[0]["title"] == "new"

def test_generate_latest_files_skips_apps_without_year_files(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "index.json").write_text("[]")
    generate_latest_files(tmp_path)
    assert not (app_dir / "latest.json").exists()


# ── derive_index_keys_from_disk ───────────────────────────────────────────────

def test_derive_index_keys_basic(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text("[]")
    keys = derive_index_keys_from_disk(tmp_path)
    assert ("730", "2023") in keys

def test_derive_index_keys_skips_reserved(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text("[]")
    (app_dir / "index.json").write_text("[]")
    (app_dir / "metadata.json").write_text("{}")
    keys = derive_index_keys_from_disk(tmp_path)
    assert len(keys) == 0

def test_derive_index_keys_skips_unknown_dirs(tmp_path):
    (tmp_path / "some-dir").mkdir()
    keys = derive_index_keys_from_disk(tmp_path)
    assert len(keys) == 0

def test_derive_index_keys_includes_gog_dir(tmp_path):
    app_dir = tmp_path / "gog_1234567890"
    app_dir.mkdir()
    (app_dir / "2025.json").write_text("[]")
    keys = derive_index_keys_from_disk(tmp_path)
    assert ("gog:1234567890", "2025") in keys

def test_derive_index_keys_includes_epic_dir(tmp_path):
    app_dir = tmp_path / "epic_somegame"
    app_dir.mkdir()
    (app_dir / "2025.json").write_text("[]")
    keys = derive_index_keys_from_disk(tmp_path)
    assert ("epic:somegame", "2025") in keys

def test_derive_index_keys_missing_dir(tmp_path):
    keys = derive_index_keys_from_disk(tmp_path / "missing")
    assert keys == set()

def test_derive_index_keys_multiple_years(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2022.json").write_text("[]")
    (app_dir / "2023.json").write_text("[]")
    keys = derive_index_keys_from_disk(tmp_path)
    assert ("730", "2022") in keys
    assert ("730", "2023") in keys


# ── _compute_game_summary ─────────────────────────────────────────────────────

def test_compute_game_summary_platinum(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text(json.dumps([
        {"rating": "platinum", "source": "protondb"},
        {"rating": "platinum", "source": "protondb"},
    ]))
    tier, pdb, pulse, _trend = _compute_game_summary(app_dir)
    assert tier == "platinum"
    assert pdb == 2
    assert pulse == 0

def test_compute_game_summary_mixed_sources(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text(json.dumps([
        {"rating": "gold", "source": "protondb"},
        {"rating": "gold", "source": "pulse"},
    ]))
    tier, pdb, pulse, _trend = _compute_game_summary(app_dir)
    assert pdb == 1
    assert pulse == 1

def test_compute_game_summary_no_data(tmp_path):
    app_dir = tmp_path / "missing"
    tier, pdb, pulse, trend = _compute_game_summary(app_dir)
    assert tier == "pending"
    assert trend == ""

def test_compute_game_summary_unrated(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text(json.dumps([{"rating": "pending", "source": "protondb"}]))
    tier, pdb, pulse, _trend = _compute_game_summary(app_dir)
    assert tier == "pending"

def test_compute_game_summary_skips_reserved(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([{"rating": "platinum", "source": "protondb"}]))
    (app_dir / "2023.json").write_text(json.dumps([{"rating": "borked", "source": "protondb"}]))
    tier, _, _, _ = _compute_game_summary(app_dir)
    assert tier == "borked"  # latest.json was skipped


def test_compute_game_summary_small_stale_sample_returns_pending(tmp_path):
    # MK11-style case (issue: search-index said borked while game page said gold).
    # Small stored sample (< 20) with median age well past 2 years should defer
    # to the live ProtonDB summary via a "pending" tier instead of committing
    # to a stale-borked verdict.
    now_ts = 1_752_000_000.0
    stale_ts = now_ts - (2800 * 86400)  # ~7.7 years old
    app_dir = tmp_path / "976310"
    app_dir.mkdir()
    (app_dir / "2018.json").write_text(json.dumps(
        [{"rating": "borked", "source": "protondb", "timestamp": stale_ts}] * 11
    ))
    tier, pdb, pulse, _ = _compute_game_summary(app_dir, now_ts=now_ts)
    assert tier == "pending"
    assert pdb == 11
    assert pulse == 0


def test_compute_game_summary_small_recent_sample_keeps_tier(tmp_path):
    # A small sample from within the last 2 years should still commit to a
    # tier -- the staleness guard is specifically for old handfuls.
    now_ts = 1_752_000_000.0
    recent_ts = now_ts - (60 * 86400)
    app_dir = tmp_path / "12345"
    app_dir.mkdir()
    (app_dir / "2026.json").write_text(json.dumps(
        [{"rating": "silver", "source": "protondb", "timestamp": recent_ts}] * 5
    ))
    tier, _, _, _ = _compute_game_summary(app_dir, now_ts=now_ts)
    # silver's score is exactly 60, which hits the "gold" threshold in
    # _score_to_tier. The key assertion is that the staleness guard did NOT
    # kick in and mark this recent sample as pending.
    assert tier != "pending"
    assert tier == "gold"


def test_compute_game_summary_large_stale_sample_keeps_tier(tmp_path):
    # A well-sampled stale game (>= 20 rated reports) can still claim its
    # tier -- the guard is only about *thin* stale samples.
    now_ts = 1_752_000_000.0
    stale_ts = now_ts - (2000 * 86400)
    app_dir = tmp_path / "99999"
    app_dir.mkdir()
    (app_dir / "2020.json").write_text(json.dumps(
        [{"rating": "silver", "source": "protondb", "timestamp": stale_ts}] * 30
    ))
    tier, _, _, _ = _compute_game_summary(app_dir, now_ts=now_ts)
    # 30 silver reports -> 60% score -> gold. Key check: the staleness guard
    # did NOT downgrade this to pending because the sample is well above the
    # 20-report threshold.
    assert tier == "gold"


# ── trend computation ────────────────────────────────────────────────────────

def _reports_at(now_ts, offsets_ratings):
    """Build a report list where each entry is (days_ago, rating)."""
    return [
        {"rating": rating, "source": "protondb", "timestamp": now_ts - days * 86400}
        for days, rating in offsets_ratings
    ]

def test_compute_game_summary_trend_improving(tmp_path):
    # 6 recent reports all platinum vs 6 prior reports mostly borked ->
    # playable share jumps well past the 15% threshold, so 'improving'.
    now_ts = 1_700_000_000
    app_dir = tmp_path / "1"
    app_dir.mkdir()
    reports = _reports_at(now_ts, [
        (10, "platinum"), (20, "platinum"), (30, "platinum"),
        (40, "platinum"), (50, "platinum"), (60, "gold"),
        (120, "borked"), (140, "borked"), (160, "borked"),
        (180, "borked"), (200, "borked"), (220, "gold"),
    ])
    (app_dir / "2023.json").write_text(json.dumps(reports))
    _, _, _, trend = _compute_game_summary(app_dir, now_ts=now_ts)
    assert trend == "improving"

def test_compute_game_summary_trend_declining(tmp_path):
    now_ts = 1_700_000_000
    app_dir = tmp_path / "1"
    app_dir.mkdir()
    reports = _reports_at(now_ts, [
        (10, "borked"), (20, "borked"), (30, "borked"),
        (40, "borked"), (50, "borked"), (60, "bronze"),
        (120, "platinum"), (140, "platinum"), (160, "platinum"),
        (180, "gold"), (200, "gold"), (220, "silver"),
    ])
    (app_dir / "2023.json").write_text(json.dumps(reports))
    _, _, _, trend = _compute_game_summary(app_dir, now_ts=now_ts)
    assert trend == "declining"

def test_compute_game_summary_trend_stable_returns_empty(tmp_path):
    # Both windows well-sampled but the ratio barely moves -> stable, no arrow.
    now_ts = 1_700_000_000
    app_dir = tmp_path / "1"
    app_dir.mkdir()
    reports = _reports_at(now_ts, [
        (10, "gold"), (20, "gold"), (30, "gold"), (40, "gold"), (50, "gold"),
        (120, "gold"), (140, "gold"), (160, "gold"), (180, "gold"), (200, "gold"),
    ])
    (app_dir / "2023.json").write_text(json.dumps(reports))
    _, _, _, trend = _compute_game_summary(app_dir, now_ts=now_ts)
    assert trend == ""

def test_compute_game_summary_trend_insufficient_recent(tmp_path):
    # Only 3 recent reports (below the min-bucket floor of 5), so no verdict.
    now_ts = 1_700_000_000
    app_dir = tmp_path / "1"
    app_dir.mkdir()
    reports = _reports_at(now_ts, [
        (10, "platinum"), (20, "platinum"), (30, "platinum"),
        (120, "borked"), (140, "borked"), (160, "borked"),
        (180, "borked"), (200, "borked"), (220, "borked"),
    ])
    (app_dir / "2023.json").write_text(json.dumps(reports))
    _, _, _, trend = _compute_game_summary(app_dir, now_ts=now_ts)
    assert trend == ""

def test_compute_game_summary_trend_disabled_without_now_ts(tmp_path):
    # Legacy callers that pass no now_ts still get the same 4-tuple with an
    # empty trend, so tests that don't care about time don't need to fake it.
    app_dir = tmp_path / "1"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text(json.dumps([
        {"rating": "platinum", "source": "protondb", "timestamp": 1_700_000_000},
    ]))
    tier, _, _, trend = _compute_game_summary(app_dir)
    assert tier == "platinum"
    assert trend == ""


# ── generate_search_index ─────────────────────────────────────────────────────

def test_generate_search_index_basic(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text(json.dumps([{"rating": "gold", "source": "protondb", "title": "CS2"}]))
    (app_dir / "latest.json").write_text(json.dumps([{"title": "CS2"}]))

    keys = {("730", "2023")}
    generate_search_index(keys, tmp_path, tmp_path)

    index = json.loads((tmp_path / "search-index.json").read_text())
    assert len(index) == 1
    assert index[0][0] == "730"
    assert index[0][1] == "CS2"
    assert index[0][5] == "steam"  # appType
    # Every row must carry a trend column (index 9) so JS lookups can rely on
    # row[9] without a length guard on modern payloads. Empty is fine for
    # under-sampled games; the JS side only draws for improving / declining.
    assert len(index[0]) >= 10
    assert index[0][9] == ""

def test_generate_search_index_gog_stub_from_catalog(tmp_path):
    keys = set()
    gog_catalog = {"1234567890": "Swat 4"}
    generate_search_index(keys, tmp_path, tmp_path, gog_catalog=gog_catalog)

    index = json.loads((tmp_path / "search-index.json").read_text())
    assert len(index) == 1
    assert index[0][0] == "gog:1234567890"
    assert index[0][1] == "Swat 4"
    assert index[0][2] == ""    # no tier
    assert index[0][3] == 0     # no protondb reports
    assert index[0][4] == 0     # no pulse reports
    assert index[0][5] == "gog"

def test_generate_search_index_gog_with_reports_not_duplicated(tmp_path):
    app_dir = tmp_path / "gog_1234567890"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([{"title": "Swat 4"}]))
    (app_dir / "2025.json").write_text(json.dumps([{"rating": "gold", "source": "pulse", "title": "Swat 4"}]))

    keys = {("gog:1234567890", "2025")}
    gog_catalog = {"1234567890": "Swat 4"}
    generate_search_index(keys, tmp_path, tmp_path, gog_catalog=gog_catalog)

    index = json.loads((tmp_path / "search-index.json").read_text())
    gog_entries = [e for e in index if e[0] == "gog:1234567890"]
    assert len(gog_entries) == 1  # no duplicate stub
    assert gog_entries[0][4] == 1  # pulse count from real data

def test_generate_search_index_epic_stub_from_catalog(tmp_path):
    keys = set()
    epic_catalog = {"fortnite": "Fortnite"}
    generate_search_index(keys, tmp_path, tmp_path, epic_catalog=epic_catalog)

    index = json.loads((tmp_path / "search-index.json").read_text())
    assert len(index) == 1
    assert index[0][0] == "epic:fortnite"
    assert index[0][1] == "Fortnite"
    assert index[0][2] == ""
    assert index[0][3] == 0
    assert index[0][4] == 0
    assert index[0][5] == "epic"

def test_generate_search_index_epic_with_reports_not_duplicated(tmp_path):
    app_dir = tmp_path / "epic_fortnite"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([{"title": "Fortnite"}]))
    (app_dir / "2025.json").write_text(json.dumps([{"rating": "gold", "source": "pulse", "title": "Fortnite"}]))

    keys = {("epic:fortnite", "2025")}
    epic_catalog = {"fortnite": "Fortnite"}
    generate_search_index(keys, tmp_path, tmp_path, epic_catalog=epic_catalog)

    index = json.loads((tmp_path / "search-index.json").read_text())
    epic_entries = [e for e in index if e[0] == "epic:fortnite"]
    assert len(epic_entries) == 1
    assert epic_entries[0][4] == 1

def test_generate_search_index_skips_no_title(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text(json.dumps([{"rating": "gold", "source": "protondb"}]))
    # no latest.json -> _extract_title returns ""

    keys = {("730", "2023")}
    generate_search_index(keys, tmp_path, tmp_path)
    index = json.loads((tmp_path / "search-index.json").read_text())
    assert index == []


# ── generate_recent_reports ───────────────────────────────────────────────────

def test_generate_recent_reports_basic(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2025.json").write_text(json.dumps([
        {"title": "CS2", "rating": "gold", "source": "protondb", "timestamp": 1750000000}
    ]))

    search_index = [["730", "CS2", "gold", 1, 0]]
    (tmp_path / "search-index.json").write_text(json.dumps(search_index))

    generate_recent_reports(data_dir, tmp_path)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert len(result) == 1
    assert result[0]["appId"] == "730"
    assert result[0]["title"] == "CS2"

def test_generate_recent_reports_sorted_by_date(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    for app_id, ts in [("730", 1750000000), ("570", 1740000000)]:
        d = data_dir / app_id
        d.mkdir()
        (d / "2025.json").write_text(json.dumps([
            {"title": f"Game {app_id}", "timestamp": ts}
        ]))

    search_index = [["730", "CS2", "gold", 1, 0], ["570", "Dota 2", "platinum", 1, 0]]
    (tmp_path / "search-index.json").write_text(json.dumps(search_index))

    generate_recent_reports(data_dir, tmp_path)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert result[0]["appId"] == "730"  # newer timestamp comes first

def test_generate_recent_reports_skips_no_title(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app_dir = data_dir / "730"
    app_dir.mkdir()
    (app_dir / "2025.json").write_text(json.dumps([{"timestamp": 1750000000}]))

    # No search-index entry -> no title -> skipped
    (tmp_path / "search-index.json").write_text("[]")
    generate_recent_reports(data_dir, tmp_path)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert result == []

def test_generate_recent_reports_respects_limit(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    index = []
    for i in range(20):
        d = data_dir / str(1000 + i)
        d.mkdir()
        (d / "2025.json").write_text(json.dumps([{"timestamp": 1750000000 + i}]))
        index.append([str(1000 + i), f"Game {i}", "gold", 1, 0])

    (tmp_path / "search-index.json").write_text(json.dumps(index))
    generate_recent_reports(data_dir, tmp_path, limit=5)
    result = json.loads((tmp_path / "recent-reports.json").read_text())
    assert len(result) == 5


# ── reindex_apps ──────────────────────────────────────────────────────────────

def test_reindex_apps_basic(tmp_path):
    data_dir = tmp_path / "data"
    app_dir = data_dir / "730"
    app_dir.mkdir(parents=True)
    (app_dir / "2023.json").write_text("[]")

    reindex_apps(str(tmp_path), ["730"])
    assert (app_dir / "index.json").exists()
    index = json.loads((app_dir / "index.json").read_text())
    assert "2023" in index

def test_reindex_apps_skips_missing(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    reindex_apps(str(tmp_path), ["999"])
    assert not (data_dir / "999" / "index.json").exists()


# ── _score_to_tier (finalize) ─────────────────────────────────────────────────

def test_finalize_score_to_tier_platinum():
    assert _score_to_tier(100.0) == "platinum"

def test_finalize_score_to_tier_borked():
    assert _score_to_tier(0.0) == "borked"
