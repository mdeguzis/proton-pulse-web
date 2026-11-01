"""R2 state helpers that replace gh-pages as the workflow state store (#396).

Covers scripts/r2-state.sh, scripts/cert-monitor-state.sh,
scripts/preserve-cert-monitor.sh, the per-env data host guard in
publish-cloudflare.sh (#590), and the workflows that call them.

The aws CLI is replaced by a fake on PATH that reads and writes a directory
tree, so nothing touches R2.
"""
import functools
import http.server
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
BASH = shutil.which("bash")

FAKE_AWS = r"""#!{bash}
# Fake aws CLI: buckets are directories under $FAKE_R2.
echo "$*" >> "$FAKE_R2/calls.log"
if [ -n "${{FAKE_AWS_FAIL:-}}" ]; then
  echo "An error occurred (AccessDenied) when calling the operation: Access Denied" >&2
  exit 255
fi
if [ "$1 $2" = "s3api get-object" ]; then
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --bucket) bucket="$2"; shift 2 ;;
      --key) key="$2"; shift 2 ;;
      --endpoint-url) shift 2 ;;
      *) out="$1"; shift ;;
    esac
  done
  if [ -f "$FAKE_R2/$bucket/$key" ]; then
    cp "$FAKE_R2/$bucket/$key" "$out"
    echo '{{}}'
    exit 0
  fi
  echo "An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist." >&2
  exit 254
fi
if [ "$1 $2" = "s3 cp" ]; then
  src="$3"; dst="${{4#s3://}}"
  mkdir -p "$FAKE_R2/$(dirname "$dst")"
  cp "$src" "$FAKE_R2/$dst"
  exit 0
fi
echo "fake aws: unhandled $*" >&2
exit 2
"""


@pytest.fixture
def r2(tmp_path):
    """A fake bucket root plus an env that puts the fake aws first on PATH."""
    root = tmp_path / "r2"
    (root / "proton-pulse-data" / "_state").mkdir(parents=True)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    aws = bindir / "aws"
    aws.write_text(FAKE_AWS.format(bash=BASH))
    aws.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
        "FAKE_R2": str(root),
        "R2_BUCKET": "proton-pulse-data",
        "CLOUDFLARE_ACCOUNT_ID": "acct",
        "R2_ACCESS_KEY_ID": "id",
        "R2_SECRET_ACCESS_KEY": "secret",
    }
    env.pop("FAKE_AWS_FAIL", None)
    return root, env


def _state(root, name):
    return root / "proton-pulse-data" / "_state" / name


def _run(script, *args, env, cwd=None):
    return subprocess.run([BASH, str(script), *map(str, args)], env=env, cwd=cwd,
                          capture_output=True, text=True)


# --- r2-state.sh -------------------------------------------------------------

def test_get_fetches_existing_object(r2, tmp_path):
    root, env = r2
    _state(root, "x.json").write_text('{"a": 1}')
    r = _run(SCRIPTS / "r2-state.sh", "get", "x.json", tmp_path / "out" / "x.json", env=env)
    assert r.returncode == 0, r.stderr
    assert json.loads((tmp_path / "out" / "x.json").read_text()) == {"a": 1}
    assert "_state/x.json" in (root / "calls.log").read_text()


def test_get_missing_object_exits_3(r2, tmp_path):
    _, env = r2
    r = _run(SCRIPTS / "r2-state.sh", "get", "nope.json", tmp_path / "nope.json", env=env)
    assert r.returncode == 3
    assert "not in the bucket" in r.stderr
    assert not (tmp_path / "nope.json").exists()


def test_get_other_failure_exits_1_not_3(r2, tmp_path):
    # A failed read must never look like "not there", or a caller would start
    # fresh and overwrite state that cannot be regenerated.
    root, env = r2
    _state(root, "x.json").write_text("{}")
    r = _run(SCRIPTS / "r2-state.sh", "get", "x.json", tmp_path / "x.json",
             env={**env, "FAKE_AWS_FAIL": "1"})
    assert r.returncode == 1
    assert "AccessDenied" in r.stderr


def test_get_invalid_json_fails_and_leaves_dest_alone(r2, tmp_path):
    root, env = r2
    _state(root, "x.json").write_text("<!doctype html>")
    dest = tmp_path / "x.json"
    dest.write_text('{"keep": true}')
    r = _run(SCRIPTS / "r2-state.sh", "get", "x.json", dest, env=env)
    assert r.returncode == 1
    assert "not valid JSON" in r.stderr
    assert json.loads(dest.read_text()) == {"keep": True}


def test_put_uploads_with_no_store(r2, tmp_path):
    root, env = r2
    src = tmp_path / "s.json"
    src.write_text("[1, 2]")
    r = _run(SCRIPTS / "r2-state.sh", "put", src, "s.json", env=env)
    assert r.returncode == 0, r.stderr
    assert json.loads(_state(root, "s.json").read_text()) == [1, 2]
    call = (root / "calls.log").read_text()
    assert "s3://proton-pulse-data/_state/s.json" in call
    assert "--cache-control no-store" in call
    assert "--content-type application/json" in call


@pytest.mark.parametrize("body", [None, "", "not json"])
def test_put_rejects_missing_empty_or_bad_json(r2, tmp_path, body):
    root, env = r2
    src = tmp_path / "s.json"
    if body is not None:
        src.write_text(body)
    r = _run(SCRIPTS / "r2-state.sh", "put", src, "s.json", env=env)
    assert r.returncode == 1
    assert not _state(root, "s.json").exists()


@pytest.mark.parametrize("name", ["../escape.json", "/abs.json", "a b.json", "x/../../y"])
def test_rejects_unsafe_names(r2, tmp_path, name):
    _, env = r2
    r = _run(SCRIPTS / "r2-state.sh", "get", name, tmp_path / "o", env=env)
    assert r.returncode == 1
    assert "refusing state name" in r.stderr


def test_bucket_is_required(r2, tmp_path):
    # No default: a staging job that forgets R2_BUCKET must not write prod.
    _, env = r2
    env = {k: v for k, v in env.items() if k != "R2_BUCKET"}
    r = _run(SCRIPTS / "r2-state.sh", "get", "x.json", tmp_path / "x.json", env=env)
    assert r.returncode != 0
    assert "R2_BUCKET required" in r.stderr


def test_unknown_command_fails(r2):
    _, env = r2
    r = _run(SCRIPTS / "r2-state.sh", "list", env=env)
    assert r.returncode == 1


# --- cert-monitor-state.sh ---------------------------------------------------

@pytest.fixture
def repo(tmp_path):
    """A repo copy whose origin has a gh-pages branch, for the one-time seed."""
    def git(*a, cwd):
        subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)

    remote = tmp_path / "remote.git"
    git("init", "-q", "--bare", str(remote), cwd=tmp_path)
    pages = tmp_path / "pages"
    pages.mkdir()
    git("init", "-q", "-b", "gh-pages", cwd=pages)
    (pages / "cert-history.json").write_text(json.dumps([{"t": 1}, {"t": 2}]))
    git("add", ".", cwd=pages)
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x", cwd=pages)
    git("push", "-q", str(remote), "gh-pages", cwd=pages)

    work = tmp_path / "repo"
    (work / "scripts").mkdir(parents=True)
    for s in ("r2-state.sh", "cert-monitor-state.sh"):
        shutil.copy(SCRIPTS / s, work / "scripts" / s)
    git("init", "-q", cwd=work)
    git("remote", "add", "origin", str(remote), cwd=work)
    return work, pages


def test_pull_uses_r2_history(r2, repo, tmp_path):
    root, env = r2
    work, _ = repo
    _state(root, "cert-history.json").write_text(json.dumps([{"t": 9}]))
    r = _run(work / "scripts" / "cert-monitor-state.sh", "pull", tmp_path / "st", env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads((tmp_path / "st" / "cert-history.json").read_text()) == [{"t": 9}]
    assert "1 points" in r.stdout


def test_pull_seeds_once_from_gh_pages_when_r2_is_empty(r2, repo, tmp_path):
    _, env = r2
    work, _ = repo
    r = _run(work / "scripts" / "cert-monitor-state.sh", "pull", tmp_path / "st", env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "seeding once from origin/gh-pages" in r.stdout
    assert json.loads((tmp_path / "st" / "cert-history.json").read_text()) == [{"t": 1}, {"t": 2}]


def test_pull_starts_fresh_when_neither_has_history(r2, repo, tmp_path):
    _, env = r2
    work, pages = repo
    subprocess.run(["git", "remote", "set-url", "origin", str(tmp_path / "missing.git")],
                   cwd=work, check=True)
    r = _run(work / "scripts" / "cert-monitor-state.sh", "pull", tmp_path / "st", env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "starting a new history" in r.stdout
    assert not (tmp_path / "st" / "cert-history.json").exists()


def test_pull_read_error_stops_the_run(r2, repo, tmp_path):
    # The whole point: an R2 error must not fall through to a fresh history
    # that push would then save over the real one.
    _, env = r2
    work, _ = repo
    r = _run(work / "scripts" / "cert-monitor-state.sh", "pull", tmp_path / "st",
             env={**env, "FAKE_AWS_FAIL": "1"})
    assert r.returncode == 1
    assert "not running" in r.stdout
    assert not (tmp_path / "st" / "cert-history.json").exists()


def test_push_uploads_both_files(r2, repo, tmp_path):
    root, env = r2
    work, _ = repo
    st = tmp_path / "st"
    st.mkdir()
    (st / "cert-status.json").write_text('{"edge": {}}')
    (st / "cert-history.json").write_text("[]")
    r = _run(work / "scripts" / "cert-monitor-state.sh", "push", st, env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert _state(root, "cert-status.json").exists()
    assert _state(root, "cert-history.json").exists()


def test_push_fails_when_status_missing(r2, repo, tmp_path):
    _, env = r2
    work, _ = repo
    st = tmp_path / "st"
    st.mkdir()
    r = _run(work / "scripts" / "cert-monitor-state.sh", "push", st, env=env)
    assert r.returncode != 0


# --- preserve-cert-monitor.sh ------------------------------------------------

@pytest.fixture
def served(tmp_path):
    """Serve a directory over HTTP the way the data host serves _state/."""
    docroot = tmp_path / "www"
    docroot.mkdir()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(docroot))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield docroot, f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _preserve(base, deploy):
    deploy.mkdir(exist_ok=True)
    return _run(SCRIPTS / "preserve-cert-monitor.sh", deploy,
                env={**os.environ, "CERT_STATE_BASE": base})


def test_preserve_copies_both_files(served, tmp_path):
    docroot, base = served
    (docroot / "cert-status.json").write_text('{"edge": {}}')
    (docroot / "cert-history.json").write_text("[]")
    r = _preserve(base, tmp_path / "d")
    assert r.returncode == 0, r.stderr
    assert "2 file(s) preserved" in r.stdout
    assert (tmp_path / "d" / "cert-history.json").read_text() == "[]"


def test_preserve_skips_404_and_bad_json_without_failing(served, tmp_path):
    docroot, base = served
    (docroot / "cert-status.json").write_text("<!doctype html>")
    r = _preserve(base, tmp_path / "d")
    assert r.returncode == 0
    assert "cert-status.json is not valid JSON" in r.stdout
    assert "cert-history.json not in R2 state yet (404)" in r.stdout
    assert list((tmp_path / "d").iterdir()) == []


def test_preserve_unreachable_host_is_logged(tmp_path):
    r = _preserve("http://127.0.0.1:9", tmp_path / "d")
    assert r.returncode == 0
    assert "could not read" in r.stdout
    assert "0 file(s) preserved" in r.stdout


# --- publish-cloudflare.sh per-env data host guard (#590) --------------------

@pytest.mark.parametrize("project,base", [
    ("proton-pulse-web-staging", "https://data.proton-pulse.com"),
    ("proton-pulse-web-staging", None),
    ("proton-pulse-web", "https://staging-data.proton-pulse.com"),
])
def test_publish_refuses_mismatched_data_host(tmp_path, project, base):
    env = {**os.environ, "PAGES_PROJECT": project}
    env.pop("DATA_BASE", None)
    if base:
        env["DATA_BASE"] = base
    r = _run(SCRIPTS / "publish-cloudflare.sh", tmp_path, tmp_path, env=env)
    assert r.returncode == 1
    assert "#590" in r.stdout


# --- workflows ----------------------------------------------------------------

def _wf(name):
    raw = (ROOT / ".github" / "workflows" / name).read_text()
    return raw, yaml.safe_load(raw)


def test_cert_monitor_writes_r2_state_not_gh_pages():
    raw, doc = _wf("cert-monitor.yml")
    assert doc["permissions"] == {"contents": "read"}
    steps = doc["jobs"]["check"]["steps"]
    assert not any((s.get("with") or {}).get("ref") == "gh-pages" for s in steps)
    assert "git push" not in raw
    run = next(s for s in steps if "cert-monitor.sh" in (s.get("run") or ""))
    assert run["env"]["R2_BUCKET"] == "proton-pulse-data"
    lines = run["run"].splitlines()
    pull = next(i for i, l in enumerate(lines) if "cert-monitor-state.sh pull" in l)
    mon = next(i for i, l in enumerate(lines) if "scripts/cert-monitor.sh" in l)
    push = next(i for i, l in enumerate(lines) if "cert-monitor-state.sh push" in l)
    assert pull < mon < push


def test_edge_fn_health_no_longer_writes_gh_pages():
    raw, doc = _wf("edge-fn-health.yml")
    assert doc["permissions"] == {"contents": "read"}
    assert "ref: gh-pages" not in raw
    assert "git push" not in raw


# --- publish-cloudflare.sh coverage rows + Pages size preflight (#592) -------

def _publish_env(r2, tmp_path):
    """Run publish-cloudflare.sh end to end with fake aws + npx, against a
    project name with no live domain so the version guard never curls."""
    root, env = r2
    npx = tmp_path / "bin" / "npx"
    npx.write_text(f'#!{BASH}\necho "$*" >> "$FAKE_R2/npx.log"\n')
    npx.chmod(0o755)
    env = {
        **env,
        "PAGES_PROJECT": "proton-pulse-web-test",
        "DATA_BASE": "https://data.example.invalid",
        "CERT_STATE_BASE": "http://127.0.0.1:9/_state",
    }
    out = tmp_path / "out"
    out.mkdir()
    return root, env, out


def test_publish_uploads_coverage_rows_before_pages(r2, tmp_path):
    root, env, out = _publish_env(r2, tmp_path)
    (out / "coverage.html").write_text("<html></html>")
    (out / "coverage-rows.json").write_text('{"rows": [["730"]]}\n')
    r = _run(SCRIPTS / "publish-cloudflare.sh", out, ROOT, env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    uploaded = root / "proton-pulse-data" / "reports" / "coverage-rows.json"
    assert uploaded.read_text() == '{"rows": [["730"]]}\n'
    calls = (root / "calls.log").read_text()
    assert "--content-type application/json" in calls
    assert "--cache-control public, max-age=300" in calls
    assert "coverage rows uploaded: r2://proton-pulse-data/reports/coverage-rows.json" in r.stdout
    assert "pages deploy" in (root / "npx.log").read_text()


def test_publish_shell_only_skips_coverage_rows(r2, tmp_path):
    root, env, out = _publish_env(r2, tmp_path)
    (out / "coverage.html").write_text("<html></html>")
    r = _run(SCRIPTS / "publish-cloudflare.sh", out, ROOT, env={**env, "SKIP_R2_SYNC": "1"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "coverage rows not uploaded" in r.stdout
    assert not (root / "calls.log").exists()


def test_publish_refuses_coverage_page_without_rows(r2, tmp_path):
    root, env, out = _publish_env(r2, tmp_path)
    (out / "coverage.html").write_text("<html></html>")
    (out / "data" / "730").mkdir(parents=True)
    r = _run(SCRIPTS / "publish-cloudflare.sh", out, ROOT, env=env)
    assert r.returncode == 1
    assert "coverage-rows.json is not" in r.stdout
    assert "R2 and Pages are unchanged" in r.stdout
    assert not (root / "calls.log").exists()
    assert not (root / "npx.log").exists()


def test_publish_refuses_oversize_pages_file_before_r2(r2, tmp_path):
    """Tonight's failure mode: R2 synced, then wrangler rejected a 26 MiB
    coverage.html. The preflight must stop before any R2 call."""
    root, env, out = _publish_env(r2, tmp_path)
    (out / "data" / "730").mkdir(parents=True)
    (out / "data" / "730" / "latest.json").write_text("[]")
    (out / "coverage-rows.json").write_text("{}")
    with open(out / "coverage.html", "wb") as fh:
        fh.truncate(25 * 1024 * 1024 + 1)
    r = _run(SCRIPTS / "publish-cloudflare.sh", out, ROOT, env=env)
    assert r.returncode == 1
    assert "coverage.html is 26214401 bytes, over the Cloudflare Pages 25 MiB file limit" in r.stdout
    assert not (root / "calls.log").exists()
    assert not (root / "npx.log").exists()


def test_publish_allows_file_at_exactly_the_pages_limit(r2, tmp_path):
    root, env, out = _publish_env(r2, tmp_path)
    with open(out / "search-index.json", "wb") as fh:
        fh.truncate(25 * 1024 * 1024)
    r = _run(SCRIPTS / "publish-cloudflare.sh", out, ROOT, env={**env, "SKIP_R2_SYNC": "1"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "over the Cloudflare Pages" not in r.stdout
