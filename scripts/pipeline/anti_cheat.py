"""Enrich search-index.json with anti-cheat status per Steam app (#242).

Data source: AreWeAntiCheatYet/AreWeAntiCheatYet on GitHub. Their `games.json`
publishes one row per game with:
    - status: "Supported" | "Running" | "Broken" | "Denied" | "Planned"
    - anticheats: ["Easy Anti-Cheat", "BattlEye", "VAC", ...]
    - storeIds.steam: numeric Steam app id (present on ~60% of rows)

We fetch nightly, index by Steam appid, and cache to disk. The enricher
maps each cache hit into two columns on search-index rows:

    col 10 (index 10): ac_status -- one of the enum values above, lowercased.
    col 11 (index 11): ac_vendors -- list of anti-cheat vendor strings.

Both default to None for apps not in the cache. Older frontend consumers
that only read columns 0..9 keep working (JS destructuring ignores extras).

License: AreWeAntiCheatYet ships CC-BY. Attribution lives in
proton-pulse-web-wiki/Data-Pipeline.md.
"""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

from .common import log

# Canonical upstream. HEAD branch (main) is stable + the maintainers
# publish `games.json` as the release artifact.
UPSTREAM_URL = (
    "https://raw.githubusercontent.com/AreWeAntiCheatYet/AreWeAntiCheatYet/HEAD/games.json"
)

CACHE_FILENAME = "anti-cheat-cache.json"

# Fresh fetch cadence. Twice a day is plenty -- the upstream repo does not
# update more often than that in practice. Cache file records the fetch
# timestamp so a re-run within the window skips the HTTP call.
FRESH_TTL_SEC = 12 * 3600

# Statuses upstream uses today. Lowercased on write so the frontend does
# not have to case-normalize on every filter check.
_VALID_STATUSES = {"supported", "running", "broken", "denied", "planned"}


def _load_cache(cache_path: Path) -> dict:
    if not cache_path.exists():
        return {"fetched_at": 0, "by_appid": {}}
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"fetched_at": 0, "by_appid": {}}
        data.setdefault("fetched_at", 0)
        data.setdefault("by_appid", {})
        return data
    except Exception as exc:
        log(f"[anti-cheat] WARN: could not read cache: {exc}")
        return {"fetched_at": 0, "by_appid": {}}


def _save_cache(cache_path: Path, cache: dict) -> None:
    cache_path.write_text(json.dumps(cache, sort_keys=True), encoding="utf-8")


def _fetch_upstream(timeout: int = 20) -> list | None:
    """Download the AreWeAntiCheatYet games.json. Returns None on failure."""
    req = urllib.request.Request(UPSTREAM_URL, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except Exception as exc:
        log(f"[anti-cheat] WARN: upstream fetch failed: {exc}")
        return None
    try:
        data = json.loads(body)
    except Exception as exc:
        log(f"[anti-cheat] WARN: upstream JSON parse failed: {exc}")
        return None
    if not isinstance(data, list):
        log(f"[anti-cheat] WARN: upstream returned non-list ({type(data).__name__})")
        return None
    return data


def _index_by_appid(rows: list) -> dict[str, dict]:
    """Build {steam_appid: {status, vendors}} from the upstream rows.

    Skips entries without a Steam appid or with an unknown status so the
    cache only contains data we can actually surface.
    """
    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        store_ids = row.get("storeIds") or {}
        steam_id = store_ids.get("steam") if isinstance(store_ids, dict) else None
        if not steam_id:
            continue
        status = (row.get("status") or "").strip().lower()
        if status not in _VALID_STATUSES:
            continue
        vendors = row.get("anticheats") or []
        if not isinstance(vendors, list):
            vendors = []
        # Sanitize vendors -- upstream sometimes ships stray whitespace / dupes.
        vendors = sorted({str(v).strip() for v in vendors if str(v).strip()})
        out[str(steam_id)] = {"status": status, "vendors": vendors}
    return out


def refresh_cache(output_dir: Path, force: bool = False) -> dict[str, dict]:
    """Load or refresh the anti-cheat cache. Returns {appid: {status, vendors}}.

    Refreshes when the cache is missing, stale (> FRESH_TTL_SEC), or `force`.
    Falls back to the on-disk cache when the network is down so a broken
    upstream never wipes the enrichment.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    now = int(time.time())
    fresh_enough = (now - int(cache.get("fetched_at") or 0)) < FRESH_TTL_SEC
    if fresh_enough and not force and cache.get("by_appid"):
        log(
            f"[anti-cheat] cache hit ({len(cache['by_appid'])} apps, "
            f"age {now - int(cache['fetched_at'])}s)"
        )
        return cache["by_appid"]

    log("[anti-cheat] refreshing from upstream")
    upstream = _fetch_upstream()
    if upstream is None:
        # Network / parse failure. Fall back to whatever we already have on disk.
        log(f"[anti-cheat] upstream unreachable; using {len(cache['by_appid'])} cached rows")
        return cache["by_appid"]

    by_appid = _index_by_appid(upstream)
    cache = {"fetched_at": now, "by_appid": by_appid}
    _save_cache(cache_path, cache)
    log(f"[anti-cheat] cached {len(by_appid)} apps with Steam ids")
    return by_appid


def enrich_search_index_with_anti_cheat(output_dir: Path) -> None:
    """Merge anti-cheat status + vendors into search-index columns 10 + 11.

    Pads shorter rows with None so both columns land at the expected index
    regardless of what upstream enrichers wrote. Rows without a cache hit
    get None in both slots so the frontend can distinguish "no anti-cheat
    data" from "no anti-cheat".
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[anti-cheat] search-index.json missing, skipping enrichment")
        return

    try:
        entries = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[anti-cheat] WARN: could not read search-index.json: {exc}")
        return
    if not isinstance(entries, list) or not entries:
        return

    by_appid = refresh_cache(output_dir)

    hits = 0
    for row in entries:
        if not isinstance(row, list) or not row:
            continue
        # Pad to at least 12 columns so col 10 + 11 land at the right index.
        while len(row) < 12:
            row.append(None)
        app_id = str(row[0])
        info = by_appid.get(app_id)
        if info:
            row[10] = info["status"]
            row[11] = info["vendors"] or None
            hits += 1
        else:
            # Keep any previous value if a prior enricher already wrote here
            # (defensive: no other enricher owns these columns today).
            if row[10] is None:
                row[10] = None
            if row[11] is None:
                row[11] = None

    index_path.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
    log(f"[anti-cheat] enriched {hits}/{len(entries)} search-index rows")

    # Also publish data/anti-cheat.json so the plugin (and any other client)
    # can consume the full mapping directly. Frontend uses search-index for
    # the filter chip; this mirror is for per-app deep dives.
    published = output_dir / "anti-cheat.json"
    published.write_text(json.dumps(by_appid, separators=(",", ":")), encoding="utf-8")
