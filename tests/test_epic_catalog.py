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
