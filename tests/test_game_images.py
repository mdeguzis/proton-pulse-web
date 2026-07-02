import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.game_images import build_game_images, _collect_all_app_ids


def _make_data_dir(tmp_path, app_ids):
    data = tmp_path / "data"
    data.mkdir()
    for aid in app_ids:
        (data / str(aid)).mkdir()
    return data


def test_collect_all_app_ids_from_data_dir(tmp_path):
    _make_data_dir(tmp_path, ["570", "730", "12345"])
    ids = _collect_all_app_ids(tmp_path / "data")
    assert ids == ["570", "730", "12345"]


def test_collect_skips_non_numeric_dirs(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "570").mkdir()
    (data / "some-non-id").mkdir()
    ids = _collect_all_app_ids(data)
    assert ids == ["570"]


def test_build_uses_skip_cache(tmp_path):
    _make_data_dir(tmp_path, ["570", "730"])
    # 570 already in skip cache; only 730 should be probed
    skip = {"ids": ["570"]}
    (tmp_path / "game-images-skip.json").write_text(json.dumps(skip), encoding="utf-8")

    probed = []

    def fake_url_ok(url, timeout=8):
        app_id = url.split("/apps/")[1].split("/")[0]
        probed.append(app_id)
        return True  # standard URL ok

    with patch("scripts.pipeline.game_images._url_is_ok", side_effect=fake_url_ok):
        build_game_images(tmp_path)

    assert "570" not in probed
    assert "730" in probed


def test_build_preserves_existing_overrides(tmp_path):
    _make_data_dir(tmp_path, ["999"])
    existing = {"570": "https://example.com/570.jpg"}
    (tmp_path / "game-images.json").write_text(json.dumps(existing), encoding="utf-8")

    with patch("scripts.pipeline.game_images._url_is_ok", return_value=True):
        result = build_game_images(tmp_path)

    assert result["570"] == "https://example.com/570.jpg"


def test_build_adds_override_when_standard_404s(tmp_path):
    _make_data_dir(tmp_path, ["12345"])

    def fake_url_ok(url, timeout=8):
        return False  # standard URL 404s

    def fake_fetch(app_id, store_up, timeout=10):
        return ("https://cdn.steam.com/hashed/12345/header_abc.jpg?t=123", "live")

    with patch("scripts.pipeline.game_images._url_is_ok", side_effect=fake_url_ok), \
         patch("scripts.pipeline.game_images._fetch_steam_header", side_effect=fake_fetch):
        result = build_game_images(tmp_path)

    # Query string stripped
    assert result["12345"] == "https://cdn.steam.com/hashed/12345/header_abc.jpg"


def test_build_falls_back_to_sgdb_when_steam_apis_yield_nothing(tmp_path):
    # Steam CDN 404s, appdetails returns no URL, but SteamGridDB has
    # community artwork. Row is written with status='sgdb' and the
    # SGDB URL lands in the frontend override map.
    _make_data_dir(tmp_path, ["55555"])
    sgdb_url = "https://cdn.steamgriddb.com/grid/abc123.png"

    with patch("scripts.pipeline.game_images._url_is_ok", side_effect=lambda url, timeout=8: url == sgdb_url), \
         patch("scripts.pipeline.game_images._fetch_steam_header", return_value=(None, "live")), \
         patch("scripts.pipeline.game_images._fetch_sgdb_header", return_value=sgdb_url):
        result = build_game_images(tmp_path)

    assert result["55555"] == sgdb_url
    cache = json.loads((tmp_path / "game-images-cache.json").read_text(encoding="utf-8"))
    assert cache["55555"]["status"] == "sgdb"
    assert cache["55555"]["url"] == sgdb_url


def test_build_still_missing_when_sgdb_also_returns_nothing(tmp_path):
    # SGDB fallback fires but has no match either -- row stays "missing"
    # and does NOT appear in the frontend override map.
    _make_data_dir(tmp_path, ["66666"])

    with patch("scripts.pipeline.game_images._url_is_ok", return_value=False), \
         patch("scripts.pipeline.game_images._fetch_steam_header", return_value=(None, "live")), \
         patch("scripts.pipeline.game_images._fetch_sgdb_header", return_value=None):
        result = build_game_images(tmp_path)

    assert "66666" not in result
    cache = json.loads((tmp_path / "game-images-cache.json").read_text(encoding="utf-8"))
    assert cache["66666"]["status"] == "missing"


def test_build_skips_sgdb_when_url_probe_fails(tmp_path):
    # SGDB returned a URL but it 404s on verification -- treat as
    # missing rather than stamp a broken URL into the override map.
    _make_data_dir(tmp_path, ["77777"])
    bad_url = "https://cdn.steamgriddb.com/grid/dead.png"

    # _url_is_ok returns False for every URL (standard AND sgdb)
    with patch("scripts.pipeline.game_images._url_is_ok", return_value=False), \
         patch("scripts.pipeline.game_images._fetch_steam_header", return_value=(None, "live")), \
         patch("scripts.pipeline.game_images._fetch_sgdb_header", return_value=bad_url):
        result = build_game_images(tmp_path)

    assert "77777" not in result
    cache = json.loads((tmp_path / "game-images-cache.json").read_text(encoding="utf-8"))
    assert cache["77777"]["status"] == "missing"


def test_build_adds_to_cache_when_standard_ok(tmp_path):
    _make_data_dir(tmp_path, ["730"])

    with patch("scripts.pipeline.game_images._url_is_ok", return_value=True):
        build_game_images(tmp_path)

    cache = json.loads((tmp_path / "game-images-cache.json").read_text(encoding="utf-8"))
    assert cache.get("730", {}).get("status") == "ok"


def test_build_respects_probe_cap(tmp_path):
    _make_data_dir(tmp_path, [str(i) for i in range(1000, 1020)])  # 20 games

    probed = []

    def fake_url_ok(url, timeout=8):
        app_id = url.split("/apps/")[1].split("/")[0]
        probed.append(app_id)
        return True

    with patch("scripts.pipeline.game_images.PROBE_CAP", 5), \
         patch("scripts.pipeline.game_images._url_is_ok", side_effect=fake_url_ok):
        build_game_images(tmp_path)

    assert len(probed) == 5


def _write_extended_index(tmp_path, app_ids):
    entries = [[str(a), f"Stub {a}", "", 0, 0, "steam"] for a in app_ids]
    (tmp_path / "search-index-steam-extended.json").write_text(
        json.dumps(entries), encoding="utf-8"
    )


def test_build_probes_extended_steam_stubs(tmp_path):
    # No report apps at all, only extended catalog stubs (no data/ dir entries)
    _make_data_dir(tmp_path, [])
    _write_extended_index(tmp_path, ["555001", "555002"])

    probed = []

    def fake_url_ok(url, timeout=8):
        probed.append(url.split("/apps/")[1].split("/")[0])
        return True

    with patch("scripts.pipeline.game_images._url_is_ok", side_effect=fake_url_ok):
        build_game_images(tmp_path)

    assert "555001" in probed
    assert "555002" in probed


def test_extended_stubs_drain_after_report_backlog(tmp_path):
    # Two report apps + one extended stub, cap of 2: report apps drain first,
    # the extended stub is deferred to a later run.
    _make_data_dir(tmp_path, ["1000", "1001"])
    _write_extended_index(tmp_path, ["555001"])

    probed = []

    def fake_url_ok(url, timeout=8):
        probed.append(url.split("/apps/")[1].split("/")[0])
        return True

    with patch("scripts.pipeline.game_images.PROBE_CAP", 2), \
         patch("scripts.pipeline.game_images._url_is_ok", side_effect=fake_url_ok):
        build_game_images(tmp_path)

    assert len(probed) == 2
    assert "555001" not in probed


def test_build_writes_both_output_files(tmp_path):
    _make_data_dir(tmp_path, ["570"])

    with patch("scripts.pipeline.game_images._url_is_ok", return_value=True):
        build_game_images(tmp_path)

    assert (tmp_path / "game-images.json").exists()
    assert (tmp_path / "game-images-cache.json").exists()
