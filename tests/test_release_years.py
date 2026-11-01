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
        return {"3970": (2006, True), "480490": (2017, True)}[app_id]

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


class _Resp:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.body


def test_fetch_year_goes_through_the_shared_client(monkeypatch):
    """#411: _fetch_year uses http_client, so a failure, an HTML body or a
    non-object is (None, False) and is never cached as a real answer."""
    import json as _json
    import urllib.request
    from scripts.pipeline import release_years as ry

    seen = []

    def ok(req, timeout):
        seen.append((req.full_url, req.get_header("User-agent")))
        return _Resp(_json.dumps({"620": {"success": True, "data": {"release_date": {"date": "19 Apr, 2011"}}}}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", ok)
    assert ry._fetch_year("620") == (2011, True)
    assert seen[0][0] == ry.STEAM_APPDETAILS_URL.format(appid="620")
    assert seen[0][1].startswith("proton-pulse-pipeline/")

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout: _Resp(_json.dumps({"620": {"success": False}}).encode()))
    assert ry._fetch_year("620") == (None, True)

    def boom(req, timeout):
        raise OSError("connection reset")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    assert ry._fetch_year("620") == (None, False)
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout: _Resp(b"<!doctype html>"))
    assert ry._fetch_year("620") == (None, False)
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout: _Resp(b"null"))
    assert ry._fetch_year("620") == (None, False)


def _colliding(n: int) -> list:
    """n Steam apps that all share one title, so every one needs a fetch."""
    return [[str(1000 + i), "Prey", "gold", 1, 0, "steam"] for i in range(n)]


def test_consecutive_failures_bail_and_keep_partial_cache(tmp_path, monkeypatch):
    """Steam throttling (or the shared breaker, #411) makes every fetch fail.
    The loop stops at CONSECUTIVE_FAILURE_LIMIT instead of burning the cap,
    and nothing is cached for the failed apps."""
    from scripts.pipeline import release_years as ry
    _write_index(tmp_path, _colliding(30))
    lines = []
    monkeypatch.setattr(ry, "log", lines.append)
    calls = []
    monkeypatch.setattr(ry, "_fetch_year", lambda app_id: (calls.append(app_id), (None, False))[1])
    enrich_search_index_with_release_years(tmp_path)
    assert len(calls) == ry.CONSECUTIVE_FAILURE_LIMIT
    assert any("bailing early: 8 consecutive transport failures" in line for line in lines)
    cache = json.loads((tmp_path / ry.CACHE_FILENAME).read_text())
    assert cache == {}


def test_wall_clock_budget_bails(tmp_path, monkeypatch):
    from scripts.pipeline import release_years as ry
    _write_index(tmp_path, _colliding(5))
    ticks = iter([0.0, 0.0, ry.WALL_CLOCK_BUDGET_SEC + 1])
    monkeypatch.setattr(ry.time, "monotonic", lambda: next(ticks))
    lines = []
    monkeypatch.setattr(ry, "log", lines.append)
    monkeypatch.setattr(ry, "_fetch_year", lambda app_id: (2017, True))
    enrich_search_index_with_release_years(tmp_path)
    assert any("wall-clock budget" in line and "probed 1 of 5" in line for line in lines)


def test_cache_is_saved_mid_run(tmp_path, monkeypatch):
    from scripts.pipeline import release_years as ry
    _write_index(tmp_path, _colliding(ry.CACHE_SAVE_EVERY))
    monkeypatch.setattr(ry, "_fetch_year", lambda app_id: (2006, True))
    writes = []
    real_write = Path.write_text

    def spy(self, *a, **kw):
        if self.name == ry.CACHE_FILENAME:
            writes.append(self)
        return real_write(self, *a, **kw)

    monkeypatch.setattr(Path, "write_text", spy)
    enrich_search_index_with_release_years(tmp_path)
    assert len(writes) == 2   # once at CACHE_SAVE_EVERY, once at the end


def test_unreadable_cache_and_index_are_tolerated(tmp_path):
    from scripts.pipeline import release_years as ry
    (tmp_path / ry.CACHE_FILENAME).write_text("{not json")
    assert ry._load_cache(tmp_path / ry.CACHE_FILENAME) == {}
    (tmp_path / "search-index.json").write_text("{not json")
    enrich_search_index_with_release_years(tmp_path)   # logs and returns
    (tmp_path / "search-index.json").write_text("{}")
    enrich_search_index_with_release_years(tmp_path)   # not a list: no-op


def test_malformed_index_rows_are_skipped(tmp_path):
    _write_index(tmp_path, [[], "junk", ["570", "Dota 2", "gold", 1, 0, "steam"]])
    enrich_search_index_with_release_years(tmp_path)   # no collisions among real rows
    assert not (tmp_path / "release-years-cache.json").exists()
