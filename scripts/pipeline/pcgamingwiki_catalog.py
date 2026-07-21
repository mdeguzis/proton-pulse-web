"""Emit PCGamingWiki-only catalog entries (#377 slice 3).

Slice 1 enriched existing Steam entries with PCGW metadata. This pass goes
the other direction: it fetches PCGamingWiki games that have NO Steam or
GOG ID and are playable on Windows (so Proton can run them), then merges
them into `search-index.json` as new rows keyed by `pgwiki:<slug>`.

The result: abandonware and old classics with a PCGamingWiki page (e.g.
The Chronicles of Riddick: Escape from Butcher Bay) get a stub game page
in Proton Pulse so users can submit compat reports against them.

Query criteria (Infobox_game):
  Steam_AppID__full IS NULL OR '' -- not on Steam
  GOGcom_ID__full   IS NULL OR '' -- not on GOG
  Available_on HOLDS "Windows"    -- has a Windows build (Proton runs it)

Excluded on purpose: DOS-only entries. Proton does not play DOS games,
so those would just clutter the catalog. Adding them is out of scope
for this slice; a future slice can add DOSBox-flagged entries if needed.

Emits:
  pcgwiki-catalog.json  { "pgwiki:<slug>": {
                              name, engine, developers[], publishers[],
                              release_year, wiki_url } }
  Merged into search-index.json as new rows:
    [ "pgwiki:<slug>",  # col 0: canonical id
      <title>,          # col 1: game title
      "pending",        # col 2: tier (no ProtonDB verdict)
      0,                # col 3: protondb report count
      0,                # col 4: pulse report count
      "pgwiki",         # col 5: source
      <release year>,   # col 6
      None,             # col 7: delisted
      False,            # col 8: adult
      "",               # col 9: trend
      None,             # col 10: replaced_by
      None,             # col 11: steam_type
      None,             # col 12: ac_status
      None,             # col 13: ac_vendors
      ["windows"],      # col 14: pgw_os (always at least windows here)
      <engine>,         # col 15: pgw_engine
    ]

License: PCGamingWiki content is CC BY-NC-SA 3.0. The wiki_url points
back to the source page from every rendered stub.
"""
from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .common import log
from .pcgamingwiki import (
    CARGO_DELAY_SEC,
    CARGO_LIMIT,
    CARGO_TIMEOUT,
    CARGO_URL,
    MAX_PAGES,
    USER_AGENT,
    _first_engine,
    _parse_available_on,
)

CACHE_FILENAME = "pcgwiki-catalog-cache.json"
OUTPUT_FILENAME = "pcgwiki-catalog.json"

# Weekly refresh matches the metadata enricher. PCGW catalog changes slowly.
FRESH_TTL_SEC = 7 * 24 * 3600

# Query shape. Field aliases must NOT start with underscore (Cargo blocks it).
_CARGO_FIELDS = ",".join([
    "_pageName=page",
    "Steam_AppID=appId",
    "GOGcom_ID=gogId",
    "Engines=engines",
    "Available_on=available",
    "Released_Windows=relWin",
    "Developers=developers",
    "Publishers=publishers",
])

# Virtual list fields need the reified `__full` companion for bulk WHERE.
_CARGO_WHERE = (
    "(Steam_AppID__full IS NULL OR Steam_AppID__full = '')"
    " AND (GOGcom_ID__full IS NULL OR GOGcom_ID__full = '')"
    " AND Available_on HOLDS \"Windows\""
)

# Match the enricher's namespace strip for the Company / Engine prefixes.
_COMPANY_NAMESPACE_PREFIX = "Company:"
_ENGINE_NAMESPACE_PREFIX = "Engine:"


def _load_cache(cache_path: Path) -> dict:
    if not cache_path.exists():
        return {"fetched_at": 0, "entries": {}}
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"fetched_at": 0, "entries": {}}
        data.setdefault("fetched_at", 0)
        data.setdefault("entries", {})
        return data
    except Exception as exc:
        log(f"[pcgwiki-catalog] WARN: could not read cache: {exc}")
        return {"fetched_at": 0, "entries": {}}


def _save_cache(cache_path: Path, cache: dict) -> None:
    cache_path.write_text(json.dumps(cache, sort_keys=True), encoding="utf-8")


def _cargo_get(params: dict) -> dict | None:
    """One-shot Cargo GET. Returns parsed JSON dict or None on any failure."""
    if not CARGO_URL.startswith("https://"):
        log("[pcgwiki-catalog] WARN: CARGO_URL scheme is not https://; refusing to fetch")
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
        log(f"[pcgwiki-catalog] WARN: cargo fetch failed: {exc}")
        return None
    try:
        data = json.loads(body)
    except Exception as exc:
        log(f"[pcgwiki-catalog] WARN: cargo JSON parse failed: {exc}")
        return None
    if not isinstance(data, dict):
        return None
    return data


def _fetch_all_pages() -> list[dict] | None:
    """Walk every page of the catalog query. Returns the flattened row list
    or None if the very first page fails so the caller can fall back to the
    on-disk cache without a partial merge.
    """
    out: list[dict] = []
    for page in range(MAX_PAGES):
        payload = _cargo_get({
            "action": "cargoquery",
            "format": "json",
            "tables": "Infobox_game",
            "fields": _CARGO_FIELDS,
            "where": _CARGO_WHERE,
            "limit": CARGO_LIMIT,
            "offset": page * CARGO_LIMIT,
        })
        if payload is None:
            if page == 0:
                return None  # nothing to merge, force disk fallback
            log(f"[pcgwiki-catalog] pagination stopped at page {page} (network error)")
            return out
        rows = payload.get("cargoquery") or []
        if not isinstance(rows, list) or not rows:
            return out
        for row in rows:
            if isinstance(row, dict):
                title = row.get("title")
                if isinstance(title, dict):
                    out.append(title)
        if len(rows) < CARGO_LIMIT:
            return out
        time.sleep(CARGO_DELAY_SEC)
    log(f"[pcgwiki-catalog] hit MAX_PAGES ({MAX_PAGES}); truncating")
    return out


def _slugify_page_name(page: str) -> str:
    """Convert a PCGW page name into a URL-safe slug that mirrors the wiki's
    own URL scheme (spaces -> underscores, other chars percent-encoded).
    """
    # PCGW wiki URLs use MediaWiki's title convention: spaces become underscores
    # and the rest is left largely intact (colons, exclamation marks, etc).
    # A basic slug that keeps the raw title recognizable is more useful than
    # aggressive stripping.
    return page.replace(" ", "_")


def _year_from_iso(value) -> int | None:
    """PCGW ships release dates as YYYY-MM-DD (sometimes YYYY only). Pull the
    year and return an int, or None if we cannot parse it.
    """
    if not value:
        return None
    m = re.match(r"^(\d{4})", str(value))
    return int(m.group(1)) if m else None


def _split_company_list(field) -> list[str]:
    """PCGW ships developers / publishers as `Company:Foo,Company:Bar`.
    Strip the namespace prefix + trim.
    """
    if not field:
        return []
    out: list[str] = []
    for token in str(field).split(","):
        name = token.strip()
        if name.startswith(_COMPANY_NAMESPACE_PREFIX):
            name = name[len(_COMPANY_NAMESPACE_PREFIX):].strip()
        if name and name not in out:
            out.append(name)
    return out


def _build_entries(rows: list[dict]) -> dict[str, dict]:
    """Convert Cargo rows into `{pgwiki:<slug>: {name, engine, ...}}`.

    Rejects rows without a page name or that would collide once slugified.
    First-writer-wins on collisions.
    """
    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        page = str(row.get("page") or "").strip()
        if not page:
            continue
        # Belt + braces: even though the WHERE clause already filters, drop
        # any row that came back with a Steam or GOG id (schema drift).
        if str(row.get("appId") or "").strip():
            continue
        if str(row.get("gogId") or "").strip():
            continue
        # Must have a Windows entry -- Proton requires it.
        os_list = _parse_available_on(row.get("available"))
        if "windows" not in os_list:
            continue
        canonical_id = f"pgwiki:{_slugify_page_name(page)}"
        if canonical_id in out:
            continue
        engine = _first_engine(row.get("engines"))
        release_year = _year_from_iso(row.get("relWin"))
        entry = {
            "name": page,
            "engine": engine,
            "developers": _split_company_list(row.get("developers")),
            "publishers": _split_company_list(row.get("publishers")),
            "release_year": release_year,
            "os": os_list,
            "wiki_url": f"https://www.pcgamingwiki.com/wiki/{urllib.parse.quote(_slugify_page_name(page))}",
        }
        out[canonical_id] = entry
    return out


def refresh_catalog(output_dir: Path, force: bool = False) -> dict[str, dict]:
    """Load or refresh the catalog cache. Returns `{pgwiki:<slug>: entry}`.

    Falls back to the on-disk cache when the network is down so a broken
    PCGW day never wipes the catalog.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    now = int(time.time())
    fresh_enough = (now - int(cache.get("fetched_at") or 0)) < FRESH_TTL_SEC
    if fresh_enough and not force and cache.get("entries"):
        log(f"[pcgwiki-catalog] cache hit ({len(cache['entries'])} entries, age {now - int(cache['fetched_at'])}s)")
        return cache["entries"]

    log("[pcgwiki-catalog] refreshing from cargo API")
    rows = _fetch_all_pages()
    if rows is None:
        log(f"[pcgwiki-catalog] cargo unreachable; using {len(cache['entries'])} cached entries")
        return cache["entries"]

    entries = _build_entries(rows)
    cache = {"fetched_at": now, "entries": entries}
    _save_cache(cache_path, cache)
    log(f"[pcgwiki-catalog] cached {len(entries)} entries (of {len(rows)} candidate rows)")
    return entries


def merge_catalog_into_search_index(output_dir: Path) -> None:
    """Add one row per PCGWiki-only entry to `search-index.json`.

    Rows carry the same 16-column shape the enrichers write, filled with
    sensible defaults for a stub game (tier=pending, 0 reports, Windows
    OS list from PCGW). Existing rows are left alone so a re-run does
    not duplicate an entry.
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[pcgwiki-catalog] search-index.json missing, skipping merge")
        return

    try:
        entries_index = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[pcgwiki-catalog] WARN: could not read search-index.json: {exc}")
        return
    if not isinstance(entries_index, list):
        return

    catalog = refresh_catalog(output_dir)
    if not catalog:
        log("[pcgwiki-catalog] catalog empty; nothing to merge")
        return

    existing_ids = {str(row[0]) for row in entries_index if isinstance(row, list) and row}
    added = 0
    for canonical_id, entry in sorted(catalog.items()):
        if canonical_id in existing_ids:
            continue
        row = [
            canonical_id,                      # 0: id
            entry["name"],                     # 1: title
            "pending",                          # 2: tier (no ProtonDB verdict)
            0,                                  # 3: protondb reports
            0,                                  # 4: pulse reports
            "pgwiki",                          # 5: source
            entry.get("release_year"),         # 6: releaseYear
            None,                               # 7: delisted
            False,                              # 8: adult
            "",                                 # 9: trend
            None,                               # 10: replaced_by
            None,                               # 11: steam_type
            None,                               # 12: ac_status
            None,                               # 13: ac_vendors
            entry.get("os") or ["windows"],    # 14: pgw_os
            entry.get("engine"),               # 15: pgw_engine
        ]
        entries_index.append(row)
        added += 1

    index_path.write_text(json.dumps(entries_index, separators=(",", ":")), encoding="utf-8")
    log(f"[pcgwiki-catalog] merged {added} new rows (skipped {len(catalog) - added} already present)")

    # Publish the full catalog so the game page can render richer stubs
    # (developers, publishers, wiki_url) without a separate fetch per app.
    published = output_dir / OUTPUT_FILENAME
    published.write_text(json.dumps(catalog, separators=(",", ":")), encoding="utf-8")
