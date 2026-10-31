#!/usr/bin/env python3
"""Load an encrypted database backup (#580) into a Supabase project.

The target should be a fresh project with every migration already applied
(Restore-Runbook Phase 2.1). This loads the rows only:

  1. decrypt the .tar.gz.age with the offline age identity and unpack it
  2. check each table file against the manifest's sha256 (a mismatch aborts
     before anything is written)
  3. insert each table in batches with session_replication_role = replica,
     so foreign keys and triggers don't care about load order
  4. move every serial / identity sequence past the restored ids
  5. compare row counts with the manifest; any difference exits non-zero

Usage:
    python3 -m scripts.restore_db --project-ref NEW_REF \\
        --backup db-....tar.gz.age --identity ~/.proton-pulse-backup-age.key
    python3 -m scripts.restore_db --project-ref NEW_REF --dir ./unpacked
Env:
    SUPABASE_TOKEN   Management API token with access to the target project

Refuses the prod project unless --allow-prod is passed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from scripts.backup_db import DEFAULT_PROJECT_REF, Query, log, make_query, qualified

BATCH_ROWS = 500


class RestoreError(RuntimeError):
    pass


def decrypt(backup: Path, identity: Path, dest: Path) -> Path:
    """age -d the backup into dest and unpack it. Returns the dump dir."""
    plain = dest / "db.tar.gz"
    subprocess.run(["age", "-d", "-i", str(identity), "-o", str(plain), str(backup)], check=True)
    out = dest / "dump"
    out.mkdir()
    with tarfile.open(plain) as tar:
        tar.extractall(out, filter="data")
    plain.unlink()
    return out


def load_manifest(dump: Path) -> dict:
    manifest = json.loads((dump / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format") != 1:
        raise RestoreError(f"unsupported backup format {manifest.get('format')!r}")
    for name, meta in manifest["tables"].items():
        data = (dump / "tables" / f"{name}.json").read_bytes()
        if hashlib.sha256(data).hexdigest() != meta["sha256"]:
            raise RestoreError(f"{name}: sha256 does not match the manifest; backup is corrupt or altered")
    return manifest


def ordered_tables(manifest: dict) -> list[str]:
    """auth first, so the account rows exist before anything that names them."""
    names = list(manifest["tables"])
    return [n for n in names if n.startswith("auth.")] + [n for n in names if not n.startswith("auth.")]


def insert_sql(name: str, meta: dict, rows: list[dict]) -> str:
    cols = [c for c in meta["columns"] if c not in meta.get("generated", [])]
    col_list = ", ".join('"' + c.replace('"', '""') + '"' for c in cols)
    payload = json.dumps(rows, separators=(",", ":"))
    tag = "pp" + secrets.token_hex(6)
    while f"${tag}$" in payload:  # pragma: no cover - 48 random bits
        tag = "pp" + secrets.token_hex(6)
    table = qualified(name)
    return (
        "begin;\n"
        "set local session_replication_role = replica;\n"
        f"insert into {table} ({col_list}) overriding system value\n"
        f"select {col_list} from json_populate_recordset(null::{table}, ${tag}${payload}${tag}$::json);\n"
        "commit;"
    )


RESET_SEQUENCES_SQL = """
do $$
declare r record;
begin
  for r in
    select n.nspname as schema, c.relname as tbl, a.attname as col,
           pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) as seq
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  loop
    if r.seq is not null then
      execute format('select setval(%L, coalesce((select max(%I) from %I.%I), 0) + 1, false)',
                     r.seq, r.col, r.schema, r.tbl);
    end if;
  end loop;
end $$;
"""


def count_rows(query: Query, name: str) -> int:
    return int(query(f"select count(*) as n from {qualified(name)}")[0]["n"])


def restore(query: Query, dump: Path, batch_rows: int = BATCH_ROWS) -> dict[str, tuple[int, int]]:
    """Load every table, reset sequences, return {name: (expected, actual)}
    for each table whose count differs."""
    manifest = load_manifest(dump)
    for name in ordered_tables(manifest):
        meta = manifest["tables"][name]
        rows = json.loads((dump / "tables" / f"{name}.json").read_text(encoding="utf-8"))
        for i in range(0, len(rows), batch_rows):
            query(insert_sql(name, meta, rows[i:i + batch_rows]))
        log(f"{name}: loaded {len(rows)} rows")
    query(RESET_SEQUENCES_SQL)
    mismatched = {}
    for name, meta in manifest["tables"].items():
        actual = count_rows(query, name)
        if actual != meta["rows"]:
            mismatched[name] = (meta["rows"], actual)
    return mismatched


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--project-ref", required=True)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--backup", type=Path, help="encrypted .tar.gz.age")
    src.add_argument("--dir", type=Path, help="an already decrypted + unpacked dump")
    ap.add_argument("--identity", type=Path, help="age identity file (with --backup)")
    ap.add_argument("--allow-prod", action="store_true")
    args = ap.parse_args(argv)

    if args.project_ref == DEFAULT_PROJECT_REF and not args.allow_prod:
        log("ERROR: target is the prod project; pass --allow-prod if that is really intended")
        return 2
    if args.backup and not args.identity:
        log("ERROR: --backup needs --identity")
        return 2
    token = os.environ.get("SUPABASE_TOKEN", "").strip()
    if not token:
        log("ERROR: SUPABASE_TOKEN is not set")
        return 2

    query = make_query(token, args.project_ref)
    with tempfile.TemporaryDirectory() as tmp:
        dump = decrypt(args.backup, args.identity, Path(tmp)) if args.backup else args.dir
        mismatched = restore(query, dump)
    for name, (want, got) in sorted(mismatched.items()):
        log(f"ERROR: {name}: expected {want} rows, found {got}")
    if mismatched:
        return 1
    log("restore complete; every table count matches the manifest")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
