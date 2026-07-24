"""Tests for the manifest diff + delta staging CLI (issue #392)."""
import json

import pytest

from scripts.pipeline.manifest_delta import (
    BOOTSTRAP_EXIT,
    SAMPLE_CHANGED_CAP,
    SAMPLE_UNCHANGED_COUNT,
    build_verify_sample,
    diff_manifests,
    main,
    stage_delta,
)


def test_diff_partitions_added_changed_deleted():
    old = {"a/1.json": "h1", "b/1.json": "h2", "c/1.json": "h3"}
    new = {"a/1.json": "h1", "b/1.json": "CHANGED", "d/1.json": "h4"}
    added, changed, deleted = diff_manifests(old, new)
    assert added == ["d/1.json"]
    assert changed == ["b/1.json"]
    assert deleted == ["c/1.json"]


def test_diff_empty_old_means_everything_added():
    new = {"a/1.json": "h1", "b/1.json": "h2"}
    added, changed, deleted = diff_manifests({}, new)
    assert added == ["a/1.json", "b/1.json"]
    assert changed == []
    assert deleted == []


def test_stage_delta_preserves_relative_paths(tmp_path):
    data = tmp_path / "data"
    (data / "730").mkdir(parents=True)
    (data / "730" / "latest.json").write_text("[1]")
    (data / "gog_123").mkdir()
    (data / "gog_123" / "2024.json").write_text("[2]")
    stage = tmp_path / "stage"
    n = stage_delta(data, stage, ["730/latest.json", "gog_123/2024.json"])
    assert n == 2
    assert (stage / "730" / "latest.json").read_text() == "[1]"
    assert (stage / "gog_123" / "2024.json").read_text() == "[2]"


def test_stage_delta_missing_source_raises(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    with pytest.raises(OSError):
        stage_delta(data, tmp_path / "stage", ["ghost/latest.json"])


def test_verify_sample_caps_and_includes_uploads():
    added = [f"a/{i}.json" for i in range(80)]
    changed = [f"c/{i}.json" for i in range(80)]
    unchanged = [f"u/{i}.json" for i in range(500)]
    sample = build_verify_sample(added, changed, unchanged)
    uploads = [k for k in sample if not k.startswith("u/")]
    extras = [k for k in sample if k.startswith("u/")]
    assert len(uploads) == SAMPLE_CHANGED_CAP
    assert len(extras) == SAMPLE_UNCHANGED_COUNT
    # deterministic: same inputs -> same sample
    assert sample == build_verify_sample(added, changed, unchanged)


def _write(path, obj):
    path.write_text(json.dumps(obj))
    return str(path)


def _cli(tmp_path, old, new_manifest, data_files):
    data = tmp_path / "data"
    for key, content in data_files.items():
        p = data / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    args = [
        "--old-manifest", str(tmp_path / "old.json"),
        "--new-manifest", _write(tmp_path / "new.json", new_manifest),
        "--data-dir", str(data),
        "--stage-dir", str(tmp_path / "stage"),
        "--sample-out", str(tmp_path / "sample.txt"),
    ]
    if old is not None:
        _write(tmp_path / "old.json", old)
    return main(args)


def test_cli_bootstrap_when_old_manifest_missing(tmp_path):
    rc = _cli(tmp_path, None, {"730/latest.json": "h1"}, {"730/latest.json": "[1]"})
    assert rc == BOOTSTRAP_EXIT


def test_cli_bootstrap_when_old_manifest_corrupt(tmp_path):
    (tmp_path / "old.json").write_text("<html>SPA fallback, not JSON</html>")
    rc = _cli(tmp_path, None, {"730/latest.json": "h1"}, {"730/latest.json": "[1]"})
    assert rc == BOOTSTRAP_EXIT


def test_cli_stages_only_the_delta_and_prints_summary(tmp_path, capsys):
    old = {"730/latest.json": "same", "440/latest.json": "old-hash"}
    new = {"730/latest.json": "same", "440/latest.json": "new-hash", "570/latest.json": "brand-new"}
    files = {k: "x" for k in new}
    rc = _cli(tmp_path, old, new, files)
    assert rc == 0
    staged = sorted(p.relative_to(tmp_path / "stage").as_posix() for p in (tmp_path / "stage").rglob("*.json"))
    assert staged == ["440/latest.json", "570/latest.json"]  # unchanged 730 NOT staged
    out = capsys.readouterr().out
    assert "total=3 added=1 changed=1 deleted=0 skipped_identical=1" in out


def test_cli_sample_lines_are_key_tab_hash(tmp_path):
    old = {"730/latest.json": "same"}
    new = {"730/latest.json": "same", "440/latest.json": "abc123"}
    rc = _cli(tmp_path, old, new, {k: "x" for k in new})
    assert rc == 0
    lines = (tmp_path / "sample.txt").read_text().splitlines()
    assert "440/latest.json\tabc123" in lines
    for line in lines:
        key, sha = line.split("\t")
        assert key in new
        assert sha == new[key]


def test_cli_missing_new_manifest_is_hard_error(tmp_path):
    rc = main([
        "--old-manifest", str(tmp_path / "old.json"),
        "--new-manifest", str(tmp_path / "nope.json"),
        "--data-dir", str(tmp_path),
        "--stage-dir", str(tmp_path / "stage"),
        "--sample-out", str(tmp_path / "sample.txt"),
    ])
    assert rc == 2
