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
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Iterable

from .common import log

# Column mapping from search-index.json row shape to Postgres columns.
# Search-index row: [appId, title, tier, protondbCount, pulseCount,
#                    source, releaseYear, delisted, adult, trend,
#                    replacedBy, steamType, ac_status, ac_vendors,
#                    pgw_os, pgw_engine, vr]
# Postgres columns tracked here mirror the search_index migration; extras
# (ac_status, ac_vendors, pgw_os, pgw_engine) stay out of FTS since search
# doesn't need to match on them. vr IS synced (#246) because the VR filter
# runs server-side in the search-games edge fn like store / adult / delisted,
# rather than client-side over the blob.
COLUMNS = (
    "app_id", "title", "tier", "source",
    "protondb_count", "pulse_count", "release_year",
    "delisted", "adult", "replaced_by", "steam_type", "trend", "vr",
)

DEFAULT_URL = "https://ilsgdshkaocrmibwdezk.supabase.co"
DEFAULT_BATCH = 500

# Valid store sources -- rows with any other source (empty, None, garbage)
# are skipped to keep the API's `store` filter well-defined.
VALID_SOURCES = frozenset(("steam", "gog", "epic", "pgwiki"))

# PostgREST answers at most max_rows (1000 on this project) per request no
# matter what `limit` asks for, so the existing-id listing pages by app_id.
LIST_PAGE_SIZE = 1000

# The stale delete refuses to run when the live index is smaller than this.
# The primary index is ~48k rows; a run that produced a few hundred is broken
# upstream, and mirroring it would empty the search API.
MIN_LIVE_ROWS = 10_000

# A source with at least this many rows in Postgres and none in the live
# index has dropped out (an upstream outage, like PCGW in #497), not shrunk.
# Its rows are kept until the source comes back.
MIN_SOURCE_ROWS = 100


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
        # Constrained to 'supported' / 'only' by search_index_vr_chk -- drop
        # anything else rather than failing the whole batch upsert on one bad
        # row from a hand-edited index.
        "vr": _vr(row[16] if len(row) > 16 else None),
    }


def _vr(value) -> str | None:
    """Coerce the search-index VR column to the DB CHECK vocabulary."""
    text = str(value or "").strip().lower()
    return text if text in ("supported", "only") else None


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


def _list_existing(url: str, key: str, timeout: int = 60) -> dict[str, str]:
    """Every row in Postgres search_index as {app_id: source}.

    Keyset-paged on app_id because PostgREST caps each response at max_rows.
    The old single `limit=200000` request silently got 1000 rows back, so the
    stale diff only ever saw 1% of the table and deleted nothing (#578).
    Raises on network, HTTP or parse errors.
    """
    out: dict[str, str] = {}
    last: str | None = None
    while True:
        query = f"select=app_id,source&order=app_id.asc&limit={LIST_PAGE_SIZE}"
        if last is not None:
            query += f"&app_id=gt.{urllib.parse.quote(last, safe='')}"
        req = urllib.request.Request(f"{url}/rest/v1/search_index?{query}", headers={
            "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            page = json.loads(resp.read())
        if not isinstance(page, list):
            raise ValueError(f"search_index listing returned {type(page).__name__}, expected a list")
        for r in page:
            if isinstance(r, dict) and r.get("app_id"):
                out[str(r["app_id"])] = str(r.get("source") or "")
        if len(page) < LIST_PAGE_SIZE:
            return out
        last = str(page[-1]["app_id"])


def _delete_stale(url: str, key: str, live: dict[str, str], timeout: int = 60) -> int:
    """Delete rows in Postgres that are no longer in the static index.

    `live` maps each app_id in search-index.json to its source. Only app_ids
    are compared; values are always re-upserted so drift on other columns
    self-heals. Two guards keep a broken upstream from being mirrored:
    nothing is deleted when the live index is below MIN_LIVE_ROWS, and a
    source that vanished entirely (see MIN_SOURCE_ROWS) keeps its rows.
    Returns the number of rows deleted. Raises on network / HTTP errors.
    """
    if len(live) < MIN_LIVE_ROWS:
        log(f"[sync-search-index] ERROR: live index has only {len(live)} rows "
            f"(< {MIN_LIVE_ROWS}); refusing the stale delete")
        return 0

    existing = _list_existing(url, key, timeout=timeout)
    live_by_source = Counter(live.values())
    existing_by_source = Counter(existing.values())
    dropped_sources = sorted(
        src for src, n in existing_by_source.items()
        if n >= MIN_SOURCE_ROWS and live_by_source.get(src, 0) == 0
    )
    for src in dropped_sources:
        log(f"[sync-search-index] ERROR: source {src!r} has {existing_by_source[src]} rows in "
            f"Postgres and none in search-index.json; keeping them (upstream outage?)")

    stale = sorted(
        app_id for app_id, src in existing.items()
        if app_id not in live and src not in dropped_sources
    )
    log(f"[sync-search-index] stale check: {len(existing)} rows in Postgres, {len(live)} live, "
        f"{len(stale)} to delete, by source {dict(Counter(existing[i] for i in stale))}")
    deleted = 0
    for chunk in _batched(stale, 200):
        # app_ids are alphanumeric plus `:` and `_` (steam/gog/epic/pw_), so
        # the quoted PostgREST list form is safe.
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
    live = {r["app_id"]: r["source"] for r in payload}
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
        deleted = _delete_stale(sb_url, sb_key, live)
        log(f"[sync-search-index] deleted {deleted} stale rows no longer in search-index.json")
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        log(f"[sync-search-index] ERROR: stale delete failed ({type(exc).__name__}: {exc}); "
            f"rows dropped from the index stay searchable until the next run")
