"""Sync search-index.json to the Supabase `search_index` table (#434).

Runs at the tail end of scripts/pipeline/finalize.py so the API-backed
search endpoint (supabase/functions/search-games/) has fresh data.
Batched upsert via PostgREST with `Prefer: resolution=merge-duplicates`
so rows added, deleted, or edited by the pipeline propagate on the
next run without a manual reset.

The static search-index.json stays as the source of truth for gh-pages
fallback / archive; this module treats it as an authoritative snapshot
and mirrors it into the DB. No two-way merge -- the pipeline is the
only writer.

Env:
  SUPABASE_URL              (default: prod host)
  SUPABASE_SERVICE_KEY      required
  SEARCH_INDEX_SYNC_BATCH   optional, default 500

Non-blocking failure: if the sync errors (network, RLS, auth), we log
and continue so a Supabase outage never blocks a pipeline deploy.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable

from .common import log

# Column mapping from search-index.json row shape to Postgres columns.
# Search-index row: [appId, title, tier, protondbCount, pulseCount,
#                    source, releaseYear, delisted, adult, trend,
#                    replacedBy, steamType, ac_status, ac_vendors,
#                    pgw_os, pgw_engine]
# Postgres columns tracked here mirror the search_index migration; extras
# (ac_status, ac_vendors, pgw_os, pgw_engine) stay out of FTS since search
# doesn't need to match on them.
COLUMNS = (
    "app_id", "title", "tier", "source",
    "protondb_count", "pulse_count", "release_year",
    "delisted", "adult", "replaced_by", "steam_type", "trend",
)

DEFAULT_URL = "https://ilsgdshkaocrmibwdezk.supabase.co"
DEFAULT_BATCH = 500

# Valid store sources -- rows with any other source (empty, None, garbage)
# are skipped to keep the API's `store` filter well-defined.
VALID_SOURCES = frozenset(("steam", "gog", "epic", "pgwiki"))


def _row_to_dict(row: list) -> dict | None:
    """Coerce a search-index row into an INSERT-shaped dict.

    Returns None for malformed rows so the caller skips them. Enforces
    the small set of NOT NULL contracts (app_id, title, source) that
    the migration sets.
    """
    if not isinstance(row, list) or len(row) < 6:
        return None
    app_id = str(row[0] or "").strip()
    title = str(row[1] or "").strip()
    source = str(row[5] or "").strip().lower()
    if not app_id or not title or source not in VALID_SOURCES:
        return None
    def _int(v):
        try:
            return int(v) if v is not None else 0
        except (TypeError, ValueError):
            return 0
    def _year(v):
        try:
            n = int(v)
            return n if 1980 <= n <= 2100 else None
        except (TypeError, ValueError):
            return None
    return {
        "app_id": app_id,
        "title": title[:500],  # sanity cap; Postgres text has no length limit but truncate
        "tier": (str(row[2] or "pending") or "pending")[:32],
        "source": source,
        "protondb_count": _int(row[3]),
        "pulse_count": _int(row[4]),
        "release_year": _year(row[6] if len(row) > 6 else None),
        "delisted": bool(row[7]) if len(row) > 7 and row[7] is True else False,
        "adult": bool(row[8]) if len(row) > 8 and row[8] is True else False,
        "trend": (str(row[9] or "") or None) if len(row) > 9 else None,
        "replaced_by": (str(row[10] or "") or None) if len(row) > 10 else None,
        "steam_type": (str(row[11] or "") or None) if len(row) > 11 else None,
    }


def _batched(seq: list, size: int) -> Iterable[list]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _post_batch(url: str, key: str, batch: list[dict], timeout: int = 60) -> None:
    """POST one batch with merge-duplicates so re-runs update in place."""
    body = json.dumps(batch).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/search_index?on_conflict=app_id",
        data=body,
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        if resp.status >= 400:
            raise urllib.error.HTTPError(url, resp.status, resp.reason, resp.headers, None)


def _delete_stale(url: str, key: str, live_ids: set[str], timeout: int = 60) -> int:
    """Delete rows in Postgres that are no longer present in the static
    index (pipeline dropped them). Only compares app_id -- values are
    always re-upserted so drift on other columns self-heals.

    PostgREST-side we could use `id=not.in.(...)` but the URL-length cap
    (~8k) makes that impractical at 100k rows. Instead: fetch existing
    app_ids in one shot (compact, ~2MB text response for 100k rows), diff
    in memory, then delete the missing ones in batches.
    """
    list_url = f"{url}/rest/v1/search_index?select=app_id&limit=200000"
    req = urllib.request.Request(list_url, headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        existing = json.loads(resp.read())
    existing_ids = {r["app_id"] for r in existing if isinstance(r, dict)}
    stale = existing_ids - live_ids
    if not stale:
        return 0
    # Delete in batches. `id=in.(a,b,c,...)` supports up to ~2000 ids per
    # request comfortably under the URL cap.
    deleted = 0
    stale_list = sorted(stale)
    for chunk in _batched(stale_list, 200):
        # Escape ids as PostgREST list format; app_ids are safe alphanumeric +
        # `:` and `_` (steam/gog/epic/pw_ prefixed).
        ids_csv = ",".join(f'"{sid}"' for sid in chunk)
        del_url = f"{url}/rest/v1/search_index?app_id=in.({ids_csv})"
        req = urllib.request.Request(del_url, method="DELETE", headers={
            "apikey": key, "Authorization": f"Bearer {key}",
            "Prefer": "return=minimal",
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            if resp.status >= 400:
                raise urllib.error.HTTPError(del_url, resp.status, resp.reason, resp.headers, None)
        deleted += len(chunk)
    return deleted


def sync_search_index(output_dir: Path) -> None:
    """Sync search-index.json into the Postgres search_index table.

    Reads the static file, coerces each row into the DB shape, batched-
    upserts them, then diff-deletes anything the pipeline dropped. Any
    single failure logs and returns -- the pipeline's other deliverables
    are unaffected.
    """
    output_dir = Path(output_dir)
    idx_path = output_dir / "search-index.json"
    if not idx_path.exists():
        log("[sync-search-index] search-index.json missing, skipping")
        return

    sb_url = os.environ.get("SUPABASE_URL", DEFAULT_URL).rstrip("/")
    sb_key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not sb_key:
        log("[sync-search-index] SUPABASE_SERVICE_KEY not set, skipping (search API will use last-synced data)")
        return

    try:
        rows = json.loads(idx_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[sync-search-index] failed to read search-index.json: {exc}")
        return
    if not isinstance(rows, list):
        log(f"[sync-search-index] search-index.json is not a list, skipping")
        return

    batch_size = max(50, int(os.environ.get("SEARCH_INDEX_SYNC_BATCH", DEFAULT_BATCH)))
    payload = []
    skipped = 0
    for row in rows:
        coerced = _row_to_dict(row)
        if coerced is None:
            skipped += 1
            continue
        payload.append(coerced)
    live_ids = {r["app_id"] for r in payload}
    log(f"[sync-search-index] read {len(rows)} rows, {len(payload)} eligible for upsert, skipped {skipped}")

    started = time.time()
    upserted = 0
    for batch in _batched(payload, batch_size):
        try:
            _post_batch(sb_url, sb_key, batch)
            upserted += len(batch)
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                pass
            log(f"[sync-search-index] batch upsert failed HTTP {exc.code}: {body}")
            return
        except Exception as exc:
            log(f"[sync-search-index] batch upsert failed: {exc}")
            return

    log(f"[sync-search-index] upserted {upserted}/{len(payload)} rows in {time.time() - started:.1f}s")

    try:
        deleted = _delete_stale(sb_url, sb_key, live_ids)
        if deleted:
            log(f"[sync-search-index] deleted {deleted} stale rows no longer in search-index.json")
    except Exception as exc:
        log(f"[sync-search-index] stale delete failed (non-fatal): {exc}")
