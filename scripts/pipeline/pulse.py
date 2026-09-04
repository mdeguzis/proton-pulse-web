"""Merge Pulse Reports (user-submitted via Decky / web form, stored in Supabase)
into the per-game year.json files alongside ProtonDB reports.

Runs as part of the normal pipeline (see finalize.py:finalize_output). The
source of truth stays Supabase - this just snapshots the latest state into
the static JSON so consumers don't have to fetch from two places.

Dedupe key: the Supabase row id. We store it as pulseId on the report so
re-runs replace stale records rather than duplicating them.

Deletion handling (#476): fetch_pulse_rows returns every LIVE row, not a
delta, so a deleted user_configs row is simply absent from it. Two things
follow from that:

  - A bucket ((app_id, year)) we DO revisit this run gets every one of its
    old pulse-tagged records dropped and replaced with the fresh live set,
    rather than only the ones whose id happens to still be live. That closes
    the partial case: one of two reports for the same game+year gets deleted,
    the bucket still gets touched because the other report is live, but the
    deleted one used to survive because it never matched an incoming id.
  - A bucket that had its LAST live row deleted disappears from `buckets`
    entirely and is never opened by the loop above, so nothing rewrites it.
    A tiny state file (`.pulse-touched-buckets.json` in data_output_path)
    tracks which (app_id, year) buckets currently carry live pulse data;
    any bucket that drops out between runs gets its year file opened once
    and stripped of pulse rows. This bounds the reconcile work to buckets
    that have ever actually had a pulse report, not every app dir on disk.
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

from .common import app_id_to_dir, is_valid_app_id, log, normalize_rating


SB_URL_DEFAULT = "https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1"
SB_ANON_KEY_DEFAULT = "sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V"


def _resolve_credentials() -> tuple[str, str]:
    """Allow overrides via env vars for staging / forks. Defaults to the prod project.

    Accept either the full REST base ('https://<proj>.supabase.co/rest/v1')
    or the bare project host ('https://<proj>.supabase.co'). CI secrets are
    sometimes set to the bare host, which produced '.../user_configs' urls
    that 404'd and quietly disabled the pulse merge for every scheduled
    run. Append /rest/v1 when it's missing so both forms work.
    """
    url = os.environ.get("SUPABASE_URL", SB_URL_DEFAULT).rstrip("/")
    if not url.endswith("/rest/v1"):
        url = f"{url}/rest/v1"
    key = os.environ.get("SUPABASE_ANON_KEY", SB_ANON_KEY_DEFAULT)
    return url, key


def fetch_pulse_rows(limit: int = 10000) -> list[dict[str, Any]]:
    """Pull all user_configs rows from Supabase via PostgREST.

    Raises on network / HTTP / parse failure so a broken SUPABASE_URL,
    down Supabase, or 4xx from an anon-key rotation FAILS THE PIPELINE
    instead of silently republishing search_index with tier='pending' on
    games that actually have submissions. Prior behaviour swallowed the
    exception and returned [], which produced weeks of stale search
    results before anyone noticed. See ~/.claude/rules/no-silent-failures.md.
    """
    base, key = _resolve_credentials()
    url = f"{base}/user_configs?select=*&order=created_at.desc&limit={limit}"
    req = urllib.request.Request(url, headers={"apikey": key, "Accept": "application/json"})
    try:
        # URL from hardcoded Supabase base + static REST path
        with urllib.request.urlopen(req, timeout=30) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as exc:
        log(f"[pulse] Failed to fetch user_configs from Supabase: {type(exc).__name__}: {exc}")
        raise

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
        # Supabase already stores ratings lowercase, but normalize on the way
        # in so future ingest sources (partner imports, plugin bugs, manual
        # backfills) can never smuggle a Capitalized rating past us (#427).
        "rating": normalize_rating(row.get("rating")),
        "duration": row.get("duration") or "",
        "durationMinutes": row.get("duration_minutes"),
        "notes": row.get("notes") or "",
        "launchOptions": row.get("launch_options") or "",
        "formResponses": row.get("form_responses"),
        "configKey": row.get("config_key"),
        "gameOwned": row.get("game_owned"),
        "ownerVerified": row.get("owner_verified"),
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


TOUCHED_BUCKETS_FILENAME = ".pulse-touched-buckets.json"


def _bucket_key(app_id: str, year: str) -> str:
    return f"{app_id}/{year}"


def _load_touched_buckets(state_path: Path) -> set[str]:
    if not state_path.exists():
        return set()
    try:
        data = json.loads(state_path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        log(f"[pulse] {state_path} unreadable, treating as empty: {exc}")
        return set()
    buckets = data.get("buckets") if isinstance(data, dict) else None
    return set(buckets) if isinstance(buckets, list) else set()


def _save_touched_buckets(state_path: Path, keys: set[str]) -> None:
    state_path.write_text(json.dumps({"buckets": sorted(keys)}, indent=2))


def _strip_pulse_rows(year_file: Path) -> bool:
    """Remove every source == 'pulse' record from a year file in place.

    Returns True if the file changed (and was rewritten). Used to reconcile
    a bucket whose last live pulse row was deleted since the prior run --
    it has dropped out of the current bucket set, so nothing else visits it.
    """
    if not year_file.exists():
        return False
    try:
        existing = json.loads(year_file.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        log(f"[pulse] {year_file} unreadable during reconcile, skipping: {exc}")
        return False
    if not isinstance(existing, list):
        return False
    filtered = [r for r in existing if not (isinstance(r, dict) and r.get("source") == "pulse")]
    if len(filtered) == len(existing):
        return False
    year_file.write_text(json.dumps(filtered, indent=2))
    return True


def merge_pulse_into_data_dir(data_output_path: Path) -> tuple[int, int]:
    """Pull Pulse reports from Supabase and merge them into the appropriate
    year.json files. Returns (apps_touched, reports_merged) for logging.

    Dedup by pulseId: every old pulse-tagged record in a touched bucket is
    dropped and replaced by the fresh Supabase set, so users can edit their
    submissions (or have one deleted) and have the static snapshot reflect
    the latest live state on the next pipeline run.
    """
    rows = fetch_pulse_rows()
    buckets = _bucket_by_app_year(rows) if rows else {}

    state_path = data_output_path / TOUCHED_BUCKETS_FILENAME
    prior_keys = _load_touched_buckets(state_path)
    current_keys = {_bucket_key(app_id, year) for app_id, year in buckets}

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

        # Drop every existing pulse-tagged record for this bucket -- pulse_reports
        # below is the complete, current, live set for this (app_id, year), so
        # keeping only ids that happen to match it would leave deleted rows
        # behind whenever another report for the same bucket is still live.
        filtered = [r for r in existing if not (isinstance(r, dict) and r.get("source") == "pulse")]

        # backfill source on legacy protondb records that haven't been re-tagged yet.
        # Also lowercase any surviving Capitalized rating so a merge touching this
        # year file heals it in place (#427). Cheap defensive rewrite, no schema change.
        for r in filtered:
            if isinstance(r, dict):
                if "source" not in r:
                    r["source"] = "protondb"
                if "rating" in r:
                    r["rating"] = normalize_rating(r.get("rating"))

        filtered.extend(pulse_reports)
        year_file.write_text(json.dumps(filtered, indent=2))

        apps_touched.add(app_id)
        reports_merged += len(pulse_reports)

    # Reconcile buckets whose last live row was deleted since the prior run
    # (#476): they've dropped out of `buckets` entirely, so the loop above
    # never opens their year file. Bounded to buckets that have ever held a
    # live pulse row, via the state file, rather than every app dir on disk.
    reconciled = 0
    for key in prior_keys - current_keys:
        app_id, _, year = key.rpartition("/")
        year_file = data_output_path / app_id_to_dir(app_id) / f"{year}.json"
        if _strip_pulse_rows(year_file):
            reconciled += 1

    state_path.parent.mkdir(parents=True, exist_ok=True)
    _save_touched_buckets(state_path, current_keys)

    if not rows:
        log("[pulse] No Pulse reports to merge (Supabase returned 0 rows)")
    log(
        f"[pulse] Merged {reports_merged} Pulse report(s) across {len(apps_touched)} app(s)"
        + (f"; reconciled {reconciled} bucket(s) with no remaining live rows" if reconciled else "")
    )
    return len(apps_touched), reports_merged
