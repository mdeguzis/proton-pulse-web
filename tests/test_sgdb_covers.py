"""generate_sgdb_covers: rate-limited name-search fallback for non-Steam
widescreen covers (#466, hardened in #467).

The pipeline asks SteamGridDB for a 460x215 grid using each non-Steam
game's title so pgwiki:pw_*, gog:*, and epic:* rows can render the same
widescreen slot as a Steam-header game. Cached in sgdb-covers-cache.json;
rate-limited to SGDB_REQUEST_DELAY per call; bounded per run by
SGDB_PROBE_CAP so a cold cache never sits in the API for hours.
"""

import json
from unittest.mock import patch

from scripts.pipeline import finalize as _finalize


def _fake_ok(name, timeout=8):
    """Return the (url, err) shape _fetch_sgdb_by_name uses."""
    return (f"https://sgdb.example/{name.replace(' ', '_')}.png", None) if name else (None, "empty_name")


def _fake_none(reason):
    def _inner(name, timeout=8):
        return (None, reason)
    return _inner


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
    assert not (tmp_path / "sgdb-covers.json").exists()
    assert not (tmp_path / "sgdb-covers-cache.json").exists()


def test_generate_sgdb_covers_probes_every_catalog_and_writes_map(tmp_path, monkeypatch):
    """Cold cache: every non-Steam id gets probed once (up to the cap), hits
    go into sgdb-covers.json, cache records probed_at + name + last_error."""
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_PROBE_CAP", 500)
    (tmp_path / "data").mkdir()

    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name", side_effect=_fake_ok):
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
        assert cache[cid]["url"] is not None
        assert len(cache[cid]["probed_at"]) == 10
        # #467: last_error is stored (None on success) so a future run can
        # differentiate transient rate-limit failures from real misses.
        assert cache[cid]["last_error"] is None


def test_generate_sgdb_covers_reuses_recent_cache_without_probing(tmp_path, monkeypatch):
    """A fresh non-rate-limited cache entry must skip the SGDB call so the
    free-tier budget is spent only on entries that actually need a refresh."""
    from datetime import date
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    (tmp_path / "data").mkdir()
    today = date.today().isoformat()
    (tmp_path / "sgdb-covers-cache.json").write_text(json.dumps({
        "gog:1": {"url": "https://sgdb.example/cached.png", "probed_at": today, "name": "Cached Game", "last_error": None},
    }))
    calls = []

    def _fake(name, timeout=8):
        calls.append(name)
        return (None, "no_matches")

    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name", side_effect=_fake):
        _finalize.generate_sgdb_covers(tmp_path, tmp_path / "data", gog_catalog={"1": "Cached Game"})

    assert calls == []
    covers = json.loads((tmp_path / "sgdb-covers.json").read_text())
    assert covers["gog:1"] == "https://sgdb.example/cached.png"


def test_generate_sgdb_covers_remembers_negative_lookups(tmp_path, monkeypatch):
    """A no_matches response caches the failure with a real reason so future
    runs skip it for STALE_DAYS -- saves the free-tier budget."""
    from datetime import date
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    (tmp_path / "data").mkdir()
    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name",
               side_effect=_fake_none("no_matches")):
        _finalize.generate_sgdb_covers(tmp_path, tmp_path / "data", gog_catalog={"1": "Obscure"})

    covers = json.loads((tmp_path / "sgdb-covers.json").read_text())
    assert "gog:1" not in covers
    cache = json.loads((tmp_path / "sgdb-covers-cache.json").read_text())
    assert cache["gog:1"]["url"] is None
    assert cache["gog:1"]["last_error"] == "no_matches"
    assert cache["gog:1"]["probed_at"] == date.today().isoformat()


def test_generate_sgdb_covers_retries_rate_limited_cache_entries(tmp_path, monkeypatch):
    """#467: a transient http_429_gave_up in the cache MUST be retried on the
    next run, not treated as a persistent no-hit. Otherwise a burst of 429s
    would poison the cache and the entry would never get a real cover."""
    from datetime import date
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_PROBE_CAP", 500)
    (tmp_path / "data").mkdir()
    today = date.today().isoformat()
    (tmp_path / "sgdb-covers-cache.json").write_text(json.dumps({
        "gog:1": {"url": None, "probed_at": today, "name": "Rate Limited Game", "last_error": "http_429_gave_up"},
    }))
    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name", side_effect=_fake_ok):
        _finalize.generate_sgdb_covers(tmp_path, tmp_path / "data", gog_catalog={"1": "Rate Limited Game"})

    covers = json.loads((tmp_path / "sgdb-covers.json").read_text())
    assert covers["gog:1"] == "https://sgdb.example/Rate_Limited_Game.png"
    cache = json.loads((tmp_path / "sgdb-covers-cache.json").read_text())
    assert cache["gog:1"]["last_error"] is None


def test_generate_sgdb_covers_respects_probe_cap(tmp_path, monkeypatch):
    """#467: with SGDB_PROBE_CAP=2, only 2 catalog entries get freshly probed
    per run even if 5 are eligible. Successive runs chip through the rest
    via the cache."""
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_PROBE_CAP", 2)
    (tmp_path / "data").mkdir()
    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name", side_effect=_fake_ok) as m:
        _finalize.generate_sgdb_covers(
            tmp_path, tmp_path / "data",
            gog_catalog={"1": "A", "2": "B", "3": "C", "4": "D", "5": "E"},
        )
    assert m.call_count == 2


def test_generate_sgdb_covers_prioritises_games_with_data_on_disk(tmp_path, monkeypatch):
    """#467: an entry whose data/{id}/ dir already exists is a game users
    view, so it should get probed before a cold catalog stub."""
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_PROBE_CAP", 1)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    # Only the hot id has a data dir. app_id_to_dir maps gog:hot -> gog_hot.
    (data_dir / "gog_hot").mkdir(parents=True)
    with patch("scripts.pipeline.game_images._fetch_sgdb_by_name", side_effect=_fake_ok) as m:
        _finalize.generate_sgdb_covers(
            tmp_path, data_dir,
            gog_catalog={"hot": "Hot Game", "cold": "Cold Stub"},
        )
    assert m.call_count == 1
    # The hot game (with data on disk) was the one probed, not the cold stub.
    m.assert_called_once_with("Hot Game")


def test_fetch_sgdb_by_name_early_returns_when_key_missing(monkeypatch):
    """Sanity: the helper itself short-circuits on empty API key."""
    from scripts.pipeline.game_images import _fetch_sgdb_by_name
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "")
    url, err = _fetch_sgdb_by_name("Rocket League")
    assert url is None
    assert err == "no_api_key"


def test_fetch_sgdb_by_name_early_returns_when_name_blank(monkeypatch):
    """Empty / whitespace-only titles never get sent to the API."""
    from scripts.pipeline.game_images import _fetch_sgdb_by_name
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    for blank in ("", "   ", "\t\n"):
        url, err = _fetch_sgdb_by_name(blank)
        assert url is None
        assert err == "empty_name"


def test_sgdb_request_retries_once_on_429(monkeypatch):
    """#467: a single 429 must retry with backoff, not fail immediately.
    Prevents a transient rate-limit from being remembered as a permanent
    no-hit."""
    from scripts.pipeline import game_images as _gi
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_REQUEST_DELAY", 0)
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_BACKOFF_BASE", 0)
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_MAX_RETRIES", 2)

    call_count = [0]

    class _FakeOk:
        def read(self):
            return b'{"success": true, "data": {"id": 42}}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _fake_urlopen(req, timeout=8):
        call_count[0] += 1
        if call_count[0] == 1:
            import urllib.error
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)
        return _FakeOk()

    monkeypatch.setattr(_gi.urllib.request, "urlopen", _fake_urlopen)
    body, err = _gi._sgdb_request("https://sgdb.example/test")
    assert call_count[0] == 2  # first 429, then success on retry
    assert err is None
    assert body["data"]["id"] == 42


def test_sgdb_request_gives_up_after_max_retries(monkeypatch):
    """After SGDB_MAX_RETRIES consecutive 429s we surface http_429_gave_up
    so the caller (and cache) can distinguish a rate-limit run from a
    genuine no-hit."""
    from scripts.pipeline import game_images as _gi
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_REQUEST_DELAY", 0)
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_BACKOFF_BASE", 0)
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_MAX_RETRIES", 2)

    def _fake_urlopen(req, timeout=8):
        import urllib.error
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(_gi.urllib.request, "urlopen", _fake_urlopen)
    body, err = _gi._sgdb_request("https://sgdb.example/test")
    assert body is None
    assert err == "http_429_gave_up"


def test_sgdb_request_surfaces_401_immediately(monkeypatch):
    """A 401 (auth failure) is NOT retried -- it's a config issue that will
    not clear on backoff. Caller uses the http_401 reason to log the real
    problem instead of pretending we got no matches."""
    from scripts.pipeline import game_images as _gi
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_API_KEY", "test-key")
    monkeypatch.setattr("scripts.pipeline.game_images.SGDB_REQUEST_DELAY", 0)

    def _fake_urlopen(req, timeout=8):
        import urllib.error
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(_gi.urllib.request, "urlopen", _fake_urlopen)
    body, err = _gi._sgdb_request("https://sgdb.example/test")
    assert body is None
    assert err == "http_401"
