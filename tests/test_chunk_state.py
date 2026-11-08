"""Probe chunk state in R2 instead of gh-pages/.pipeline-state/ (#171, #396).

Covers public-state-get.sh, probe-plan-emit.sh, probe-idempotent-check.sh,
persist-chunk-state.sh, restore-chunk-state.sh and the workflow wiring.

Writes go through a fake aws CLI (a directory tree); reads go through a local
HTTP server serving the same tree's `_state/`, the way the data host does.
"""
import gzip
import json
import os
from pathlib import Path

import pytest
import yaml

from tests.test_r2_state import ROOT, SCRIPTS, _run, r2, served  # noqa: F401

WORKFLOW = ROOT / ".github" / "workflows" / "update-data.yml"
MANIFEST = "pipeline-state/manifest.json"


@pytest.fixture
def state(r2, served):
    """Fake bucket whose _state/ the HTTP server serves, plus an env for both."""
    root, env = r2
    docroot, base = served
    bucket_state = root / "proton-pulse-data" / "_state"
    docroot.rmdir()
    docroot.symlink_to(bucket_state, target_is_directory=True)
    return bucket_state, {**env, "STATE_BASE": base}


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, (dict, list)):
        data = json.dumps(data)
    if isinstance(data, str):
        data = data.encode()
    path.write_bytes(data)
    return path


def _cache(cwd, apps):
    return _write(cwd / ".cache" / "protondb-summary-probe-cache.json",
                  {"fetched_at": 1, "apps": {str(a): {} for a in apps}})


def _outputs(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines())


# --- public-state-get.sh -----------------------------------------------------

def test_get_fetches_json_and_gz(state, tmp_path):
    st, env = state
    _write(st / "a.json", {"x": 1})
    _write(st / "b.json.gz", gzip.compress(b"{}"))
    for name in ("a.json", "b.json.gz"):
        r = _run(SCRIPTS / "public-state-get.sh", name, tmp_path / "out" / name, env=env)
        assert r.returncode == 0, r.stderr
    assert json.loads((tmp_path / "out" / "a.json").read_text()) == {"x": 1}


def test_get_404_exits_3(state, tmp_path):
    _, env = state
    r = _run(SCRIPTS / "public-state-get.sh", "nope.json", tmp_path / "o", env=env)
    assert r.returncode == 3
    assert not (tmp_path / "o").exists()


@pytest.mark.parametrize("name,body", [("bad.json", "{nope"), ("bad.json.gz", "not gzip")])
def test_get_corrupt_exits_1_and_leaves_dest(state, tmp_path, name, body):
    st, env = state
    _write(st / name, body)
    r = _run(SCRIPTS / "public-state-get.sh", name, tmp_path / "o", env=env)
    assert r.returncode == 1
    assert not (tmp_path / "o").exists()


def test_get_unreachable_exits_1(tmp_path):
    env = {**os.environ, "STATE_BASE": "http://127.0.0.1:9"}
    r = _run(SCRIPTS / "public-state-get.sh", "a.json", tmp_path / "o", env=env)
    assert r.returncode == 1
    assert "HTTP 000" in r.stderr


# --- probe-plan-emit.sh ------------------------------------------------------

def _plan(tmp_path, chunks):
    return _write(tmp_path / "plan.json", {"chunks": chunks, "uncached_count": 7})


def _emit(state, tmp_path, chunks, resume=False):
    _, env = state
    out = tmp_path / "gh_output"
    out.write_text("")
    r = _run(SCRIPTS / "probe-plan-emit.sh", _plan(tmp_path, chunks), env={
        **env, "GITHUB_OUTPUT": str(out), "RUN_ID": "900",
        "RESUME_MODE": "true" if resume else "false"})
    return r, out


def test_normal_run_starts_a_fresh_manifest(state, tmp_path):
    st, _ = state
    # Entries from an earlier night must not count for this plan.
    _write(st / MANIFEST, {"plan_run_id": "1", "chunks": {"01": {"status": "completed"}}})
    r, out = _emit(state, tmp_path, ["01", "02"])
    assert r.returncode == 0, r.stdout + r.stderr
    m = json.loads((st / MANIFEST).read_text())
    assert m["plan_run_id"] == "900"
    assert m["planned"] == ["01", "02"]
    assert m["chunks"] == {}
    o = _outputs(out)
    assert o["chunk_count"] == "2"
    assert json.loads(o["chunk_matrix"]) == ["01", "02"]


def test_empty_plan_keeps_the_last_manifest(state, tmp_path):
    st, _ = state
    old = {"plan_run_id": "1", "chunks": {"01": {"status": "completed"}}}
    _write(st / MANIFEST, old)
    r, out = _emit(state, tmp_path, [])
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads((st / MANIFEST).read_text()) == old
    assert _outputs(out)["chunk_count"] == "0"


def test_normal_run_fails_when_the_manifest_cannot_be_written(state, tmp_path):
    _, env = state
    out = tmp_path / "gh_output"
    out.write_text("")
    r = _run(SCRIPTS / "probe-plan-emit.sh", _plan(tmp_path, ["01"]), env={
        **env, "GITHUB_OUTPUT": str(out), "FAKE_AWS_FAIL": "1"})
    assert r.returncode != 0
    assert out.read_text() == ""


def test_resume_runs_only_the_missing_chunks(state, tmp_path):
    st, _ = state
    _write(st / MANIFEST, {"plan_run_id": "5", "chunks": {
        "01": {"status": "completed"}, "02": {"status": "completed"}}})
    r, out = _emit(state, tmp_path, ["01", "02", "03"], resume=True)
    assert r.returncode == 0, r.stdout + r.stderr
    o = _outputs(out)
    assert json.loads(o["chunk_matrix"]) == ["03"]
    assert json.loads(o["expected_matrix"]) == ["01", "02", "03"]
    # Resume keeps the interrupted run's manifest.
    assert json.loads((st / MANIFEST).read_text())["plan_run_id"] == "5"


@pytest.mark.parametrize("manifest", [None, "{broken"])
def test_resume_without_a_readable_manifest_runs_everything(state, tmp_path, manifest):
    st, _ = state
    if manifest:
        _write(st / MANIFEST, manifest)
    r, out = _emit(state, tmp_path, ["01", "02"], resume=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads(_outputs(out)["chunk_matrix"]) == ["01", "02"]
    assert ("WARNING" in r.stdout) == bool(manifest)


# --- probe-idempotent-check.sh -----------------------------------------------

def _idem(state, tmp_path, chunk="01"):
    _, env = state
    out = tmp_path / "gh_output"
    out.write_text("")
    r = _run(SCRIPTS / "probe-idempotent-check.sh", chunk,
             env={**env, "GITHUB_OUTPUT": str(out)}, cwd=tmp_path)
    return r, _outputs(out)["skip"]


def _sha(path):
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def test_idem_skips_when_the_cache_matches(state, tmp_path):
    st, _ = state
    cache = _cache(tmp_path, [1, 2])
    _write(st / MANIFEST, {"chunks": {"01": {"status": "completed", "input_sha": _sha(cache)}}})
    r, skip = _idem(state, tmp_path)
    assert skip == "true", r.stdout


def test_idem_runs_on_drift_or_missing_state(state, tmp_path):
    st, _ = state
    assert _idem(state, tmp_path)[1] == "false"           # no cache
    _cache(tmp_path, [1])
    assert _idem(state, tmp_path)[1] == "false"           # no manifest
    _write(st / MANIFEST, "{broken")
    assert _idem(state, tmp_path)[1] == "false"           # unreadable
    _write(st / MANIFEST, {"chunks": {"01": {"status": "completed", "input_sha": "abc"}}})
    assert _idem(state, tmp_path)[1] == "false"           # drift


# --- persist-chunk-state.sh --------------------------------------------------

def _persist(state, tmp_path, chunk="01", **extra):
    _, env = state
    return _run(SCRIPTS / "persist-chunk-state.sh", chunk, "900", "2",
                env={**env, **extra}, cwd=tmp_path)


def test_persist_uploads_snapshot_and_adds_an_entry(state, tmp_path):
    st, _ = state
    _write(st / MANIFEST, {"plan_run_id": "900", "planned": ["01", "02"], "chunks": {
        "01": {"status": "completed"}}})
    cache = _cache(tmp_path, [10, 20, 30])
    r = _persist(state, tmp_path, "02")
    assert r.returncode == 0, r.stdout + r.stderr
    snap = st / "pipeline-state" / "chunks" / "chunk-02.json.gz"
    assert gzip.decompress(snap.read_bytes()) == cache.read_bytes()
    m = json.loads((st / MANIFEST).read_text())
    assert m["plan_run_id"] == "900"
    assert set(m["chunks"]) == {"01", "02"}
    e = m["chunks"]["02"]
    assert e["status"] == "completed"
    assert e["app_count"] == 3          # apps, not the two top-level keys
    assert e["input_sha"] == _sha(cache)
    assert (e["run_id"], e["run_attempt"]) == ("900", 2)


def test_persist_starts_a_manifest_when_there_is_none(state, tmp_path):
    st, _ = state
    _cache(tmp_path, [1])
    r = _persist(state, tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert list(json.loads((st / MANIFEST).read_text())["chunks"]) == ["01"]


def test_persist_read_error_does_not_overwrite_the_manifest(state, tmp_path):
    st, _ = state
    _write(st / MANIFEST, "{broken")
    _cache(tmp_path, [1])
    r = _persist(state, tmp_path)
    assert r.returncode != 0
    assert (st / MANIFEST).read_text() == "{broken"


def test_persist_upload_failure_fails(state, tmp_path):
    _cache(tmp_path, [1])
    assert _persist(state, tmp_path, FAKE_AWS_FAIL="1").returncode != 0


def test_persist_without_a_cache_is_a_noop(state, tmp_path):
    st, _ = state
    r = _persist(state, tmp_path)
    assert r.returncode == 0
    assert not (st / MANIFEST).exists()


def test_persist_rejects_odd_chunk_ids(state, tmp_path):
    _cache(tmp_path, [1])
    assert _persist(state, tmp_path, "../x").returncode != 0


# --- restore-chunk-state.sh --------------------------------------------------

def _restore(state, tmp_path, expected):
    _, env = state
    return _run(SCRIPTS / "restore-chunk-state.sh", expected, env=env, cwd=tmp_path)


def _seed(st, completed, planned=None):
    _write(st / MANIFEST, {"plan_run_id": "900", "planned": planned or completed,
                           "chunks": {c: {"status": "completed"} for c in completed}})
    for c in completed:
        _write(st / "pipeline-state" / "chunks" / f"chunk-{c}.json.gz",
               gzip.compress(json.dumps({"fetched_at": 1, "apps": {c: {}}}).encode()))


def _restored(tmp_path):
    return json.loads((tmp_path / ".cache" / "protondb-summary-probe-cache.json").read_text())


def test_restore_loads_the_highest_chunk(state, tmp_path):
    st, _ = state
    _seed(st, ["01", "02", "10"])
    r = _restore(state, tmp_path, '["01","02","10"]')
    assert r.returncode == 0, r.stdout + r.stderr
    assert list(_restored(tmp_path)["apps"]) == ["10"]   # numeric, not string order


def test_restore_names_the_missing_chunk(state, tmp_path):
    st, _ = state
    _seed(st, ["01"], planned=["01", "02"])
    r = _restore(state, tmp_path, '["01","02"]')
    assert r.returncode == 1
    assert "chunk 02 missing" in r.stderr


def test_restore_finalize_only_uses_the_manifest_set(state, tmp_path):
    st, _ = state
    _seed(st, ["01", "03"])
    r = _restore(state, tmp_path, "")
    assert r.returncode == 0, r.stdout + r.stderr
    assert list(_restored(tmp_path)["apps"]) == ["03"]


def test_restore_without_a_manifest(state, tmp_path):
    # finalize_only keeps the Actions cache copy; a run that probed chunks but
    # left no manifest is a persist failure and stops.
    assert _restore(state, tmp_path, "").returncode == 0
    r = _restore(state, tmp_path, '["01"]')
    assert r.returncode == 1
    assert "no manifest" in r.stdout


def test_restore_unreadable_manifest_or_snapshot_fails(state, tmp_path):
    st, _ = state
    _write(st / MANIFEST, "{broken")
    assert _restore(state, tmp_path, "").returncode == 1
    _seed(st, ["01"])
    (st / "pipeline-state" / "chunks" / "chunk-01.json.gz").unlink()
    r = _restore(state, tmp_path, '["01"]')
    assert r.returncode == 1
    assert "snapshot could not be read" in r.stdout


def test_round_trip_plan_persist_restore(state, tmp_path):
    st, _ = state
    _emit(state, tmp_path, ["01", "02"])
    _cache(tmp_path, [1])
    assert _persist(state, tmp_path, "01").returncode == 0
    _cache(tmp_path, [1, 2])
    assert _persist(state, tmp_path, "02").returncode == 0
    (tmp_path / ".cache" / "protondb-summary-probe-cache.json").unlink()
    r = _restore(state, tmp_path, '["01","02"]')
    assert r.returncode == 0, r.stdout + r.stderr
    assert set(_restored(tmp_path)["apps"]) == {"1", "2"}


# --- workflow wiring ---------------------------------------------------------

def _steps(job):
    wf = yaml.safe_load(WORKFLOW.read_text())
    return wf["jobs"][job], {s.get("name", ""): s for s in wf["jobs"][job]["steps"]}


def test_no_chunk_state_script_touches_gh_pages():
    for name in ("probe-plan-emit.sh", "probe-idempotent-check.sh",
                 "persist-chunk-state.sh", "restore-chunk-state.sh"):
        body = (SCRIPTS / name).read_text()
        assert "git clone" not in body and "GITHUB_TOKEN" not in body, name


def test_workflow_wires_chunk_state_to_r2():
    staging_base = "staging-data.proton-pulse.com/_state"
    _, build = _steps("build")
    plan = build["Build probe chunk plan"]["env"]
    assert "GITHUB_TOKEN" not in plan
    assert "proton-pulse-data-staging" in plan["R2_BUCKET"]
    assert staging_base in plan["STATE_BASE"]

    job, probe = _steps("probe-chunks")
    assert job["permissions"]["contents"] == "read"
    persist = probe["Persist chunk state to R2 (#171)"]
    assert "always()" not in persist["if"]
    assert "R2_SECRET_ACCESS_KEY" in persist["env"]
    assert "R2_SECRET_ACCESS_KEY" not in probe["Idempotent check (#171 Phase 4)"]["env"]
    assert staging_base in probe["Idempotent check (#171 Phase 4)"]["env"]["STATE_BASE"]

    _, fin = _steps("finalize")
    restore = fin["Restore chunk state from R2 (#171)"]["env"]
    # Keyless read; only staging pipeline runs read staging's own state, so
    # staging finalize-only runs still restore prod's chunks.
    assert set(restore) == {"STATE_BASE"}
    assert "staging_with_pipeline" in restore["STATE_BASE"]
    assert "staging_with_finalize" not in restore["STATE_BASE"]


# --- backup-to-release.sh: the off-Cloudflare probe cache copy ---------------

FAKE_GH = """#!{bash}
echo "$*" >> "$FAKE_GH_LOG"
if [ "$1 $2" = "release upload" ]; then
  for a in "$@"; do case "$a" in *.gz) cp "$a" "$FAKE_GH_DIR/" ;; esac; done
fi
exit 0
"""


def _backup(tmp_path, with_cache):
    import shutil
    bindir = tmp_path / "ghbin"
    bindir.mkdir()
    gh = bindir / "gh"
    gh.write_text(FAKE_GH.format(bash=shutil.which("bash")))
    gh.chmod(0o755)
    up = tmp_path / "uploaded"
    up.mkdir()
    _write(tmp_path / "out" / "data" / "620" / "index.json", {})
    if with_cache:
        _cache(tmp_path, [620])
    env = {**os.environ, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
           "FAKE_GH_LOG": str(tmp_path / "gh.log"), "FAKE_GH_DIR": str(up)}
    r = _run(SCRIPTS / "backup-to-release.sh", tmp_path / "out", env=env, cwd=tmp_path)
    return r, up


def test_backup_uploads_the_probe_cache_next_to_data(tmp_path):
    r, up = _backup(tmp_path, with_cache=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert {p.name for p in up.iterdir()} == {
        "proton-pulse-data-snapshot.tar.gz", "protondb-probe-cache.json.gz"}
    probe = json.loads(gzip.decompress((up / "protondb-probe-cache.json.gz").read_bytes()))
    assert list(probe["apps"]) == ["620"]
    assert "Probe cache: " in (tmp_path / "gh.log").read_text()


def test_backup_without_a_probe_cache_still_backs_up_data(tmp_path):
    r, up = _backup(tmp_path, with_cache=False)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "WARNING" in r.stdout
    assert {p.name for p in up.iterdir()} == {"proton-pulse-data-snapshot.tar.gz"}
