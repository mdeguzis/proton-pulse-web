"""Tests for scripts/probe-cache-sync.sh and its wiring in update-data.yml (#258).

The finalize probe caches were seeded from a gh-pages snapshot that stopped
updating at the Cloudflare cutover, so every run re-probed everything and
discarded the results. These pin the round trip through the Actions cache and
prove a bad file never overwrites a good one in either direction.
"""
import json
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "probe-cache-sync.sh"
WORKFLOW = yaml.safe_load((ROOT / ".github" / "workflows" / "update-data.yml").read_text())

CACHE_FILES = [
    "game-images-cache.json",
    "game-images-skip.json",
    "nonsteam-images-cache.json",
    "release-years-cache.json",
    "app-id-validation-cache.json",
]


def _run(mode: str, cache_dir: Path, output_dir: Path):
    return subprocess.run(
        ["bash", str(SCRIPT), mode, str(cache_dir), str(output_dir)],
        capture_output=True, text=True,
    )


def _write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data))


def test_restore_overlays_previous_run_over_gh_pages_seed(tmp_path):
    cache, out = tmp_path / "cache", tmp_path / "out"
    _write(out / "nonsteam-images-cache.json", {"gog:1": {"probed_at": "2026-08-23"}})
    _write(cache / "probe-caches" / "nonsteam-images-cache.json", {"gog:1": {"probed_at": "2026-10-14"}})
    r = _run("restore", cache, out)
    assert r.returncode == 0, r.stderr
    restored = json.loads((out / "nonsteam-images-cache.json").read_text())
    assert restored["gog:1"]["probed_at"] == "2026-10-14"
    assert "restore nonsteam-images-cache.json" in r.stdout


def test_restore_keeps_seed_when_actions_cache_evicted(tmp_path):
    cache, out = tmp_path / "cache", tmp_path / "out"
    _write(out / "game-images-cache.json", {"10": {"status": "ok"}})
    r = _run("restore", cache, out)
    assert r.returncode == 0, r.stderr
    assert json.loads((out / "game-images-cache.json").read_text()) == {"10": {"status": "ok"}}
    assert "absent" in r.stdout


def test_restore_skips_corrupt_cache_and_keeps_seed(tmp_path):
    cache, out = tmp_path / "cache", tmp_path / "out"
    _write(out / "release-years-cache.json", {"10": 2004})
    _write(cache / "probe-caches" / "release-years-cache.json", "{truncated")
    r = _run("restore", cache, out)
    assert r.returncode == 0
    assert json.loads((out / "release-years-cache.json").read_text()) == {"10": 2004}
    assert "not valid JSON" in r.stderr


def test_save_copies_every_cache_file(tmp_path):
    cache, out = tmp_path / "cache", tmp_path / "out"
    for i, name in enumerate(CACHE_FILES):
        _write(out / name, {"n": i})
    r = _run("save", cache, out)
    assert r.returncode == 0, r.stderr
    for i, name in enumerate(CACHE_FILES):
        assert json.loads((cache / "probe-caches" / name).read_text()) == {"n": i}


def test_save_never_replaces_good_copy_with_corrupt_output(tmp_path):
    cache, out = tmp_path / "cache", tmp_path / "out"
    _write(cache / "probe-caches" / "nonsteam-images-cache.json", {"good": True})
    _write(out / "nonsteam-images-cache.json", "")
    r = _run("save", cache, out)
    assert r.returncode == 0
    assert json.loads((cache / "probe-caches" / "nonsteam-images-cache.json").read_text()) == {"good": True}


def test_unknown_mode_fails(tmp_path):
    r = _run("sync", tmp_path, tmp_path)
    assert r.returncode == 2


def _finalize_steps():
    return [s.get("name") for s in WORKFLOW["jobs"]["finalize"]["steps"]]


def test_restore_runs_after_actions_cache_restore_and_before_finalize():
    names = _finalize_steps()
    restore_cache = names.index("Restore pipeline cache")
    restore_probe = names.index("Restore probe caches from previous run")
    assert restore_cache < restore_probe
    # The gh-pages seed must already be in place so the overlay wins over it.
    assert names.index("Merge gh-pages data into probe input") < restore_probe


def test_save_runs_always_and_before_actions_cache_save():
    steps = {s.get("name"): s for s in WORKFLOW["jobs"]["finalize"]["steps"]}
    names = _finalize_steps()
    persist = steps["Persist probe caches for the next run"]
    assert persist["if"] == "always()"
    assert "probe-cache-sync.sh save .cache /tmp/protondb-output" in persist["run"]
    assert names.index("Persist probe caches for the next run") < names.index("Save pipeline cache")


def test_script_carries_every_cache_seeded_from_gh_pages():
    # Anything finalize seeds from gh-pages-data is frozen at the Cloudflare
    # cutover unless this script also carries it forward run to run.
    import re
    seed = next(s for s in WORKFLOW["jobs"]["finalize"]["steps"]
                if s.get("name") == "Merge gh-pages data into probe input")["run"]
    seeded = set(re.findall(r"gh-pages-data/([\w.-]+(?:-cache|-skip)\.json)", seed))
    assert seeded, "expected the seed step to restore at least one cache"
    assert seeded <= set(CACHE_FILES), f"not carried forward: {seeded - set(CACHE_FILES)}"
