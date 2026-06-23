import json
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import scripts.pipeline.gog_catalog as gog_module
from scripts.pipeline.gog_catalog import load_gog_catalog, flush_gog_catalog_cache


def _reset():
    gog_module._gog_catalog_cache = None


def _make_page(products: list, total_pages: int = 1, total_results: int = 1) -> bytes:
    return json.dumps({
        "products": products,
        "totalPages": total_pages,
        "totalResults": total_results,
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
