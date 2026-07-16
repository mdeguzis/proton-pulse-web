"""Emit per-Steam-app depots.json files during finalize (#237).

Reads:
  - public.steam_depot_updates            (current per-OS depot rows)
  - public.steam_depot_manifest_history   (observed manifest history, first_seen)
  - public.steam_depot_fetch_status       (raw_pics JSONB blob per app)

Writes:
  {data_output_path}/{appIdDir}/depots.json

Shape (per-file):
  {
    "app_id": 367520,
    "fetched_at": "...",
    "status": "ok" | "no_public_manifest" | "error",
    "os": {
      "linux": {
        "depots": 1,
        "last_updated": "...",       # max last_updated_at across depots for this OS
        "tracked_since": "...",      # earliest first_observed_at we recorded
        "manifests": [ ... ]         # every manifest we have ever observed
      },
      ...
    },
    "raw_pics": { ... }              # full parsed depots dict from steamcmd
  }

Only Steam-numeric app IDs are written; GOG/Epic ids are skipped (no PICS).
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from .common import log, app_id_to_dir


PAGE_SIZE = 1000  # PostgREST default range; we page for safety on large scans.


def _supabase_url() -> str | None:
    return os.environ.get("SUPABASE_URL")


def _service_key() -> str | None:
    return os.environ.get("SUPABASE_SERVICE_ROLE_KEY")


def _headers() -> dict:
    key = _service_key()
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY missing; cannot read depot tables")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }


def _get(path: str, params: dict) -> list[dict]:
    base = _supabase_url()
    if not base:
        raise RuntimeError("SUPABASE_URL missing; cannot read depot tables")
    url = f"{base}/rest/v1{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=_headers(), method="GET")
    # URL from hardcoded Supabase base + static REST path
    with urllib.request.urlopen(req, timeout=60) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        return json.loads(resp.read())


def _fetch_all(path: str, select: str, order: str) -> list[dict]:
    """Page through a PostgREST endpoint until it stops returning rows."""
    out: list[dict] = []
    offset = 0
    while True:
        params = {"select": select, "order": order, "limit": PAGE_SIZE, "offset": offset}
        batch = _get(path, params)
        if not batch:
            break
        out.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return out


def _load_all() -> tuple[dict, dict, dict]:
    """Pull every relevant row once and group by app_id in Python.

    A single scan beats one HTTP request per app when we have thousands of
    tracked apps. For the current ~10 apps this is trivial, but the design
    scales with #215 growing the tracked set.
    """
    updates = _fetch_all(
        "/steam_depot_updates",
        select="app_id,depot_id,os,name,manifest_id,last_updated_at",
        order="app_id.asc",
    )
    history = _fetch_all(
        "/steam_depot_manifest_history",
        select="app_id,depot_id,os,manifest_id,first_observed_at,latest_observed_at",
        order="app_id.asc",
    )
    status = _fetch_all(
        "/steam_depot_fetch_status",
        select="app_id,app_status,depot_count,fetched_at,error,raw_pics",
        order="app_id.asc",
    )

    upd_by_app: dict = defaultdict(list)
    hist_by_app: dict = defaultdict(list)
    for row in updates:
        upd_by_app[row["app_id"]].append(row)
    for row in history:
        hist_by_app[row["app_id"]].append(row)
    status_by_app = {row["app_id"]: row for row in status}
    return upd_by_app, hist_by_app, status_by_app


def _build_depot_file(app_id: int, updates: list[dict], history: list[dict], status: dict | None) -> dict:
    """Group updates + history into a per-OS structure and attach raw_pics."""
    by_os: dict = {}
    upd_by_os: dict = defaultdict(list)
    hist_by_os: dict = defaultdict(list)
    for row in updates:
        upd_by_os[row["os"]].append(row)
    for row in history:
        hist_by_os[row["os"]].append(row)

    for os_key in sorted(set(list(upd_by_os) + list(hist_by_os))):
        upds = upd_by_os.get(os_key, [])
        hist = hist_by_os.get(os_key, [])
        last_updates = [r["last_updated_at"] for r in upds if r.get("last_updated_at")]
        first_seens = [r["first_observed_at"] for r in hist if r.get("first_observed_at")]
        depots_seen = {r["depot_id"] for r in upds} | {r["depot_id"] for r in hist}
        by_os[os_key] = {
            "depots": len(depots_seen),
            "last_updated": max(last_updates) if last_updates else None,
            "tracked_since": min(first_seens) if first_seens else None,
            "manifests": [
                {
                    "depot_id":            r["depot_id"],
                    "manifest_id":         r["manifest_id"],
                    "first_observed_at":   r.get("first_observed_at"),
                    "latest_observed_at":  r.get("latest_observed_at"),
                }
                for r in hist
            ],
        }

    return {
        "app_id":     app_id,
        "fetched_at": status.get("fetched_at") if status else None,
        "status":     status.get("app_status") if status else "unknown",
        "os":         by_os,
        "raw_pics":   status.get("raw_pics") if status else None,
    }


def write_depot_files(data_output_path: str | Path) -> int:
    """Emit depots.json per Steam app under `{data_output_path}/{appId}/`.

    Returns the number of files written. Non-Steam ids are skipped.
    """
    if not _supabase_url() or not _service_key():
        log("[depot-files] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing -- skipping")
        return 0

    base = Path(data_output_path)
    upd_by_app, hist_by_app, status_by_app = _load_all()

    app_ids = set(upd_by_app) | set(hist_by_app) | set(status_by_app)
    if not app_ids:
        log("[depot-files] no depot rows in Supabase yet -- nothing to write")
        return 0

    written = 0
    for app_id in sorted(app_ids):
        payload = _build_depot_file(
            app_id,
            upd_by_app.get(app_id, []),
            hist_by_app.get(app_id, []),
            status_by_app.get(app_id),
        )
        app_dir = base / app_id_to_dir(str(app_id))
        app_dir.mkdir(parents=True, exist_ok=True)
        (app_dir / "depots.json").write_text(
            json.dumps(payload, sort_keys=True, indent=2),
            encoding="utf-8",
        )
        written += 1
    log(f"[depot-files] wrote {written} depots.json file(s) source=steam_depot_*")
    return written


if __name__ == "__main__":
    # `python -m scripts.pipeline.write_depot_files /tmp/protondb-output/data`
    import sys
    if len(sys.argv) != 2:
        print("usage: python -m scripts.pipeline.write_depot_files <data_output_dir>", file=sys.stderr)
        sys.exit(2)
    write_depot_files(sys.argv[1])
