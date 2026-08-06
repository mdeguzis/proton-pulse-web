"""generate_sgdb_covers: name-search fallback for non-Steam widescreen covers (#466).

The pipeline asks SteamGridDB for a 460x215 grid using each non-Steam
game's title so pgwiki:pw_*, gog:*, and epic:* rows can render the same
widescreen slot as a Steam-header game. Cached in sgdb-covers-cache.json
so a probed entry only re-hits SGDB after STALE_DAYS.
"""

import json
from unittest.mock import patch

from scripts.pipeline import finalize as _finalize


def test_generate_sgdb_covers_writes_empty_when_api_key_missing(tmp_path, monkeypatch):
    """No SGDB_API_KEY = skip entirely, no files written -- same escape hatch
    the existing Steam-appId SGDB fallback uses."""
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "")
    (tmp_path / "data").mkdir()
    _finalize.generate_sgdb_covers(
        tmp_path,
        tmp_path / "data",
        gog_catalog={"1207658691": "Witcher 3"},
    )
    # Skip path writes nothing.
    assert not (tmp_path / "sgdb-covers.json").exists()
    assert not (tmp_path / "sgdb-covers-cache.json").exists()


def test_generate_sgdb_covers_probes_every_catalog_and_writes_map(tmp_path, monkeypatch):
    """Cold cache: every non-Steam id gets probed once, hits go into
    sgdb-covers.json, cache records probed_at + name for staleness gating."""
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    (tmp_path / "data").mkdir()

    def _fake(name, timeout=8):
        # Non-empty title -> deterministic URL; empty -> None (matches real).
        return f"https://sgdb.example/{name.replace(' ', '_')}.png" if name else None

    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name", side_effect=_fake):
        _finalize.generate_sgdb_covers(
            tmp_path,
            tmp_path / "data",
            gog_catalog={"1207658691": "Witcher 3"},
            epic_catalog={"fortnite": "Fortnite"},
            pcgwiki_catalog={"pgwiki:pw_rl": {"name": "Rocket League"}},
        )

    covers = json.loads((tmp_path / "sgdb-covers.json").read_text())
    assert covers["gog:1207658691"] == "https://sgdb.example/Witcher_3.png"
    assert covers["epic:fortnite"] == "https://sgdb.example/Fortnite.png"
    assert covers["pgwiki:pw_rl"] == "https://sgdb.example/Rocket_League.png"

    cache = json.loads((tmp_path / "sgdb-covers-cache.json").read_text())
    for cid in ("gog:1207658691", "epic:fortnite", "pgwiki:pw_rl"):
        assert cid in cache
        assert cache[cid]["url"] is not None
        assert cache[cid]["probed_at"]  # ISO date string, format checked below
        assert len(cache[cid]["probed_at"]) == 10  # YYYY-MM-DD


def test_generate_sgdb_covers_reuses_recent_cache_without_probing(tmp_path, monkeypatch):
    """A fresh cache entry must skip the SGDB call so the free-tier budget
    is spent only on entries that actually need a refresh."""
    from datetime import date
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    (tmp_path / "data").mkdir()
    today = date.today().isoformat()
    # Pre-seed the cache with a fresh entry.
    (tmp_path / "sgdb-covers-cache.json").write_text(json.dumps({
        "gog:1": {"url": "https://sgdb.example/cached.png", "probed_at": today, "name": "Cached Game"},
    }))
    calls = []

    def _fake(name, timeout=8):
        calls.append(name)
        return None

    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name", side_effect=_fake):
        _finalize.generate_sgdb_covers(tmp_path, tmp_path / "data", gog_catalog={"1": "Cached Game"})

    assert calls == []  # cache hit, no fetch
    covers = json.loads((tmp_path / "sgdb-covers.json").read_text())
    assert covers["gog:1"] == "https://sgdb.example/cached.png"


def test_generate_sgdb_covers_remembers_negative_lookups(tmp_path, monkeypatch):
    """A None response caches the failure so we don't retry every run --
    saves the free-tier budget from repeated dead lookups."""
    from datetime import date
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    (tmp_path / "data").mkdir()
    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name", return_value=None):
        _finalize.generate_sgdb_covers(tmp_path, tmp_path / "data", gog_catalog={"1": "Obscure"})

    covers = json.loads((tmp_path / "sgdb-covers.json").read_text())
    assert "gog:1" not in covers  # No hit means nothing shipped to the frontend
    cache = json.loads((tmp_path / "sgdb-covers-cache.json").read_text())
    assert cache["gog:1"]["url"] is None  # But cache remembers the miss
    assert cache["gog:1"]["probed_at"] == date.today().isoformat()


def test_fetch_sgdb_by_name_early_returns_when_key_missing(monkeypatch):
    """Sanity: the helper itself short-circuits on empty API key, matching
    _fetch_sgdb_header's contract for the Steam-appId lookup path."""
    from scripts.pipeline.game_images import _fetch_sgdb_by_name
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "")
    assert _fetch_sgdb_by_name("Rocket League") is None


def test_fetch_sgdb_by_name_early_returns_when_name_blank(monkeypatch):
    """Empty / whitespace-only titles never get sent to the API. Otherwise
    we'd waste a call on the autocomplete endpoint with a nonsense query."""
    from scripts.pipeline.game_images import _fetch_sgdb_by_name
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    assert _fetch_sgdb_by_name("") is None
    assert _fetch_sgdb_by_name("   ") is None
