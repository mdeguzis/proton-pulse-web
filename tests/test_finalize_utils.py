import json
from pathlib import Path

from scripts.pipeline.finalize import (
    generate_latest_files,
    derive_index_keys_from_disk,
    reindex_apps,
    generate_search_index,
    generate_recent_reports,
    _extract_title,
    _resolve_coverage_title,
    _compute_game_summary,
    _score_to_tier,
)


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
    tier, pdb, pulse = _compute_game_summary(app_dir)
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
    tier, pdb, pulse = _compute_game_summary(app_dir)
    assert pdb == 1
    assert pulse == 1

def test_compute_game_summary_no_data(tmp_path):
    app_dir = tmp_path / "missing"
    tier, pdb, pulse = _compute_game_summary(app_dir)
    assert tier == "pending"

def test_compute_game_summary_unrated(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2023.json").write_text(json.dumps([{"rating": "pending", "source": "protondb"}]))
    tier, pdb, pulse = _compute_game_summary(app_dir)
    assert tier == "pending"

def test_compute_game_summary_skips_reserved(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([{"rating": "platinum", "source": "protondb"}]))
    (app_dir / "2023.json").write_text(json.dumps([{"rating": "borked", "source": "protondb"}]))
    tier, _, _ = _compute_game_summary(app_dir)
    assert tier == "borked"  # latest.json was skipped


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
