#!/usr/bin/env python3
"""Full logical dump of the Supabase database for the encrypted backup (#580).

backup.yml only exports user_configs and author_avatars, pseudonymized, and
Supabase keeps no managed backups on this plan. This dumps every base table
in `public`, plus the auth tables needed to bring accounts back, through the
Management API (SUPABASE_TOKEN), so it needs no database password.

Output layout (plaintext, the caller tars + encrypts it with age):

    <out>/tables/<schema>.<table>.json   one JSON array of row objects
    <out>/manifest.json                  row counts, sha256 per file, columns

Every failure raises. A partial dump is worse than a failed run: the caller
would encrypt and upload it, and the restore would look complete.

Usage:
    python3 -m scripts.backup_db --out DIR
Env:
    SUPABASE_TOKEN          Management API token (required)
    SUPABASE_PROJECT_REF    default: the prod project
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

DEFAULT_PROJECT_REF = "ilsgdshkaocrmibwdezk"
API = "https://api.supabase.com/v1/projects/{ref}/database/query"

# Rebuilt by every pipeline finalize from search-index.json, ~100k rows.
EXCLUDED = frozenset({"public.search_index"})

# Accounts and their OAuth links. Sessions and refresh tokens are left out on
# purpose: after a restore everyone signs in again.
AUTH_TABLES = ("auth.users", "auth.identities")

PAGE_SIZE = 5000
RETRIES = 3

Query = Callable[[str], list]


def log(msg: str) -> None:
    print(f"[backup-db] {msg}", file=sys.stderr, flush=True)


def make_query(token: str, ref: str, opener: Callable = urllib.request.urlopen) -> Query:
    """Return query(sql) -> list of row dicts. Raises on HTTP or API errors.

    Retries transport errors and 5xx/429 a few times; the Management API
    occasionally resets connections (seen on paged reads, #578).
    """
    url = API.format(ref=ref)

    def query(sql: str) -> list:
        body = json.dumps({"query": sql}).encode()
        for attempt in range(1, RETRIES + 1):
            req = urllib.request.Request(url, data=body, method="POST", headers={
                "Authorization": f"Bearer {token}", "Content-Type": "application/json",
            })
            try:
                # Fixed Management API host + project ref.
                with opener(req, timeout=120) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
                    out = json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code < 500 and exc.code != 429:
                    # A rejected query: the body carries Postgres's message.
                    detail = exc.read().decode("utf-8", errors="replace")[:500]
                    raise RuntimeError(f"query rejected (HTTP {exc.code}): {detail}") from exc
                if attempt == RETRIES:
                    raise
                log(f"HTTP {exc.code}, retry {attempt}/{RETRIES - 1}")
            except (urllib.error.URLError, OSError) as exc:
                if attempt == RETRIES:
                    raise
                log(f"{type(exc).__name__}: {exc}, retry {attempt}/{RETRIES - 1}")
            else:
                if not isinstance(out, list):
                    raise RuntimeError(f"query failed: {str(out)[:300]}")
                return out
            time.sleep(2 * attempt)
        raise AssertionError("unreachable")  # pragma: no cover

    return query


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def qualified(name: str) -> str:
    schema, table = name.split(".", 1)
    return f"{_ident(schema)}.{_ident(table)}"


def list_tables(query: Query) -> list[str]:
    """Every public base table not in EXCLUDED, then the auth tables."""
    rows = query(
        "select table_schema || '.' || table_name as name from information_schema.tables "
        "where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"
    )
    public = [r["name"] for r in rows if r["name"] not in EXCLUDED]
    if not public:
        raise RuntimeError("no public tables listed; refusing to write an empty backup")
    return public + list(AUTH_TABLES)


def table_info(query: Query, name: str) -> dict:
    """Column names in order, primary key columns, generated columns."""
    schema, table = name.split(".", 1)
    rows = query(
        "select a.attname as col, a.attgenerated <> '' as generated, "
        "coalesce(a.attnum = any(i.indkey), false) as pk "
        "from pg_attribute a join pg_class c on c.oid = a.attrelid "
        "join pg_namespace n on n.oid = c.relnamespace "
        "left join pg_index i on i.indrelid = c.oid and i.indisprimary "
        f"where n.nspname = '{schema}' and c.relname = '{table}' "
        "and a.attnum > 0 and not a.attisdropped order by a.attnum"
    )
    if not rows:
        raise RuntimeError(f"{name}: no columns found")
    return {
        "columns": [r["col"] for r in rows],
        "primary_key": [r["col"] for r in rows if r["pk"]],
        "generated": [r["col"] for r in rows if r["generated"]],
    }


def dump_table(query: Query, name: str, info: dict, page_size: int = PAGE_SIZE) -> list[dict]:
    """All rows, ordered by primary key (or every column when there is none)
    so offset paging is stable."""
    order = ", ".join(_ident(c) for c in (info["primary_key"] or info["columns"]))
    rows: list[dict] = []
    offset = 0
    while True:
        page = query(
            f"select coalesce(json_agg(t), '[]'::json) as rows from "
            f"(select * from {qualified(name)} order by {order} "
            f"limit {page_size} offset {offset}) t"
        )
        batch = page[0]["rows"] if page else []
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        offset += page_size


def write_backup(query: Query, out: Path, ref: str) -> dict:
    out = Path(out)
    (out / "tables").mkdir(parents=True, exist_ok=True)
    manifest = {
        "format": 1,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "project_ref": ref,
        "excluded": sorted(EXCLUDED),
        "tables": {},
    }
    total = 0
    for name in list_tables(query):
        info = table_info(query, name)
        rows = dump_table(query, name, info)
        data = json.dumps(rows, separators=(",", ":"), sort_keys=True).encode("utf-8")
        path = out / "tables" / f"{name}.json"
        path.write_bytes(data)
        manifest["tables"][name] = {
            "rows": len(rows),
            "sha256": hashlib.sha256(data).hexdigest(),
            **info,
        }
        total += len(rows)
        log(f"{name}: {len(rows)} rows")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    log(f"dumped {len(manifest['tables'])} tables, {total} rows")
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args(argv)
    token = os.environ.get("SUPABASE_TOKEN", "").strip()
    if not token:
        log("ERROR: SUPABASE_TOKEN is not set")
        return 2
    ref = os.environ.get("SUPABASE_PROJECT_REF", DEFAULT_PROJECT_REF).strip()
    write_backup(make_query(token, ref), args.out, ref)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
