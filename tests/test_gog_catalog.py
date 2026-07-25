import json
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import scripts.pipeline.gog_catalog as gog_module
from scripts.pipeline.gog_catalog import load_gog_catalog, flush_gog_catalog_cache


def _reset():
    gog_module._gog_catalog_cache = None


def _make_page(products: list, total_pages: int = 1, total_results: int = 1) -> bytes:
    # catalog.gog.com/v1/catalog response shape: pages + productCount + products.
    return json.dumps({
        "products": products,
        "pages": total_pages,
        "productCount": total_results,
    }).encode("utf-8")


def _mock_urlopen(pages: list[list[dict]], total_pages: int | None = None):
    tp = total_pages if total_pages is not None else len(pages)
    call_count = {"n": 0}

    class FakeResp:
        def read(self):
            idx = min(call_count["n"], len(pages) - 1)
            call_count["n"] += 1
            return _make_page(pages[idx], total_pages=tp, total_results=tp * 48)
        def __enter__(self): return self
        def __exit__(self, *a): pass

    return MagicMock(return_value=FakeResp())


# ── load_gog_catalog: cache hit ───────────────────────────────────────────────

def test_load_from_fresh_cache(tmp_path):
    _reset()
    cache_path = tmp_path / "gog-catalog-cache.json"
    cache_path.write_text(json.dumps({
        "_ts": int(time.time()),
        "catalog": {"1234": "Swat 4"},
    }))
    result = load_gog_catalog(cache_path=cache_path)
    assert result == {"1234": "Swat 4"}
    _reset()

def test_load_ignores_stale_cache(tmp_path):
    _reset()
    cache_path = tmp_path / "gog-catalog-cache.json"
    old_ts = int(time.time()) - 8 * 86400  # 8 days old
    cache_path.write_text(json.dumps({
        "_ts": old_ts,
        "catalog": {"9999": "Old Game"},
    }))
    products = [{"id": 1234, "title": "Swat 4"}]
    with patch("scripts.pipeline.gog_catalog.request.urlopen", _mock_urlopen([products])):
        result = load_gog_catalog(cache_path=cache_path)
    assert "1234" in result
    assert "9999" not in result
    _reset()

def test_load_writes_cache_after_fetch(tmp_path):
    _reset()
    cache_path = tmp_path / "gog-catalog-cache.json"
    products = [{"id": 5678, "title": "Witcher 3"}]
    with patch("scripts.pipeline.gog_catalog.request.urlopen", _mock_urlopen([products])):
        load_gog_catalog(cache_path=cache_path)
    assert cache_path.exists()
    cached = json.loads(cache_path.read_text())
    assert "5678" in cached["catalog"]
    _reset()

def test_load_uses_in_memory_cache_on_second_call(tmp_path):
    _reset()
    cache_path = tmp_path / "missing.json"
    products = [{"id": 111, "title": "Game A"}]
    with patch("scripts.pipeline.gog_catalog.request.urlopen", _mock_urlopen([products])) as m:
        load_gog_catalog(cache_path=cache_path)
        load_gog_catalog(cache_path=cache_path)
    assert m.call_count == 1  # second call used in-memory cache
    _reset()

def test_load_returns_empty_on_fetch_error(tmp_path):
    _reset()
    cache_path = tmp_path / "missing.json"
    with patch("scripts.pipeline.gog_catalog.request.urlopen", side_effect=OSError("network down")):
        result = load_gog_catalog(cache_path=cache_path)
    assert result == {}
    _reset()

def test_flush_clears_in_memory_cache(tmp_path):
    _reset()
    gog_module._gog_catalog_cache = {"1": "Cached"}
    flush_gog_catalog_cache()
    assert gog_module._gog_catalog_cache is None


# ── _fetch_page retry behavior (rate limiting) ────────────────────────────────

import pytest  # noqa: E402
from email.message import Message  # noqa: E402
from urllib.error import HTTPError, URLError  # noqa: E402


def _http_error(code):
    return HTTPError("https://embed.gog.com", code, "err", Message(), None)


def test_fetch_page_retries_on_429_then_succeeds():
    calls = {"n": 0}

    class FakeResp:
        def read(self):
            return _make_page([{"id": 1, "title": "Swat 4 Gold"}], total_pages=1)
        def __enter__(self): return self
        def __exit__(self, *a): pass

    def fake_urlopen(req, timeout=20):
        calls["n"] += 1
        if calls["n"] < 3:
            raise _http_error(429)
        return FakeResp()

    with patch("scripts.pipeline.gog_catalog.request.urlopen", side_effect=fake_urlopen), \
         patch("scripts.pipeline.gog_catalog.time.sleep"):
        data = gog_module._fetch_page(7)
    assert calls["n"] == 3  # two 429s retried, third succeeds
    assert data["products"][0]["title"] == "Swat 4 Gold"


def test_fetch_page_gives_up_after_max_attempts():
    def fake_urlopen(req, timeout=20):
        raise _http_error(429)
    with patch("scripts.pipeline.gog_catalog.request.urlopen", side_effect=fake_urlopen), \
         patch("scripts.pipeline.gog_catalog.time.sleep"):
        with pytest.raises(HTTPError):
            gog_module._fetch_page(1)


def test_fetch_page_does_not_retry_non_transient_status():
    calls = {"n": 0}
    def fake_urlopen(req, timeout=20):
        calls["n"] += 1
        raise _http_error(404)
    with patch("scripts.pipeline.gog_catalog.request.urlopen", side_effect=fake_urlopen), \
         patch("scripts.pipeline.gog_catalog.time.sleep"):
        with pytest.raises(HTTPError):
            gog_module._fetch_page(1)
    assert calls["n"] == 1  # 404 is not retried


def test_fetch_all_pages_skips_only_after_retries_exhausted():
    # page 2 always fails (after retries); pages 1 and 3 succeed. The catalog
    # must still contain games from the surviving pages, not bail entirely.
    def fake_fetch_page(page):
        if page == 2:
            raise _http_error(429)
        return json.loads(_make_page([{"id": page, "title": f"Game {page}"}], total_pages=3))
    with patch("scripts.pipeline.gog_catalog._fetch_page", side_effect=fake_fetch_page), \
         patch("scripts.pipeline.gog_catalog.time.sleep"):
        catalog, _covers, _years = gog_module._fetch_all_pages()
    assert catalog == {"1": "Game 1", "3": "Game 3"}


def test_fetch_all_pages_captures_cover_images():
    def fake_fetch_page(page):
        return {
            "products": [{"id": 5, "title": "Cover Game",
                          "coverHorizontal": "https://images.gog-statics.com/abc.png"}],
            "pages": 1,
            "productCount": 1,
        }
    with patch("scripts.pipeline.gog_catalog._fetch_page", side_effect=fake_fetch_page), \
         patch("scripts.pipeline.gog_catalog.time.sleep"):
        catalog, covers, _years = gog_module._fetch_all_pages()
    assert catalog == {"5": "Cover Game"}
    assert covers == {"5": "https://images.gog-statics.com/abc.png"}


def test_load_gog_covers_reads_from_cache(tmp_path):
    _reset()
    gog_module._gog_covers_cache = None
    cache_path = tmp_path / "gog-catalog-cache.json"
    cache_path.write_text(json.dumps({
        "_ts": int(time.time()),
        "catalog": {"5": "Cover Game"},
        "covers": {"5": "https://images.gog-statics.com/abc.png"},
    }))
    covers = gog_module.load_gog_covers(cache_path=cache_path)
    assert covers == {"5": "https://images.gog-statics.com/abc.png"}
    _reset()
    gog_module._gog_covers_cache = None
