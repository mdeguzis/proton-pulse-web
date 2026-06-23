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

    def fake_fetch(app_id, timeout=10):
        return "https://cdn.steam.com/hashed/12345/header_abc.jpg?t=123"

    with patch("scripts.pipeline.game_images._url_is_ok", side_effect=fake_url_ok), \
         patch("scripts.pipeline.game_images._fetch_steam_header", side_effect=fake_fetch):
        result = build_game_images(tmp_path)

    # Query string stripped
    assert result["12345"] == "https://cdn.steam.com/hashed/12345/header_abc.jpg"


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


def test_build_writes_both_output_files(tmp_path):
    _make_data_dir(tmp_path, ["570"])

    with patch("scripts.pipeline.game_images._url_is_ok", return_value=True):
        build_game_images(tmp_path)

    assert (tmp_path / "game-images.json").exists()
    assert (tmp_path / "game-images-cache.json").exists()
