"""Tests for the delisted enrich pass that writes column 7 of search-index.json
from the game-images cache.
"""
import json
from pathlib import Path

from scripts.pipeline.game_images import enrich_search_index_with_delisted


def _write(tmp_path: Path, name: str, payload):
    p = tmp_path / name
    p.write_text(json.dumps(payload), encoding="utf-8")
    return p


def test_flags_delisted_steam_app(tmp_path):
    _write(tmp_path, "search-index.json", [
        ["3970", "Prey", "gold", 200, 5, "steam"],
        ["570", "Dota 2", "platinum", 100, 0, "steam"],
    ])
    _write(tmp_path, "game-images-cache.json", {
        "3970": {"status": "delisted", "probed_at": "2026-06-26"},
        "570":  {"status": "ok",       "probed_at": "2026-06-26"},
    })
    enrich_search_index_with_delisted(tmp_path)
    out = json.loads((tmp_path / "search-index.json").read_text())
    assert out[0][7] is True   # Prey 3970 flagged delisted, padded to 8 cols
    assert len(out[1]) == 6     # Dota 2 unchanged, no padding


def test_noop_when_cache_has_no_delisted(tmp_path):
    _write(tmp_path, "search-index.json", [
        ["570", "Dota 2", "platinum", 100, 0, "steam"],
    ])
    _write(tmp_path, "game-images-cache.json", {
        "570": {"status": "ok", "probed_at": "2026-06-26"},
    })
    enrich_search_index_with_delisted(tmp_path)
    out = json.loads((tmp_path / "search-index.json").read_text())
    assert len(out[0]) == 6


def test_noop_when_files_missing(tmp_path):
    # No exception when search-index or cache file is absent
    enrich_search_index_with_delisted(tmp_path)
    assert not (tmp_path / "search-index.json").exists()


def test_preserves_existing_year_column(tmp_path):
    """A row with releaseYear already in column 6 should keep it after padding."""
    _write(tmp_path, "search-index.json", [
        ["3970", "Prey", "gold", 200, 5, "steam", 2006],
    ])
    _write(tmp_path, "game-images-cache.json", {
        "3970": {"status": "delisted", "probed_at": "2026-06-26"},
    })
    enrich_search_index_with_delisted(tmp_path)
    out = json.loads((tmp_path / "search-index.json").read_text())
    assert out[0][6] == 2006   # year preserved
    assert out[0][7] is True   # delisted flagged
