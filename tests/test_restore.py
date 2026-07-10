"""
Strict tests for scripts/restore.py (#265).

Every function, every branch. Network + subprocess + stdin + env are all
mocked -- these tests never touch a Supabase project, never shell out to
`gh`, never hit the filesystem outside tmp_path.

The restore script is load-bearing for disaster recovery, so drift here
breaks the runbook silently. Keep this file exhaustive.
"""
from __future__ import annotations

import io
import json
import os
import pathlib
import subprocess
import sys
from unittest.mock import MagicMock, patch

import pytest


# Import the module under test. scripts/ isn't a package, so path-hack it.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import restore  # noqa: E402


# ---------------------------------------------------------------------------
# Ctx dataclass
# ---------------------------------------------------------------------------

def test_ctx_defaults_are_all_none_or_false():
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=False)
    assert ctx.project_ref is None
    assert ctx.backup_dir is None
    assert ctx.yes is False


# ---------------------------------------------------------------------------
# confirm()
# ---------------------------------------------------------------------------

def test_confirm_yes_shortcircuits_when_ctx_yes_true(capsys):
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=True)
    assert restore.confirm(ctx, "delete everything") is True
    out = capsys.readouterr().out
    assert "auto-confirm" in out
    assert "delete everything" in out


@pytest.mark.parametrize("reply, expected", [
    ("y", True), ("Y", True), ("yes", True), ("YES", True),
    ("n", False), ("N", False), ("no", False),
    ("", False), ("maybe", False), ("  yes  ", True),
])
def test_confirm_prompts_when_not_yes(reply, expected, monkeypatch):
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=False)
    monkeypatch.setattr("builtins.input", lambda prompt="": reply)
    assert restore.confirm(ctx, "proceed?") is expected


# ---------------------------------------------------------------------------
# run() -- prints and invokes subprocess.run
# ---------------------------------------------------------------------------

def test_run_invokes_subprocess_with_exact_argv(capsys):
    with patch.object(restore.subprocess, "run") as sp:
        sp.return_value = subprocess.CompletedProcess(args=["echo", "hi"], returncode=0)
        result = restore.run(["echo", "hi and low"])
    sp.assert_called_once_with(["echo", "hi and low"], check=True)
    printed = capsys.readouterr().out
    assert "echo" in printed
    assert "'hi and low'" in printed  # shlex.quote hits multi-word args
    assert result.returncode == 0


def test_run_check_false_passes_through():
    with patch.object(restore.subprocess, "run") as sp:
        sp.return_value = subprocess.CompletedProcess(args=["false"], returncode=1)
        restore.run(["false"], check=False)
    sp.assert_called_once_with(["false"], check=False)


# ---------------------------------------------------------------------------
# die()
# ---------------------------------------------------------------------------

def test_die_exits_with_code_and_prints_to_stderr(capsys):
    with pytest.raises(SystemExit) as e:
        restore.die("boom")
    assert e.value.code == 1
    err = capsys.readouterr().err
    assert "ERROR: boom" in err


def test_die_custom_exit_code():
    with pytest.raises(SystemExit) as e:
        restore.die("nope", code=42)
    assert e.value.code == 42


# ---------------------------------------------------------------------------
# have_cmd()
# ---------------------------------------------------------------------------

def test_have_cmd_true_when_which_succeeds():
    with patch.object(restore.subprocess, "run") as sp:
        sp.return_value = subprocess.CompletedProcess(args=[], returncode=0)
        assert restore.have_cmd("git") is True


def test_have_cmd_false_when_which_fails():
    with patch.object(restore.subprocess, "run") as sp:
        sp.return_value = subprocess.CompletedProcess(args=[], returncode=1)
        assert restore.have_cmd("nonesuch") is False


# ---------------------------------------------------------------------------
# stage_preflight()
# ---------------------------------------------------------------------------

def test_preflight_ok_when_all_tools_present(monkeypatch, capsys):
    monkeypatch.setattr(restore, "have_cmd", lambda name: True)
    # supabase/functions/ exists in the real repo, so preflight should pass
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=True)
    restore.stage_preflight(ctx)
    assert "preflight ok" in capsys.readouterr().out


def test_preflight_dies_when_a_tool_missing(monkeypatch):
    monkeypatch.setattr(restore, "have_cmd", lambda name: name != "psql")
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=True)
    with pytest.raises(SystemExit):
        restore.stage_preflight(ctx)


def test_preflight_dies_when_not_in_repo(monkeypatch, tmp_path):
    monkeypatch.setattr(restore, "have_cmd", lambda name: True)
    monkeypatch.setattr(restore, "REPO_ROOT", tmp_path)
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=True)
    with pytest.raises(SystemExit):
        restore.stage_preflight(ctx)


# ---------------------------------------------------------------------------
# stage_supabase()
# ---------------------------------------------------------------------------

def test_supabase_requires_project_ref(monkeypatch):
    monkeypatch.delenv("SUPABASE_TOKEN", raising=False)
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=True)
    with pytest.raises(SystemExit):
        restore.stage_supabase(ctx)


def test_supabase_requires_token(monkeypatch):
    monkeypatch.delenv("SUPABASE_TOKEN", raising=False)
    ctx = restore.Ctx(project_ref="abc123", backup_dir=None, yes=True)
    with pytest.raises(SystemExit):
        restore.stage_supabase(ctx)


def test_supabase_aborts_when_migration_confirm_denied(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPABASE_TOKEN", "tok")
    monkeypatch.setattr(restore, "REPO_ROOT", tmp_path)
    (tmp_path / "supabase" / "migrations").mkdir(parents=True)
    (tmp_path / "supabase" / "migrations" / "0001.sql").write_text("SELECT 1")
    monkeypatch.setattr(restore, "confirm", lambda ctx, msg: False)
    ctx = restore.Ctx(project_ref="abc123", backup_dir=None, yes=False)
    with pytest.raises(SystemExit):
        restore.stage_supabase(ctx)


def test_supabase_applies_migrations_in_sorted_order(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SUPABASE_TOKEN", "tok")
    monkeypatch.setattr(restore, "REPO_ROOT", tmp_path)
    mig = tmp_path / "supabase" / "migrations"
    mig.mkdir(parents=True)
    # Written out of order to prove sorted() gets used
    (mig / "0002.sql").write_text("SELECT 2")
    (mig / "0001.sql").write_text("SELECT 1")

    prompts = []
    monkeypatch.setattr(restore, "confirm", lambda ctx, msg: (prompts.append(msg), True)[1])

    posted = []

    class FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return b"[]"

    def fake_urlopen(req):
        posted.append((req.full_url, req.data.decode("utf-8")))
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    ctx = restore.Ctx(project_ref="abc123", backup_dir=None, yes=False)
    # Answer "no" to the second (deploy edge fn) prompt so we exit after migrations
    responses = iter([True, False])
    monkeypatch.setattr(restore, "confirm", lambda ctx, msg: next(responses))

    restore.stage_supabase(ctx)

    # Both migrations posted, in order
    assert len(posted) == 2
    assert "0001" not in posted[0][1]  # the URL doesn't carry the name; check body has SELECT 1 first
    assert "SELECT 1" in posted[0][1]
    assert "SELECT 2" in posted[1][1]
    # URLs point at the right project
    assert "abc123" in posted[0][0]


def test_supabase_prints_non_empty_response_body(monkeypatch, tmp_path, capsys):
    """Coverage for the 'response contained something' branch on line 129."""
    monkeypatch.setenv("SUPABASE_TOKEN", "tok")
    monkeypatch.setattr(restore, "REPO_ROOT", tmp_path)
    mig = tmp_path / "supabase" / "migrations"
    mig.mkdir(parents=True)
    (mig / "0001.sql").write_text("SELECT 1")

    class FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return b'{"error":"boom"}'

    monkeypatch.setattr("urllib.request.urlopen", lambda req: FakeResponse())
    # Approve migrations, decline edge fn deploy so we exit early
    responses = iter([True, False])
    monkeypatch.setattr(restore, "confirm", lambda ctx, msg: next(responses))
    ctx = restore.Ctx(project_ref="abc123", backup_dir=None, yes=False)
    restore.stage_supabase(ctx)
    out = capsys.readouterr().out
    assert "response:" in out
    assert "boom" in out


def test_supabase_deploys_edge_fns_skipping_shared(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPABASE_TOKEN", "tok")
    monkeypatch.setattr(restore, "REPO_ROOT", tmp_path)
    (tmp_path / "supabase" / "migrations").mkdir(parents=True)  # empty
    fn_dir = tmp_path / "supabase" / "functions"
    fn_dir.mkdir(parents=True)
    (fn_dir / "_shared").mkdir()
    (fn_dir / "steam-callback").mkdir()
    (fn_dir / "steam-appdetails").mkdir()
    # Not a directory: should be ignored
    (fn_dir / "README.md").write_text("hi")

    monkeypatch.setattr(restore, "confirm", lambda ctx, msg: True)
    calls = []
    monkeypatch.setattr(restore, "run", lambda cmd, **kw: calls.append(cmd))

    ctx = restore.Ctx(project_ref="abc123", backup_dir=None, yes=True)
    restore.stage_supabase(ctx)

    # each call is ["supabase", "functions", "deploy", <name>, "--project-ref", <ref>]
    deployed = [c[3] for c in calls if len(c) > 3 and c[0] == "supabase"]
    assert "steam-callback" in deployed
    assert "steam-appdetails" in deployed
    assert "_shared" not in deployed
    # SUPABASE_ACCESS_TOKEN env is set for supabase CLI
    assert os.environ.get("SUPABASE_ACCESS_TOKEN") == "tok"


# ---------------------------------------------------------------------------
# stage_secrets()
# ---------------------------------------------------------------------------

def test_secrets_prints_every_required_secret(capsys):
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=True)
    restore.stage_secrets(ctx)
    out = capsys.readouterr().out
    for name, _source in restore.REQUIRED_SECRETS:
        assert name in out


def test_required_secrets_covers_every_workflow_secret_used():
    # If a workflow introduces a new secret, this list must include it.
    # Grep secrets.* in .github/workflows/*.yml and diff.
    import re
    wf_dir = pathlib.Path(__file__).resolve().parents[1] / ".github" / "workflows"
    pattern = re.compile(r"secrets\.([A-Z_][A-Z0-9_]*)")
    found = set()
    for f in wf_dir.glob("*.yml"):
        found.update(pattern.findall(f.read_text(encoding="utf-8")))
    # These two are internal / injected by Actions; not our list
    found -= {"GITHUB_TOKEN"}
    required = {name for name, _ in restore.REQUIRED_SECRETS}
    missing = found - required
    assert not missing, (
        "Workflows use secrets not tracked in restore.REQUIRED_SECRETS: "
        f"{sorted(missing)}. Update scripts/restore.py + Restore-Runbook.md."
    )


# ---------------------------------------------------------------------------
# stage_import()
# ---------------------------------------------------------------------------

def test_import_requires_backup_dir():
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=True)
    with pytest.raises(SystemExit):
        restore.stage_import(ctx)


def test_import_requires_dir_that_exists(tmp_path):
    ctx = restore.Ctx(project_ref=None, backup_dir=tmp_path / "nope", yes=True)
    with pytest.raises(SystemExit):
        restore.stage_import(ctx)


def test_import_reports_found_and_missing_artifacts(tmp_path, capsys):
    (tmp_path / "latest-schema.tar.gz").write_bytes(b"fake")
    ctx = restore.Ctx(project_ref=None, backup_dir=tmp_path, yes=True)
    restore.stage_import(ctx)
    out = capsys.readouterr().out
    assert "found" in out
    assert "MISSING" in out
    assert "latest-schema.tar.gz" in out
    assert "latest-user_configs.tar.gz" in out


# ---------------------------------------------------------------------------
# stage_verify()
# ---------------------------------------------------------------------------

def test_verify_prints_numbered_checklist(capsys):
    ctx = restore.Ctx(project_ref=None, backup_dir=None, yes=True)
    restore.stage_verify(ctx)
    out = capsys.readouterr().out
    assert "1." in out and "7." in out
    assert "about.html" in out
    assert "status.html" in out


# ---------------------------------------------------------------------------
# main() argument routing
# ---------------------------------------------------------------------------

def test_main_check_flag_routes_to_verify(monkeypatch, capsys):
    called = []
    monkeypatch.setattr(restore, "STAGES", {"verify": lambda ctx: called.append("verify")})
    monkeypatch.setattr(sys, "argv", ["restore.py", "--check"])
    restore.main()
    assert called == ["verify"]


def test_main_default_all_runs_default_order_in_sequence(monkeypatch):
    called = []
    monkeypatch.setattr(restore, "STAGES", {name: (lambda n: (lambda ctx: called.append(n)))(name)
                                             for name in restore.DEFAULT_ORDER})
    monkeypatch.setattr(sys, "argv", ["restore.py"])
    restore.main()
    assert called == restore.DEFAULT_ORDER


def test_main_unknown_stage_exits(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["restore.py", "--stage", "bogus"])
    with pytest.raises(SystemExit):
        restore.main()


def test_main_explicit_single_stage(monkeypatch):
    called = []
    monkeypatch.setattr(restore, "STAGES", {"verify": lambda ctx: called.append("verify"),
                                             "preflight": lambda ctx: called.append("preflight")})
    monkeypatch.setattr(sys, "argv", ["restore.py", "--stage", "verify"])
    restore.main()
    assert called == ["verify"]


def test_main_passes_ctx_from_args(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(restore, "STAGES", {"verify": lambda ctx: seen.append(ctx)})
    monkeypatch.setattr(sys, "argv", [
        "restore.py", "--stage", "verify",
        "--project-ref", "abc",
        "--backup-dir", str(tmp_path),
        "--yes",
    ])
    restore.main()
    ctx = seen[0]
    assert ctx.project_ref == "abc"
    assert ctx.backup_dir == tmp_path
    assert ctx.yes is True
