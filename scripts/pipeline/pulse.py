"""Merge Pulse Reports (user-submitted via Decky / web form, stored in Supabase)
into the per-game year.json files alongside ProtonDB reports.

Runs as part of the normal pipeline (see finalize.py:finalize_output). The
source of truth stays Supabase - this just snapshots the latest state into
the static JSON so consumers don't have to fetch from two places.

Dedupe key: the Supabase row id. We store it as pulseId on the report so
re-runs replace stale records rather than duplicating them.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import app_id_to_dir, is_valid_app_id, log


SB_URL_DEFAULT = "https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1"
SB_ANON_KEY_DEFAULT = "sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V"


def _resolve_credentials() -> tuple[str, str]:
    """Allow overrides via env vars for staging / forks. Defaults to the prod project."""
    url = os.environ.get("SUPABASE_URL", SB_URL_DEFAULT).rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", SB_ANON_KEY_DEFAULT)
    return url, key


def fetch_pulse_rows(limit: int = 10000) -> list[dict[str, Any]]:
    """Pull all user_configs rows from Supabase via PostgREST."""
    base, key = _resolve_credentials()
    url = f"{base}/user_configs?select=*&order=created_at.desc&limit={limit}"
    req = urllib.request.Request(url, headers={"apikey": key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as exc:
        log(f"[pulse] Failed to fetch user_configs from Supabase: {exc}")
        return []

    if not isinstance(payload, list):
        log(f"[pulse] Unexpected payload shape from Supabase: {type(payload).__name__}")
        return []
    return payload


def _year_from_created_at(created_at: str) -> str:
    """Pull the UTC year out of an ISO timestamp. Falls back to 'unknown'."""
    if not created_at:
        return "unknown"
    # Supabase returns "2025-10-12T14:23:00.123456+00:00" or with Z suffix
    try:
        norm = created_at.replace("Z", "+00:00")
        dt = datetime.fromisoformat(norm)
        return str(dt.astimezone(timezone.utc).year)
    except (ValueError, TypeError):
        return "unknown"


def _ts_from_created_at(created_at: str) -> int:
    """Epoch seconds, or 0 if the string is unparseable."""
    if not created_at:
        return 0
    try:
        norm = created_at.replace("Z", "+00:00")
        return int(datetime.fromisoformat(norm).timestamp())
    except (ValueError, TypeError):
        return 0


def normalize_pulse_row(row: dict[str, Any]) -> dict[str, Any]:
    """Map snake_case Supabase columns into the camelCase shape that ProtonDB
    reports use, preserve Pulse-only fields, and tag source/submissionSource.
    """
    return {
        "appId": str(row.get("app_id", "")),
        "title": row.get("title") or "",
        "cpu": row.get("cpu") or "",
        "gpu": row.get("gpu") or "",
        "gpuDriver": row.get("gpu_driver") or "",
        "gpuVendor": row.get("gpu_vendor") or "",
        "ram": row.get("ram") or "",
        "vramMb": row.get("vram_mb"),
        "os": row.get("os") or "",
        "kernel": row.get("kernel") or "",
        "protonVersion": row.get("proton_version") or "",
        "rating": row.get("rating") or "",
        "duration": row.get("duration") or "",
        "durationMinutes": row.get("duration_minutes"),
        "notes": row.get("notes") or "",
        "launchOptions": row.get("launch_options") or "",
        "formResponses": row.get("form_responses"),
        "configKey": row.get("config_key"),
        "gameOwned": row.get("game_owned"),
        "timestamp": _ts_from_created_at(row.get("created_at", "")),
        "pulseId": row.get("id"),
        "appType": row.get("app_type") or "steam",
        # keep the granular submission origin (user / web-linux / web / etc)
        # so we don't lose it under the broader source: "pulse" tag
        "submissionSource": row.get("source"),
        "source": "pulse",
    }


def _bucket_by_app_year(rows: list[dict]) -> dict[tuple[str, str], list[dict]]:
    """Group normalized pulse reports by (appId, year) like process.py does."""
    buckets: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        app_id = str(row.get("app_id", "")).strip()
        if not is_valid_app_id(app_id):
            continue
        year = _year_from_created_at(row.get("created_at", ""))
        buckets[(app_id, year)].append(normalize_pulse_row(row))
    return buckets


def merge_pulse_into_data_dir(data_output_path: Path) -> tuple[int, int]:
    """Pull Pulse reports from Supabase and merge them into the appropriate
    year.json files. Returns (apps_touched, reports_merged) for logging.

    Dedup by pulseId: any existing record with the same pulseId is replaced
    by the fresh Supabase version, so users can edit their submissions and
    have the static snapshot reflect the latest state on the next pipeline run.
    """
    rows = fetch_pulse_rows()
    if not rows:
        log("[pulse] No Pulse reports to merge (Supabase returned 0 rows)")
        return 0, 0

    buckets = _bucket_by_app_year(rows)
    apps_touched: set[str] = set()
    reports_merged = 0

    for (app_id, year), pulse_reports in buckets.items():
        app_dir = data_output_path / app_id_to_dir(app_id)
        app_dir.mkdir(parents=True, exist_ok=True)
        year_file = app_dir / f"{year}.json"

        existing: list[Any] = []
        if year_file.exists():
            try:
                existing = json.loads(year_file.read_text())
            except (json.JSONDecodeError, OSError) as exc:
                log(f"[pulse] {year_file} unreadable, treating as empty: {exc}")
                existing = []
        if not isinstance(existing, list):
            existing = []

        # drop any old pulse records with ids we're about to re-add (covers edits)
        incoming_ids = {p["pulseId"] for p in pulse_reports if p.get("pulseId") is not None}
        filtered = [
            r for r in existing
            if not (
                isinstance(r, dict)
                and r.get("source") == "pulse"
                and r.get("pulseId") in incoming_ids
            )
        ]

        # backfill source on legacy protondb records that haven't been re-tagged yet
        for r in filtered:
            if isinstance(r, dict) and "source" not in r:
                r["source"] = "protondb"

        filtered.extend(pulse_reports)
        year_file.write_text(json.dumps(filtered, indent=2))

        apps_touched.add(app_id)
        reports_merged += len(pulse_reports)

    log(
        f"[pulse] Merged {reports_merged} Pulse report(s) across {len(apps_touched)} app(s)"
    )
    return len(apps_touched), reports_merged
