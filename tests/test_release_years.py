"""Tests for scripts/pipeline/release_years.py.

Covers the no-op path (no collisions), the cache-hit path, the year-extraction
parser, and the search-index re-emission with the populated column 7. The Steam
appdetails fetch is mocked -- these tests never hit the network.
"""
import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.release_years import (
    _extract_year,
    enrich_search_index_with_release_years,
)


def _write_index(tmp_path: Path, entries: list) -> Path:
    out = tmp_path / "search-index.json"
    out.write_text(json.dumps(entries), encoding="utf-8")
    return out


def test_extract_year_handles_us_locale():
    assert _extract_year({"coming_soon": False, "date": "Mar 5, 2017"}) == 2017


def test_extract_year_handles_european_locale():
    assert _extract_year({"coming_soon": False, "date": "5 Mar, 2006"}) == 2006


def test_extract_year_returns_none_for_tbd_dates():
    assert _extract_year({"coming_soon": True, "date": "To be announced"}) is None


def test_extract_year_returns_none_for_missing_dict():
    assert _extract_year(None) is None
    assert _extract_year({}) is None


def test_no_collisions_writes_no_year_column(tmp_path):
    """Unique titles: search-index is untouched, no cache file is created."""
    _write_index(tmp_path, [
        ["570", "Dota 2", "platinum", 100, 0, "steam"],
        ["730", "Counter-Strike", "platinum", 50, 0, "steam"],
    ])
    with patch("scripts.pipeline.release_years._fetch_year") as fetcher:
        enrich_search_index_with_release_years(tmp_path)
    fetcher.assert_not_called()
    assert not (tmp_path / "release-years-cache.json").exists()


def test_collisions_fetch_and_write_year_column(tmp_path):
    """Two Prey entries: both get a releaseYear written into column 7."""
    _write_index(tmp_path, [
        ["3970", "Prey", "gold", 200, 5, "steam"],
        ["480490", "Prey", "platinum", 800, 12, "steam"],
        ["570", "Dota 2", "platinum", 100, 0, "steam"],
    ])

    def fake_fetch(app_id):
        return {"3970": 2006, "480490": 2017}[app_id]

    with patch("scripts.pipeline.release_years._fetch_year", side_effect=fake_fetch), \
         patch("scripts.pipeline.release_years.time.sleep"):
        enrich_search_index_with_release_years(tmp_path)

    out = json.loads((tmp_path / "search-index.json").read_text())
    assert out[0][6] == 2006
    assert out[1][6] == 2017
    # Non-colliding entry stays at original length (no year column added)
    assert len(out[2]) == 6


def test_cache_skips_already_fetched(tmp_path):
    """Cached results never trigger a fetch on a subsequent run."""
    _write_index(tmp_path, [
        ["3970", "Prey", "gold", 200, 5, "steam"],
        ["480490", "Prey", "platinum", 800, 12, "steam"],
    ])
    (tmp_path / "release-years-cache.json").write_text(
        json.dumps({"3970": 2006, "480490": 2017}), encoding="utf-8"
    )
    with patch("scripts.pipeline.release_years._fetch_year") as fetcher:
        enrich_search_index_with_release_years(tmp_path)
    fetcher.assert_not_called()
    out = json.loads((tmp_path / "search-index.json").read_text())
    assert out[0][6] == 2006
    assert out[1][6] == 2017


def test_nonsteam_ids_are_skipped(tmp_path):
    """GOG/Epic stubs collide too but the appdetails endpoint only knows Steam ids."""
    _write_index(tmp_path, [
        ["gog:1234", "Prey", "", 0, 0, "gog"],
        ["epic:abcd", "Prey", "", 0, 0, "epic"],
    ])
    with patch("scripts.pipeline.release_years._fetch_year") as fetcher:
        enrich_search_index_with_release_years(tmp_path)
    fetcher.assert_not_called()
    # Neither entry gets a year written (no cache hit either)
    out = json.loads((tmp_path / "search-index.json").read_text())
    assert all(len(row) == 6 for row in out)


def test_negative_cache_value_does_not_pad_columns(tmp_path):
    """Cached None (unparseable / unreleased) should not append a year column."""
    _write_index(tmp_path, [
        ["3970", "Prey", "gold", 200, 5, "steam"],
        ["480490", "Prey", "platinum", 800, 12, "steam"],
    ])
    (tmp_path / "release-years-cache.json").write_text(
        json.dumps({"3970": None, "480490": 2017}), encoding="utf-8"
    )
    with patch("scripts.pipeline.release_years._fetch_year") as fetcher:
        enrich_search_index_with_release_years(tmp_path)
    fetcher.assert_not_called()
    out = json.loads((tmp_path / "search-index.json").read_text())
    assert len(out[0]) == 6  # no year written for None
    assert out[1][6] == 2017


def test_missing_search_index_is_noop(tmp_path):
    """A clean output dir without search-index.json should not raise."""
    with patch("scripts.pipeline.release_years._fetch_year") as fetcher:
        enrich_search_index_with_release_years(tmp_path)
    fetcher.assert_not_called()
