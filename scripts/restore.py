#!/usr/bin/env python3
"""
Full-restore automation for Proton Pulse (#265).

Interactive-friendly script that walks a new maintainer through a fresh
recovery of the whole stack: Supabase schema + edge fns, GitHub secrets,
gh-pages seed, backup import, wiki restore, verification checklist.

Usage:
    scripts/restore.py --stage all
    scripts/restore.py --stage supabase --project-ref abc123
    scripts/restore.py --stage import --backup-dir ~/backups/latest
    scripts/restore.py --check   # verification-only

Each stage prints exactly what it's about to do and prompts before any
destructive or account-touching action. Pair with the wiki Restore-Runbook
page -- this script mechanizes the same steps, so the two must stay in
sync.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import shlex
import subprocess
import sys
from dataclasses import dataclass


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
SUPABASE_PROJECT_URL_TEMPLATE = "https://{ref}.supabase.co"

# The single source of truth for every required GH Actions secret. Keep in
# sync with the Restore-Runbook wiki table.
REQUIRED_SECRETS = [
    ("SUPABASE_URL", "Supabase console -> Project Settings -> API"),
    ("SUPABASE_ANON_KEY", "Supabase console -> Project Settings -> API"),
    ("SUPABASE_SERVICE_ROLE_KEY", "Supabase console -> Project Settings -> API"),
    ("SUPABASE_TOKEN", "Supabase Account -> Access Tokens"),
    ("BACKUP_HMAC_SECRET", "generate: openssl rand -hex 32"),
    ("BACKUP_REPO_TOKEN", "GitHub fine-grained PAT (Contents R/W on backup repo)"),
    ("STAGING_DEPLOY_TOKEN", "GitHub fine-grained PAT (Contents R/W on staging repo)"),
    ("DISCORD_WEBHOOK_ANNOUNCE", "Discord server integrations"),
    ("DISCORD_WEBHOOK_BACKUPS", "Discord server integrations"),
    ("DISCORD_WEBHOOK_BUILDS", "Discord server integrations"),
    ("DISCORD_WEBHOOK_ISSUES", "Discord server integrations"),
    ("DISCORD_WEBHOOK_PULL_REQUESTS", "Discord server integrations"),
    ("DISCORD_WEBHOOK_RELEASES", "Discord server integrations"),
    ("STEAM_API_KEY", "https://steamcommunity.com/dev/apikey"),
    ("SGDB_API_KEY", "https://www.steamgriddb.com/profile/preferences/api"),
    ("OPENAI_API_KEY", "https://platform.openai.com/api-keys"),
    ("VT_API_KEY", "https://www.virustotal.com/gui/my-apikey"),
    ("CODECOV_TOKEN", "codecov.io repo settings"),
]


@dataclass
class Ctx:
    """Runtime context shared across stages."""
    project_ref: str | None
    backup_dir: pathlib.Path | None
    yes: bool  # skip confirmations


def confirm(ctx: Ctx, message: str) -> bool:
    if ctx.yes:
        print(f"[auto-confirm] {message}")
        return True
    resp = input(f"{message} [y/N] ").strip().lower()
    return resp in ("y", "yes")


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    """Print then run. Never uses shell=True to keep command visible."""
    print("$ " + " ".join(shlex.quote(c) for c in cmd))
    return subprocess.run(cmd, check=check)


def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


# --- Stage: preflight ---------------------------------------------------
def stage_preflight(ctx: Ctx) -> None:
    print("\n=== Preflight ===")
    required = ["gh", "git", "jq", "curl", "psql", "python3", "supabase"]
    missing = [t for t in required if not have_cmd(t)]
    if missing:
        die(f"missing required tools: {', '.join(missing)}")
    if not (REPO_ROOT / "supabase" / "functions").is_dir():
        die("scripts/restore.py must run from a proton-pulse-web checkout")
    print("preflight ok")


def have_cmd(name: str) -> bool:
    return subprocess.run(["which", name], capture_output=True).returncode == 0


# --- Stage: supabase ----------------------------------------------------
def stage_supabase(ctx: Ctx) -> None:
    print("\n=== Supabase project restore ===")
    if not ctx.project_ref:
        die("--project-ref required for supabase stage")
    token = os.environ.get("SUPABASE_TOKEN") or die("SUPABASE_TOKEN env required")
    ref = ctx.project_ref

    print(f"target project: {ref}")
    if not confirm(ctx, f"apply all supabase/migrations to project {ref}?"):
        die("aborted at migration step")

    for mig in sorted((REPO_ROOT / "supabase" / "migrations").glob("*.sql")):
        print(f"applying {mig.name}...")
        sql = mig.read_text(encoding="utf-8")
        # Post to management API; body is a single-key JSON blob.
        import json
        import urllib.request
        body = json.dumps({"query": sql}).encode("utf-8")
        req = urllib.request.Request(
            f"https://api.supabase.com/v1/projects/{ref}/database/query",
            data=body,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        # URL from hardcoded Supabase management API base + trusted project ref
        with urllib.request.urlopen(req) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            resp_body = resp.read().decode("utf-8")
        if resp_body.strip() not in ("[]", "[ ]"):
            print(f"  response: {resp_body[:200]}")

    print("migrations applied")
    if not confirm(ctx, "deploy every edge function to this project?"):
        return

    os.environ["SUPABASE_ACCESS_TOKEN"] = token
    for fn in sorted((REPO_ROOT / "supabase" / "functions").iterdir()):
        if not fn.is_dir() or fn.name == "_shared":
            continue
        run(["supabase", "functions", "deploy", fn.name, "--project-ref", ref])

    print("edge functions deployed")


# --- Stage: secrets -----------------------------------------------------
def stage_secrets(ctx: Ctx) -> None:
    print("\n=== GitHub Actions secrets checklist ===")
    print("For each secret below, confirm it is set in:")
    print("  gh repo settings -> Secrets and variables -> Actions")
    print()
    for name, source in REQUIRED_SECRETS:
        print(f"  [ ] {name:32}  <-  {source}")
    print()
    print("If setting via gh CLI:")
    print("  gh secret set NAME --body 'VALUE' --repo mdeguzis/proton-pulse-web")


# --- Stage: import ------------------------------------------------------
def stage_import(ctx: Ctx) -> None:
    print("\n=== Data import from backup tarballs ===")
    if not ctx.backup_dir or not ctx.backup_dir.is_dir():
        die("--backup-dir required and must point at the extracted latest/ directory")
    known = {
        "latest-schema.tar.gz": "pg schema (skip if migrations already applied)",
        "latest-user_configs.tar.gz": "user_configs table dump (psql COPY)",
        "latest-author_avatars.tar.gz": "storage bucket dump (supabase storage cp)",
        "latest-site.tar.gz": "gh-pages snapshot (git checkout --orphan + tar + push)",
    }
    for f, note in known.items():
        path = ctx.backup_dir / f
        status = "found" if path.exists() else "MISSING"
        print(f"  {status:8}  {f}  -- {note}")
    print()
    print("Import steps are documented in the Restore-Runbook Phase 3 wiki page.")
    print("This script does not automate destructive imports -- read the wiki + run each command manually.")


# --- Stage: verify ------------------------------------------------------
def stage_verify(ctx: Ctx) -> None:
    print("\n=== Verification checklist ===")
    checks = [
        "https://www.proton-pulse.com/about.html shows the version + short SHA you expected",
        "https://www.proton-pulse.com/data/570/index.json returns non-empty ProtonDB data",
        "Steam sign-in from /profile.html completes",
        "/admin.html recognises a seed admin uuid inserted into the admins table",
        "Filing an incident-labeled issue posts a Discord announcement",
        "/status.html loads and every edge function reads green",
        "Submit a dummy report through the plugin or /submit.html and approve it in admin",
    ]
    for i, c in enumerate(checks, 1):
        print(f"  {i}. [ ] {c}")


# --- Stage runner -------------------------------------------------------
STAGES = {
    "preflight": stage_preflight,
    "supabase": stage_supabase,
    "secrets": stage_secrets,
    "import": stage_import,
    "verify": stage_verify,
}
DEFAULT_ORDER = ["preflight", "supabase", "secrets", "import", "verify"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stage", default="all",
                    help=f"one of: all, {', '.join(STAGES)}")
    ap.add_argument("--project-ref", help="Supabase project ref (from console URL)")
    ap.add_argument("--backup-dir", type=pathlib.Path,
                    help="Path to the extracted latest/ directory from proton-pulse-data-backup")
    ap.add_argument("--yes", action="store_true", help="Auto-confirm every prompt (dangerous)")
    ap.add_argument("--check", action="store_true", help="Run only the verify stage")
    args = ap.parse_args()

    if args.check:
        args.stage = "verify"

    ctx = Ctx(project_ref=args.project_ref, backup_dir=args.backup_dir, yes=args.yes)

    if args.stage == "all":
        for stage in DEFAULT_ORDER:
            STAGES[stage](ctx)
        return
    if args.stage not in STAGES:
        die(f"unknown stage: {args.stage}. one of: all, {', '.join(STAGES)}")
    STAGES[args.stage](ctx)


if __name__ == "__main__":  # pragma: no cover
    main()
