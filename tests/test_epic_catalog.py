import json
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import scripts.pipeline.epic_catalog as epic_module
from scripts.pipeline.epic_catalog import load_epic_catalog, flush_epic_catalog_cache


def _reset():
    epic_module._epic_catalog_cache = None


def _make_response(elements: list[dict], total: int) -> bytes:
    return json.dumps({
        "data": {
            "Catalog": {
                "searchStore": {
                    "elements": elements,
                    "paging": {"count": len(elements), "total": total},
                }
            }
        }
    }).encode("utf-8")


def _mock_urlopen(pages: list[list[dict]], total: int | None = None):
    t = total if total is not None else sum(len(p) for p in pages)
    call_count = {"n": 0}

    class FakeResp:
        def read(self):
            idx = min(call_count["n"], len(pages) - 1)
            call_count["n"] += 1
            return _make_response(pages[idx], t)
        def __enter__(self): return self
        def __exit__(self, *a): pass

    return MagicMock(return_value=FakeResp())


def test_load_from_fresh_cache(tmp_path):
    _reset()
    cache_path = tmp_path / "epic-catalog-cache.json"
    cache_path.write_text(json.dumps({
        "_ts": int(time.time()),
        "catalog": {"epictestns": "Test Game"},
    }))
    result = load_epic_catalog(cache_path=cache_path)
    assert result == {"epictestns": "Test Game"}
    _reset()


def test_load_ignores_stale_cache(tmp_path):
    _reset()
    cache_path = tmp_path / "epic-catalog-cache.json"
    old_ts = int(time.time()) - 8 * 86400
    cache_path.write_text(json.dumps({
        "_ts": old_ts,
        "catalog": {"oldns": "Old Game"},
    }))
    products = [{"namespace": "newns", "title": "New Game"}]
    with patch("scripts.pipeline.epic_catalog.request.urlopen", _mock_urlopen([products], total=1)):
        result = load_epic_catalog(cache_path=cache_path)
    assert "newns" in result
    assert "oldns" not in result
    _reset()


def test_load_writes_cache_after_fetch(tmp_path):
    _reset()
    cache_path = tmp_path / "epic-catalog-cache.json"
    products = [{"namespace": "mygame", "title": "My Game"}]
    with patch("scripts.pipeline.epic_catalog.request.urlopen", _mock_urlopen([products], total=1)):
        load_epic_catalog(cache_path=cache_path)
    assert cache_path.exists()
    cached = json.loads(cache_path.read_text())
    assert "mygame" in cached["catalog"]
    _reset()


def test_load_uses_in_memory_cache_on_second_call(tmp_path):
    _reset()
    cache_path = tmp_path / "missing.json"
    products = [{"namespace": "gamea", "title": "Game A"}]
    with patch("scripts.pipeline.epic_catalog.request.urlopen", _mock_urlopen([products], total=1)) as m:
        load_epic_catalog(cache_path=cache_path)
        load_epic_catalog(cache_path=cache_path)
    assert m.call_count == 1
    _reset()


def test_load_returns_empty_on_fetch_error(tmp_path):
    _reset()
    cache_path = tmp_path / "missing.json"
    with patch("scripts.pipeline.epic_catalog.request.urlopen", side_effect=OSError("network down")):
        result = load_epic_catalog(cache_path=cache_path)
    assert result == {}
    _reset()


def test_flush_clears_in_memory_cache():
    _reset()
    epic_module._epic_catalog_cache = {"ns": "Game"}
    flush_epic_catalog_cache()
    assert epic_module._epic_catalog_cache is None


def test_skips_elements_with_missing_namespace(tmp_path):
    _reset()
    cache_path = tmp_path / "epic-catalog-cache.json"
    products = [
        {"namespace": "", "title": "No Namespace"},
        {"namespace": "goodns", "title": "Good Game"},
    ]
    with patch("scripts.pipeline.epic_catalog.request.urlopen", _mock_urlopen([products], total=2)):
        result = load_epic_catalog(cache_path=cache_path)
    assert "goodns" in result
    assert "" not in result
    _reset()


# ── _fetch_page retry behavior (rate limiting) ────────────────────────────────

import pytest  # noqa: E402
from email.message import Message  # noqa: E402
from urllib.error import HTTPError  # noqa: E402


def _http_error(code):
    return HTTPError("https://store.epicgames.com/graphql", code, "err", Message(), None)


def test_fetch_page_retries_on_429_then_succeeds():
    calls = {"n": 0}

    class FakeResp:
        def read(self):
            return _make_response([{"namespace": "ns1", "title": "Game"}], total=40)
        def __enter__(self): return self
        def __exit__(self, *a): pass

    def fake_urlopen(req, timeout=30):
        calls["n"] += 1
        if calls["n"] < 3:
            raise _http_error(429)
        return FakeResp()

    with patch("scripts.pipeline.epic_catalog.request.urlopen", side_effect=fake_urlopen), \
         patch("scripts.pipeline.epic_catalog.time.sleep"):
        data = epic_module._fetch_page(0)
    assert calls["n"] == 3
    assert data["data"]["Catalog"]["searchStore"]["elements"][0]["title"] == "Game"


def test_fetch_page_gives_up_after_max_attempts():
    def fake_urlopen(req, timeout=30):
        raise _http_error(503)
    with patch("scripts.pipeline.epic_catalog.request.urlopen", side_effect=fake_urlopen), \
         patch("scripts.pipeline.epic_catalog.time.sleep"):
        with pytest.raises(HTTPError):
            epic_module._fetch_page(0)


def test_fetch_page_does_not_retry_non_transient_status():
    calls = {"n": 0}
    def fake_urlopen(req, timeout=30):
        calls["n"] += 1
        raise _http_error(400)
    with patch("scripts.pipeline.epic_catalog.request.urlopen", side_effect=fake_urlopen), \
         patch("scripts.pipeline.epic_catalog.time.sleep"):
        with pytest.raises(HTTPError):
            epic_module._fetch_page(0)
    assert calls["n"] == 1


# ── cover image capture ───────────────────────────────────────────────────────

def test_pick_cover_prefers_wide_types():
    images = [
        {"type": "Thumbnail", "url": "https://img/thumb.jpg"},
        {"type": "DieselStoreFrontWide", "url": "https://img/wide.jpg"},
    ]
    assert epic_module._pick_cover(images) == "https://img/wide.jpg"


def test_pick_cover_falls_back_to_any_url():
    images = [{"type": "SomethingElse", "url": "https://img/other.jpg"}]
    assert epic_module._pick_cover(images) == "https://img/other.jpg"


def test_pick_cover_empty_returns_blank():
    assert epic_module._pick_cover([]) == ""
    assert epic_module._pick_cover(None) == ""


def test_fetch_page_captures_covers():
    def fake_urlopen(req, timeout=30):
        class FakeResp:
            def read(self):
                return json.dumps({
                    "data": {"Catalog": {"searchStore": {
                        "elements": [{
                            "namespace": "ns1", "title": "Game",
                            "keyImages": [{"type": "OfferImageWide", "url": "https://img/g.jpg"}],
                        }],
                        "paging": {"count": 1, "total": 1},
                    }}}
                }).encode("utf-8")
            def __enter__(self): return self
            def __exit__(self, *a): pass
        return FakeResp()
    epic_module._epic_catalog_cache = None
    epic_module._epic_covers_cache = None
    with patch("scripts.pipeline.epic_catalog.request.urlopen", side_effect=fake_urlopen), \
         patch("scripts.pipeline.epic_catalog.time.sleep"):
        catalog, covers = epic_module._fetch_all_pages()
    assert catalog == {"ns1": "Game"}
    assert covers == {"ns1": "https://img/g.jpg"}
