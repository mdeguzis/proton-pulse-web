"""Tests for scripts/fetch-plugin-data.sh and its wiring in update-data.yml (#546).

The nightly pipeline's CF deploy shipped prod without form-schema.json and
scoring-info.json because nothing put them in /tmp/protondb-output. These pin
the fetch step ahead of the deploy and prove the script fails loud instead of
letting an HTML fallback or a missing file through.
"""
import json
import os
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "fetch-plugin-data.sh"
WORKFLOW = yaml.safe_load((ROOT / ".github" / "workflows" / "update-data.yml").read_text())


def _run(src: Path, out: Path):
    return subprocess.run(
        ["bash", str(SCRIPT), str(out)],
        env={**os.environ, "PLUGIN_DATA_BASE": src.as_uri()},
        capture_output=True, text=True,
    )


def _seed(src: Path, **files):
    src.mkdir()
    for name, body in files.items():
        (src / name).write_text(body)


def test_fetches_both_files(tmp_path):
    src = tmp_path / "src"
    _seed(src, **{"form-schema.json": json.dumps({"validOs": ["Android"]}),
                  "scoring-info.json": json.dumps({"weights": {}})})
    out = tmp_path / "out"
    r = _run(src, out)
    assert r.returncode == 0, r.stderr
    assert json.loads((out / "form-schema.json").read_text())["validOs"] == ["Android"]
    assert (out / "scoring-info.json").exists()


def test_html_fallback_body_fails(tmp_path):
    src = tmp_path / "src"
    _seed(src, **{"form-schema.json": "<!DOCTYPE html><html></html>",
                  "scoring-info.json": "{}"})
    out = tmp_path / "out"
    r = _run(src, out)
    assert r.returncode != 0
    assert "not valid JSON" in r.stderr
    assert not (out / "form-schema.json").exists()


def test_missing_file_fails(tmp_path):
    src = tmp_path / "src"
    _seed(src, **{"form-schema.json": "{}"})
    out = tmp_path / "out"
    r = _run(src, out)
    assert r.returncode != 0
    assert "fetch failed for scoring-info.json" in r.stderr
    assert not (out / "scoring-info.json").exists()


def test_fetch_step_runs_before_cloudflare_deploy():
    names = [s.get("name") for s in WORKFLOW["jobs"]["finalize"]["steps"]]
    fetch = names.index("Fetch plugin-sourced data files")
    deploy = names.index("Deploy to Cloudflare (R2 + Pages)")
    assert fetch < deploy


def test_fetch_step_targets_deploy_dir_and_cloudflare_gate():
    steps = {s.get("name"): s for s in WORKFLOW["jobs"]["finalize"]["steps"]}
    fetch = steps["Fetch plugin-sourced data files"]
    deploy = steps["Deploy to Cloudflare (R2 + Pages)"]
    assert "fetch-plugin-data.sh /tmp/protondb-output" in fetch["run"]
    assert "/tmp/protondb-output" in deploy["run"]
    assert fetch["if"] == deploy["if"]


# --- #564: proton-env-support.json is optional ------------------------------

def test_optional_file_is_fetched_when_present(tmp_path):
    src = tmp_path / "src"
    _seed(src, **{"form-schema.json": "{}", "scoring-info.json": "{}",
                  "proton-env-support.json": json.dumps({"tools": {}, "switches": {}})})
    out = tmp_path / "out"
    r = _run(src, out)
    assert r.returncode == 0, r.stderr
    assert json.loads((out / "proton-env-support.json").read_text()) == {"tools": {}, "switches": {}}


def test_missing_optional_file_warns_but_does_not_fail(tmp_path):
    src = tmp_path / "src"
    _seed(src, **{"form-schema.json": "{}", "scoring-info.json": "{}"})
    out = tmp_path / "out"
    r = _run(src, out)
    assert r.returncode == 0, r.stderr
    assert "WARNING: optional proton-env-support.json unavailable" in r.stderr
    assert not (out / "proton-env-support.json").exists()


def test_html_optional_file_is_dropped_not_published(tmp_path):
    src = tmp_path / "src"
    _seed(src, **{"form-schema.json": "{}", "scoring-info.json": "{}",
                  "proton-env-support.json": "<!DOCTYPE html>"})
    out = tmp_path / "out"
    r = _run(src, out)
    assert r.returncode == 0
    assert not (out / "proton-env-support.json").exists()

