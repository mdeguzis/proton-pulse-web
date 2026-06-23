"""Fetch the full Epic Games Store catalog (namespace -> title) for pipeline use.

Uses the public Epic GraphQL searchStore endpoint (no auth required).
Paginates all results and caches locally for 7 days.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from urllib import request

from .common import log

DEFAULT_EPIC_CATALOG_CACHE_PATH = (
    Path(__file__).resolve().parents[2] / ".cache" / "epic-catalog-cache.json"
)
EPIC_CATALOG_CACHE_MAX_AGE_SECONDS = 7 * 86400  # 7 days
EPIC_GRAPHQL_URL = "https://store.epicgames.com/graphql"
EPIC_PAGE_SIZE = 40

_EPIC_QUERY = """
{
  Catalog {
    searchStore(
      category: "games/edition/base"
      country: "US"
      locale: "en-US"
      count: %(count)d
      start: %(start)d
      sortBy: "title"
      sortDir: "ASC"
    ) {
      elements {
        title
        namespace
      }
      paging {
        count
        total
      }
    }
  }
}
"""

_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin": "https://store.epicgames.com",
    "Referer": "https://store.epicgames.com/en-US/browse",
}

_epic_catalog_cache: dict[str, str] | None = None


def load_epic_catalog(
    cache_path: Path = DEFAULT_EPIC_CATALOG_CACHE_PATH,
    max_age_seconds: int = EPIC_CATALOG_CACHE_MAX_AGE_SECONDS,
    force_refresh: bool = False,
) -> dict[str, str]:
    """Return {namespace: title} for all Epic Games Store games.

    Reads from local cache if fresh enough, otherwise fetches from the API.
    Returns empty dict on failure so callers degrade gracefully.
    """
    global _epic_catalog_cache
    if _epic_catalog_cache is not None and not force_refresh:
        return _epic_catalog_cache

    if not force_refresh and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            age = time.time() - cached.get("_ts", 0)
            if age < max_age_seconds:
                _epic_catalog_cache = cached.get("catalog", {})
                log(
                    f"[epic-catalog] loaded {len(_epic_catalog_cache):,} entries"
                    f" from cache (age {age / 3600:.1f}h)"
                )
                return _epic_catalog_cache
        except (OSError, json.JSONDecodeError, KeyError):
            pass

    log("[epic-catalog] fetching full Epic catalog from store.epicgames.com ...")
    try:
        catalog = _fetch_all_pages()
    except Exception as exc:
        log(f"[epic-catalog] WARN: catalog fetch failed: {exc}; search index will lack Epic stubs")
        _epic_catalog_cache = {}
        return _epic_catalog_cache

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps({"_ts": int(time.time()), "catalog": catalog}, ensure_ascii=False),
        encoding="utf-8",
    )
    log(f"[epic-catalog] cached {len(catalog):,} entries to {cache_path}")
    _epic_catalog_cache = catalog
    return catalog


def _fetch_all_pages() -> dict[str, str]:
    catalog: dict[str, str] = {}
    start = 0
    total = None

    while True:
        query = _EPIC_QUERY % {"count": EPIC_PAGE_SIZE, "start": start}
        body = json.dumps({"query": query}).encode("utf-8")
        req = request.Request(EPIC_GRAPHQL_URL, data=body, headers=_HEADERS, method="POST")

        try:
            with request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            log(f"[epic-catalog] WARN: request at start={start} failed ({exc}); stopping")
            break

        store = data.get("data", {}).get("Catalog", {}).get("searchStore", {})
        elements = store.get("elements", [])
        paging = store.get("paging", {})

        if total is None:
            total = int(paging.get("total", 0))
            log(f"[epic-catalog] {total} Epic games to fetch")

        for elem in elements:
            namespace = (elem.get("namespace") or "").strip()
            title = (elem.get("title") or "").strip()
            if namespace and title:
                catalog[namespace] = title

        start += len(elements)
        if not elements or start >= total:
            break

        if start % 400 == 0:
            log(f"[epic-catalog] fetched {start}/{total} ({len(catalog):,} unique namespaces so far)")

    log(f"[epic-catalog] complete: {len(catalog):,} Epic games")
    return catalog


def flush_epic_catalog_cache() -> None:
    global _epic_catalog_cache
    _epic_catalog_cache = None
