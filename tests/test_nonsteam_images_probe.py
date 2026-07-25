"""Tests for scripts/pipeline/nonsteam_images_probe.py (#203)."""

import json
from unittest.mock import MagicMock, patch

from scripts.pipeline import nonsteam_images_probe as nip


def _resp(status=200):
    cm = MagicMock()
    cm.__enter__.return_value.status = status
    cm.__exit__.return_value = False
    return cm


def test_url_is_ok_true_on_200():
    with patch("urllib.request.urlopen", return_value=_resp(200)):
        assert nip._url_is_ok("https://x") is True


def test_url_is_ok_false_on_404():
    with patch("urllib.request.urlopen", return_value=_resp(404)):
        assert nip._url_is_ok("https://x") is False


def test_url_is_ok_false_on_error():
    with patch("urllib.request.urlopen", side_effect=Exception("boom")):
        assert nip._url_is_ok("https://x") is False


def test_url_is_ok_false_on_empty_url():
    assert nip._url_is_ok("") is False


def test_probe_writes_cache_and_filters_missing(tmp_path):
    """OK entries stay in the returned frontend map; 404s are dropped from the
    map but recorded in the cache as missing."""
    catalog = {
        "gog:1": "https://gog.example/covers/1.png",
        "gog:2": "https://gog.example/covers/2.png",
        "epic:foo": "https://epic.example/covers/foo.png",
    }
    responses = {
        "https://gog.example/covers/1.png": _resp(200),
        "https://gog.example/covers/2.png": _resp(404),
        "https://epic.example/covers/foo.png": _resp(200),
    }

    def fake_urlopen(req, timeout=8):
        return responses[req.full_url]

    with patch("urllib.request.urlopen", side_effect=fake_urlopen), \
         patch.object(nip, "REQUEST_DELAY", 0):
        filtered = nip.probe_nonsteam_images(tmp_path, catalog)

    assert set(filtered.keys()) == {"gog:1", "epic:foo"}
    cache = json.loads((tmp_path / "nonsteam-images-cache.json").read_text())
    assert cache["gog:1"]["status"] == "ok"
    assert cache["gog:2"]["status"] == "missing"
    assert cache["epic:foo"]["status"] == "ok"
    for entry in cache.values():
        assert entry["probed_at"]  # every entry stamped


def test_probe_reuses_fresh_cache_and_skips_url_check(tmp_path):
    """A recent cache entry short-circuits the HEAD probe. If nothing needs
    probing, urlopen must not be called at all."""
    catalog = {"gog:1": "https://gog.example/covers/1.png"}
    fresh_entry = {
        "url": "https://gog.example/covers/1.png",
        "status": "ok",
        "probed_at": "2050-01-01",  # far future -> definitely fresh
    }
    (tmp_path / "nonsteam-images-cache.json").write_text(
        json.dumps({"gog:1": fresh_entry})
    )
    with patch("urllib.request.urlopen") as m, patch.object(nip, "REQUEST_DELAY", 0):
        filtered = nip.probe_nonsteam_images(tmp_path, catalog)
    m.assert_not_called()
    assert filtered == {"gog:1": "https://gog.example/covers/1.png"}


def test_probe_reprobes_when_cached_url_changed(tmp_path):
    """Cache is keyed to a specific URL. If the catalog now returns a
    different URL for the same id, we must re-probe rather than trust the
    stale entry."""
    catalog = {"gog:1": "https://gog.example/NEW.png"}
    stale = {"url": "https://gog.example/OLD.png", "status": "ok", "probed_at": "2050-01-01"}
    (tmp_path / "nonsteam-images-cache.json").write_text(json.dumps({"gog:1": stale}))
    with patch("urllib.request.urlopen", return_value=_resp(200)), \
         patch.object(nip, "REQUEST_DELAY", 0):
        filtered = nip.probe_nonsteam_images(tmp_path, catalog)
    cache = json.loads((tmp_path / "nonsteam-images-cache.json").read_text())
    assert cache["gog:1"]["url"] == "https://gog.example/NEW.png"
    assert filtered == {"gog:1": "https://gog.example/NEW.png"}


def test_probe_purges_ids_no_longer_in_catalog(tmp_path):
    """Ids the catalog stopped returning should disappear from the cache so
    it doesn't grow forever with delisted GOG/Epic products."""
    catalog = {"gog:live": "https://gog.example/live.png"}
    old = {
        "gog:live":   {"url": "https://gog.example/live.png", "status": "ok", "probed_at": "2050-01-01"},
        "gog:gone":   {"url": "https://gog.example/gone.png", "status": "ok", "probed_at": "2050-01-01"},
        "epic:gone":  {"url": "https://epic.example/x.png",   "status": "ok", "probed_at": "2050-01-01"},
    }
    (tmp_path / "nonsteam-images-cache.json").write_text(json.dumps(old))
    with patch("urllib.request.urlopen") as m, patch.object(nip, "REQUEST_DELAY", 0):
        nip.probe_nonsteam_images(tmp_path, catalog)
    m.assert_not_called()
    cache = json.loads((tmp_path / "nonsteam-images-cache.json").read_text())
    assert set(cache.keys()) == {"gog:live"}


def test_probe_respects_backlog_cap(tmp_path):
    catalog = {f"gog:{i}": f"https://gog.example/{i}.png" for i in range(10)}
    with patch("urllib.request.urlopen", return_value=_resp(200)) as m, \
         patch.object(nip, "REQUEST_DELAY", 0), \
         patch.object(nip, "PROBE_CAP", 3):
        nip.probe_nonsteam_images(tmp_path, catalog)
    assert m.call_count == 3
    cache = json.loads((tmp_path / "nonsteam-images-cache.json").read_text())
    assert len(cache) == 3  # the 7 unprobed ids are not in the cache yet


# ---- missing-status retry (poisoned-cache fix) ------------------------------
# A transient CDN failure during one probe run wrote status=missing for a
# working URL (Coffee Noir, gog:1514133152) and the frontend map dropped the
# cover for a month. Missing entries now retry after MISSING_RETRY_DAYS and
# jump the backlog queue so the cap cannot starve them.

def test_missing_entries_go_stale_fast():
    from datetime import date, timedelta
    from scripts.pipeline.nonsteam_images_probe import _is_stale, MISSING_RETRY_DAYS, STALE_DAYS
    assert MISSING_RETRY_DAYS < STALE_DAYS
    old_enough = (date.today() - timedelta(days=MISSING_RETRY_DAYS + 1)).isoformat()
    fresh = date.today().isoformat()
    assert _is_stale({"status": "missing", "probed_at": old_enough, "url": "x"}) is True
    assert _is_stale({"status": "missing", "probed_at": fresh, "url": "x"}) is False
    # OK entries keep the long TTL
    assert _is_stale({"status": "ok", "probed_at": old_enough, "url": "x"}) is False


def test_missing_retries_jump_the_backlog_queue(tmp_path, monkeypatch):
    from datetime import date, timedelta
    import scripts.pipeline.nonsteam_images_probe as probe_mod
    stale_missing_day = (date.today() - timedelta(days=probe_mod.MISSING_RETRY_DAYS + 1)).isoformat()
    cache = {
        # a stale missing entry that must be retried FIRST
        "gog:111": {"url": "https://cdn/m.png", "status": "missing", "probed_at": stale_missing_day},
    }
    probed_order = []
    monkeypatch.setattr(probe_mod, "_load_cache", lambda _out: dict(cache))
    monkeypatch.setattr(probe_mod, "_hot_ids", lambda _out: set())
    monkeypatch.setattr(probe_mod, "_url_is_ok", lambda url, timeout=8: (probed_order.append(url), True)[1])
    monkeypatch.setattr(probe_mod, "PROBE_CAP", 2)
    monkeypatch.setattr(probe_mod.time, "sleep", lambda _s: None)
    catalog = {
        "gog:111": "https://cdn/m.png",
        # two uncached entries that would fill a cap of 2 on their own
        "gog:222": "https://cdn/a.png",
        "gog:333": "https://cdn/b.png",
    }
    result = probe_mod.probe_nonsteam_images(tmp_path, catalog)
    # the missing retry was probed first, within the cap
    assert probed_order[0] == "https://cdn/m.png"
    # and having succeeded, its cover is back in the frontend map
    assert result["gog:111"] == "https://cdn/m.png"
