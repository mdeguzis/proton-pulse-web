"""Enrich search-index.json with PCGamingWiki metadata (#377 slice 1).

Data source: PCGamingWiki Cargo API. One paginated query against the
`Infobox_game` cargo table gives us everything we need per game:

    Steam_AppID  -> {os: ["windows", "linux", ...], engine: "Unreal Engine 4"}

Real Cargo field names (verified against the live schema, not the
public docs which drift):
  - `Steam_AppID` is a virtual list field. Bulk-filter with the
    reified `Steam_AppID__full` scalar; per-row payloads still contain
    the comma-separated list.
  - `Available_on` is a scalar comma-list of OS names ("Windows,OS X,Linux,DOS").
  - `Engines` is a scalar comma-list prefixed with the wiki namespace
    ("Engine:Source,Engine:Unity"). We strip the "Engine:" prefix on
    read and keep the first entry.
  - `_pageName` cannot be projected under its raw name -- Cargo rejects
    field aliases that start with underscore -- so we alias every field.

Cached to `pcgamingwiki-cache.json` on disk with a weekly TTL; a
network / API failure falls back to the on-disk cache so a broken
PCGW day never wipes the enrichment.

Columns written to search-index rows:
    col 14: pgw_os     -- lowercased list of natively-supported OS names
                          ("windows", "linux", "os x", "dos"). None when
                          no PGWiki OS entry exists for the game.
    col 15: pgw_engine -- engine name string or None.

Both default to None for apps not in the cache. Rows are padded so col 14
and 15 land at the expected index regardless of what earlier enrichers
wrote at 6, 7, 10, 11, 12, or 13.

License: PCGamingWiki content is CC BY-NC-SA 3.0. Any user-facing surface
that shows this data needs an attribution link back to the source page.
Attribution boilerplate lives in `proton-pulse-web-wiki/Data-Pipeline.md`.
"""
from __future__ import annotations

import json
import os as _os
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .common import log

# Cargo endpoint. Every request must carry a descriptive User-Agent per
# MediaWiki API etiquette or PCGW may 403. See:
# https://www.pcgamingwiki.com/wiki/PCGamingWiki:API
CARGO_URL = "https://www.pcgamingwiki.com/w/api.php"
USER_AGENT = "proton-pulse-web/pipeline (+https://www.proton-pulse.com)"

CACHE_FILENAME = "pcgamingwiki-cache.json"

# Fresh cadence: weekly. PCGW is community-edited and moves slowly enough
# that a daily fetch wastes their capacity for zero benefit.
FRESH_TTL_SEC = 7 * 24 * 3600

# Cargo pagination. 500 is the documented max per call. Sleep between
# pages keeps us well under any per-IP throttle.
CARGO_LIMIT = 500
CARGO_DELAY_SEC = 0.4
CARGO_TIMEOUT = 20

# Safety cap: if pagination ever loops or PCGW returns unbounded rows,
# stop rather than burn the CI budget. ~50k games with Steam IDs is
# comfortably above the current catalog.
MAX_PAGES = 200

# Overridable via env so a manual dispatch can force a fresh fetch even
# when the on-disk cache is still within its TTL.
FORCE_REFRESH = _os.environ.get("PCGAMINGWIKI_FORCE_REFRESH", "").lower() in ("1", "true", "yes")

# Whitelist of OS strings we accept from PCGW's `Available_on` field.
# Anything else gets dropped so an unexpected value ("Web" experimentation,
# console ports) does not surface in the frontend without a schema review.
_VALID_OS = {"windows", "os x", "linux", "dos"}

# Field alias map used in every Cargo query. Aliases MUST NOT start with
# underscore -- Cargo's `cargoquery-invalidfieldalias` error blocks that.
_CARGO_FIELDS = "_pageName=page,Steam_AppID=appId,Engines=engines,Available_on=available"

# Bulk WHERE clause: virtual list fields need the reified `__full` suffix.
_CARGO_WHERE_BULK = "Steam_AppID__full IS NOT NULL AND Steam_AppID__full != ''"

# Namespace prefix stripped from every engine value ("Engine:Unity" -> "Unity").
_ENGINE_NAMESPACE_PREFIX = "Engine:"


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
        log(f"[pcgamingwiki] WARN: could not read cache: {exc}")
        return {"fetched_at": 0, "by_appid": {}}


def _save_cache(cache_path: Path, cache: dict) -> None:
    cache_path.write_text(json.dumps(cache, sort_keys=True), encoding="utf-8")


def _cargo_get(params: dict) -> dict | None:
    """One-shot Cargo API GET. Returns the parsed JSON dict on success, None
    on any transport / parse failure. Enforces https:// on the endpoint so a
    future edit that swaps CARGO_URL for a caller-supplied value cannot smuggle
    a file:// URL through urlopen.
    """
    if not CARGO_URL.startswith("https://"):
        log("[pcgamingwiki] WARN: CARGO_URL scheme is not https:// -- refusing to fetch")
        return None
    qs = urllib.parse.urlencode(params)
    url = f"{CARGO_URL}?{qs}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=CARGO_TIMEOUT) as resp:  # nosec B310  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected - URL is the fixed CARGO_URL constant with querystring params interpolated
            body = resp.read().decode("utf-8")
    except Exception as exc:
        log(f"[pcgamingwiki] WARN: cargo fetch failed: {exc}")
        return None
    try:
        data = json.loads(body)
    except Exception as exc:
        log(f"[pcgamingwiki] WARN: cargo JSON parse failed: {exc}")
        return None
    if not isinstance(data, dict):
        return None
    return data


def _paginate_cargo(tables: str, fields: str, where: str) -> list[dict]:
    """Walk every page of a Cargo query. Returns the flattened row list."""
    out: list[dict] = []
    for page in range(MAX_PAGES):
        payload = _cargo_get({
            "action": "cargoquery",
            "format": "json",
            "tables": tables,
            "fields": fields,
            "where": where,
            "limit": CARGO_LIMIT,
            "offset": page * CARGO_LIMIT,
        })
        if payload is None:
            log(f"[pcgamingwiki] pagination stopped at page {page} (network error)")
            return out
        rows = payload.get("cargoquery") or []
        if not isinstance(rows, list) or not rows:
            return out
        # Cargo wraps each row's fields under a "title" key. Unwrap so
        # downstream code sees a flat dict per row.
        for row in rows:
            if isinstance(row, dict):
                title = row.get("title")
                if isinstance(title, dict):
                    out.append(title)
        if len(rows) < CARGO_LIMIT:
            return out
        time.sleep(CARGO_DELAY_SEC)
    log(f"[pcgamingwiki] hit MAX_PAGES ({MAX_PAGES}); truncating")
    return out


def _fetch_infobox_rows() -> list[dict] | None:
    """Fetch every Infobox_game row that has a Steam_AppID.

    Returns unwrapped title dicts with keys: page, appId, engines, available.
    Returns None if the very first page fails so refresh_cache can fall
    back to the on-disk cache without partial merging.
    """
    payload = _cargo_get({
        "action": "cargoquery",
        "format": "json",
        "tables": "Infobox_game",
        "fields": _CARGO_FIELDS,
        "where": _CARGO_WHERE_BULK,
        "limit": CARGO_LIMIT,
        "offset": 0,
    })
    if payload is None:
        return None
    rows: list[dict] = []
    first = payload.get("cargoquery") or []
    for row in first:
        if isinstance(row, dict):
            title = row.get("title")
            if isinstance(title, dict):
                rows.append(title)
    if len(first) < CARGO_LIMIT:
        return rows
    # Continue paginating past the first page.
    tail = _paginate_cargo(
        tables="Infobox_game",
        fields=_CARGO_FIELDS,
        where=_CARGO_WHERE_BULK,
    )
    # `_paginate_cargo` restarts at page 0. Skip the first page's worth of
    # rows to avoid double-counting.
    return rows + tail[CARGO_LIMIT:]


def _index_by_appid(infobox_rows: list[dict]) -> dict[str, dict]:
    """Build `{steam_appid: {os, engine}}` from the Cargo title rows.

    Bundles (multiple appids per PCGW page) fan out: every listed appid
    inherits the page's OS + engine so a wishlist search by any of them
    lands on the enrichment. Rows carrying neither OS nor engine are
    dropped so the cache does not bloat with dead entries.
    """
    out: dict[str, dict] = {}
    for row in infobox_rows:
        if not isinstance(row, dict):
            continue
        page = str(row.get("page") or "").strip()
        steam_field = str(row.get("appId") or "").strip()
        if not page or not steam_field:
            continue
        engine = _first_engine(row.get("engines"))
        os_names = _parse_available_on(row.get("available"))
        if not os_names and not engine:
            continue
        entry = {"os": os_names, "engine": engine}
        for appid in _all_numeric(steam_field):
            # First-writer-wins so a duplicate appid across pages does not
            # thrash. In practice bundles overlap rarely.
            out.setdefault(appid, entry)
    return out


def _parse_available_on(field) -> list[str]:
    """Parse `Available_on` ("Windows,OS X,Linux") into a sorted lowercase list.

    Filters to `_VALID_OS` so an unexpected value ("Web") does not surface
    without a schema review.
    """
    if not field:
        return []
    seen: set[str] = set()
    for token in str(field).split(","):
        name = token.strip().lower()
        if name in _VALID_OS:
            seen.add(name)
    return sorted(seen)


def _first_numeric(field: str) -> str | None:
    """Extract the first digits-only token from a comma / whitespace list."""
    for token in _all_numeric(field):
        return token
    return None


def _all_numeric(field: str) -> list[str]:
    """Extract every digits-only token from a comma / semicolon list. Used
    for PCGW pages with multiple Steam_AppIDs -- each numeric token maps
    back to a real appid we want to enrich.
    """
    if not field:
        return []
    out: list[str] = []
    for token in str(field).replace(";", ",").split(","):
        stripped = token.strip()
        if stripped.isdigit() and stripped not in out:
            out.append(stripped)
    return out


def _first_engine(field) -> str | None:
    """PCGW ships engines as `Engine:Source,Engine:Unity`. Strip the wiki
    namespace prefix and keep the first non-empty entry. Empty / non-string
    values -> None.
    """
    if not field:
        return None
    text = str(field).strip()
    if not text:
        return None
    for token in text.split(","):
        name = token.strip()
        if name.startswith(_ENGINE_NAMESPACE_PREFIX):
            name = name[len(_ENGINE_NAMESPACE_PREFIX):].strip()
        if name:
            return name
    return None


def refresh_cache(output_dir: Path, force: bool = False) -> dict[str, dict]:
    """Load or refresh the PCGW cache. Returns `{appid: {os, engine}}`.

    Refreshes when the cache is missing, stale, or `force` (or the
    PCGAMINGWIKI_FORCE_REFRESH env var). Falls back to the on-disk cache
    when the network is down so a broken PCGW day never wipes the
    enrichment.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    now = int(time.time())
    fresh_enough = (now - int(cache.get("fetched_at") or 0)) < FRESH_TTL_SEC
    if fresh_enough and not (force or FORCE_REFRESH) and cache.get("by_appid"):
        log(
            f"[pcgamingwiki] cache hit ({len(cache['by_appid'])} apps, "
            f"age {now - int(cache['fetched_at'])}s)"
        )
        return cache["by_appid"]

    log("[pcgamingwiki] refreshing from cargo API")
    infobox = _fetch_infobox_rows()
    if infobox is None:
        log(f"[pcgamingwiki] cargo unreachable; using {len(cache['by_appid'])} cached rows")
        return cache["by_appid"]

    by_appid = _index_by_appid(infobox)
    cache = {
        "fetched_at": now,
        "by_appid": by_appid,
    }
    _save_cache(cache_path, cache)
    log(f"[pcgamingwiki] cached {len(by_appid)} apps (of {len(infobox)} infobox rows)")
    return by_appid


def enrich_search_index_with_pcgamingwiki(output_dir: Path) -> None:
    """Merge PCGW OS + engine into search-index cols 14 + 15.

    Pads shorter rows with None so both columns land at the expected
    index regardless of what upstream enrichers wrote. Rows without a
    cache hit get None in both slots so the frontend can distinguish
    "no PCGW data" from "runs on nothing but Windows".
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[pcgamingwiki] search-index.json missing, skipping enrichment")
        return

    try:
        entries = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[pcgamingwiki] WARN: could not read search-index.json: {exc}")
        return
    if not isinstance(entries, list) or not entries:
        return

    by_appid = refresh_cache(output_dir)

    hits = 0
    for row in entries:
        if not isinstance(row, list) or not row:
            continue
        # Pad to at least 16 columns so cols 14 + 15 land at the right index
        # without disturbing cols 10-13 (owned by other enrichers).
        while len(row) < 16:
            row.append(None)
        app_id = str(row[0])
        info = by_appid.get(app_id)
        if info:
            row[14] = info["os"] or None
            row[15] = info["engine"] or None
            hits += 1

    index_path.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
    log(f"[pcgamingwiki] enriched {hits}/{len(entries)} search-index rows")

    # Also publish the full mapping so the plugin / other clients can consume
    # per-app deep dives without re-reading search-index.
    published = output_dir / "pcgamingwiki.json"
    published.write_text(json.dumps(by_appid, separators=(",", ":")), encoding="utf-8")
