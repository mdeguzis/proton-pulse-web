"""Tests for the data/ content-hash manifest generator (issue #392)."""
import json

from scripts.pipeline.data_manifest import MANIFEST_NAME, _sha256, write_data_manifest


def _make_app(tmp_path, app_dir, files):
    d = tmp_path / "data" / app_dir
    d.mkdir(parents=True)
    for name, content in files.items():
        (d / name).write_text(content)
    return d


def test_hash_is_full_sha256_and_changes_with_content(tmp_path):
    f = tmp_path / "x.json"
    f.write_text("alpha")
    a = _sha256(f)
    f.write_text("beta")
    b = _sha256(f)
    assert a != b
    assert len(a) == 64
    int(a, 16)


def test_walks_app_dirs_with_posix_keys(tmp_path):
    _make_app(tmp_path, "730", {"latest.json": "[1]", "2024.json": "[1]", "index.json": '["2024"]'})
    _make_app(tmp_path, "gog_123", {"latest.json": "[2]"})
    manifest = write_data_manifest(tmp_path)
    assert set(manifest) == {"730/latest.json", "730/2024.json", "730/index.json", "gog_123/latest.json"}
    # identical content hashes identically across apps
    assert manifest["730/latest.json"] == manifest["730/2024.json"]
    on_disk = json.loads((tmp_path / MANIFEST_NAME).read_text())
    assert on_disk == manifest


def test_html_files_excluded_like_the_r2_sync(tmp_path):
    _make_app(tmp_path, "730", {"latest.json": "[1]", "index.html": "<html></html>"})
    manifest = write_data_manifest(tmp_path)
    assert "730/latest.json" in manifest
    assert "730/index.html" not in manifest


def test_manifest_written_at_output_root_not_under_data(tmp_path):
    _make_app(tmp_path, "730", {"latest.json": "[1]"})
    write_data_manifest(tmp_path)
    assert (tmp_path / MANIFEST_NAME).is_file()
    assert not (tmp_path / "data" / MANIFEST_NAME).exists()


def test_deterministic_across_runs(tmp_path):
    _make_app(tmp_path, "730", {"latest.json": "[1]", "2023.json": "[9]"})
    first = write_data_manifest(tmp_path)
    second = write_data_manifest(tmp_path)
    assert first == second
    # byte-identical file too (sort_keys + compact separators)
    assert (tmp_path / MANIFEST_NAME).read_text() == json.dumps(first, sort_keys=True, separators=(",", ":")) + "\n"


def test_missing_data_dir_writes_empty_manifest(tmp_path):
    manifest = write_data_manifest(tmp_path)
    assert manifest == {}
    assert json.loads((tmp_path / MANIFEST_NAME).read_text()) == {}
