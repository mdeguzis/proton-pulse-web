"""Fetch the full Epic Games Store catalog (namespace -> title) for pipeline use.

Uses the public Epic GraphQL searchStore endpoint (no auth required).
Paginates all results and caches locally for 7 days.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from urllib import error, request

from .common import log

# Transient HTTP statuses worth retrying instead of giving up on the whole run.
_RETRY_STATUSES = {429, 500, 502, 503, 504}
_MAX_PAGE_ATTEMPTS = 6
_INTER_PAGE_DELAY_SECONDS = 0.25

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
        releaseDate
        keyImages {
          type
          url
        }
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
# Parallel map {namespace: cover_image_url}, kept separate so load_epic_catalog
# stays a {namespace: title} contract. Read it via load_epic_covers().
_epic_covers_cache: dict[str, str] | None = None
# Parallel map {namespace: year_int} for release-year disambiguation (#112).
_epic_years_cache: dict[str, int] | None = None
# keyImages types worth using as a header/box image, best first.
_EPIC_COVER_TYPES = ("DieselStoreFrontWide", "OfferImageWide", "Featured", "DieselGameBoxWide")


def load_epic_catalog(
    cache_path: Path = DEFAULT_EPIC_CATALOG_CACHE_PATH,
    max_age_seconds: int = EPIC_CATALOG_CACHE_MAX_AGE_SECONDS,
    force_refresh: bool = False,
) -> dict[str, str]:
    """Return {namespace: title} for all Epic Games Store games.

    Reads from local cache if fresh enough, otherwise fetches from the API.
    Returns empty dict on failure so callers degrade gracefully. Cover image
    URLs load into a parallel cache; read them via load_epic_covers().
    """
    global _epic_catalog_cache, _epic_covers_cache, _epic_years_cache
    if _epic_catalog_cache is not None and not force_refresh:
        return _epic_catalog_cache

    if not force_refresh and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            age = time.time() - cached.get("_ts", 0)
            if age < max_age_seconds:
                _epic_catalog_cache = cached.get("catalog", {})
                _epic_covers_cache = cached.get("covers", {})
                # `years` added in #112 -- older caches without the field
                # load fine; empty map until the 7-day TTL expires and the
                # next fetch populates it.
                _epic_years_cache = cached.get("years", {}) or {}
                log(
                    f"[epic-catalog] loaded {len(_epic_catalog_cache):,} entries"
                    f" ({len(_epic_covers_cache):,} covers, {len(_epic_years_cache):,} years) from cache (age {age / 3600:.1f}h)"
                )
                return _epic_catalog_cache
        except (OSError, json.JSONDecodeError, KeyError):
            pass

    log("[epic-catalog] fetching full Epic catalog from store.epicgames.com ...")
    try:
        catalog, covers, years = _fetch_all_pages()
    except Exception as exc:
        log(f"[epic-catalog] WARN: catalog fetch failed: {exc}; search index will lack Epic stubs")
        _epic_catalog_cache = {}
        _epic_covers_cache = {}
        _epic_years_cache = {}
        return _epic_catalog_cache

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(
            {"_ts": int(time.time()), "catalog": catalog, "covers": covers, "years": years},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    log(f"[epic-catalog] cached {len(catalog):,} entries ({len(covers):,} covers, {len(years):,} years) to {cache_path}")
    _epic_catalog_cache = catalog
    _epic_covers_cache = covers
    _epic_years_cache = years
    return catalog


def load_epic_covers(
    cache_path: Path = DEFAULT_EPIC_CATALOG_CACHE_PATH,
    max_age_seconds: int = EPIC_CATALOG_CACHE_MAX_AGE_SECONDS,
) -> dict[str, str]:
    """Return {namespace: cover_image_url} for Epic games."""
    global _epic_covers_cache
    if _epic_covers_cache is None:
        load_epic_catalog(cache_path=cache_path, max_age_seconds=max_age_seconds)
    return _epic_covers_cache or {}


def load_epic_release_years(
    cache_path: Path = DEFAULT_EPIC_CATALOG_CACHE_PATH,
    max_age_seconds: int = EPIC_CATALOG_CACHE_MAX_AGE_SECONDS,
) -> dict[str, int]:
    """Return {namespace: year} for Epic games (#112).

    Empty dict if the cached catalog predates #112 -- next fetch after
    the 7-day TTL populates it.
    """
    global _epic_years_cache
    if _epic_years_cache is None:
        load_epic_catalog(cache_path=cache_path, max_age_seconds=max_age_seconds)
    return _epic_years_cache or {}


def _extract_year(release_date: str | None) -> int | None:
    """Pull a 19xx/20xx year out of Epic's releaseDate string. Epic
    returns ISO-8601 (e.g. `2017-05-05T04:00:00.000Z`), possibly null.
    """
    if not release_date:
        return None
    import re as _re
    m = _re.search(r"\b(19\d{2}|20\d{2})\b", str(release_date))
    return int(m.group(1)) if m else None


def _pick_cover(key_images: list) -> str:
    """Choose the best wide header image from an Epic keyImages list."""
    by_type = {img.get("type"): (img.get("url") or "").strip() for img in (key_images or []) if isinstance(img, dict)}
    for t in _EPIC_COVER_TYPES:
        if by_type.get(t):
            return by_type[t]
    # fall back to the first non-empty image url of any type
    for url in by_type.values():
        if url:
            return url
    return ""


def _fetch_all_pages() -> tuple[dict[str, str], dict[str, str], dict[str, int]]:
    catalog: dict[str, str] = {}
    covers: dict[str, str] = {}
    years: dict[str, int] = {}
    start = 0
    total = None

    while True:
        try:
            data = _fetch_page(start)
        except Exception as exc:
            log(f"[epic-catalog] WARN: request at start={start} failed after retries ({exc}); stopping")
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
                cover = _pick_cover(elem.get("keyImages"))
                if cover:
                    covers[namespace] = cover
                year = _extract_year(elem.get("releaseDate"))
                if year is not None:
                    years[namespace] = year

        start += len(elements)
        if not elements or start >= total:
            break

        if start % 400 == 0:
            log(f"[epic-catalog] fetched {start}/{total} ({len(catalog):,} unique namespaces so far)")
        time.sleep(_INTER_PAGE_DELAY_SECONDS)

    log(f"[epic-catalog] complete: {len(catalog):,} Epic games ({len(covers):,} covers, {len(years):,} years)")
    return catalog, covers, years


def _fetch_page(start: int) -> dict:
    """POST one searchStore page, retrying transient failures with backoff.

    The old loop broke out of pagination on the first error, so a single HTTP
    429 truncated the whole catalog. Retry with exponential backoff (honoring
    Retry-After) and only raise after _MAX_PAGE_ATTEMPTS.
    """
    query = _EPIC_QUERY % {"count": EPIC_PAGE_SIZE, "start": start}
    body = json.dumps({"query": query}).encode("utf-8")
    delay = 1.0
    for attempt in range(1, _MAX_PAGE_ATTEMPTS + 1):
        req = request.Request(EPIC_GRAPHQL_URL, data=body, headers=_HEADERS, method="POST")
        try:
            with request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as exc:
            if exc.code not in _RETRY_STATUSES or attempt == _MAX_PAGE_ATTEMPTS:
                raise
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            wait = float(retry_after) if (retry_after and str(retry_after).isdigit()) else delay
            log(f"[epic-catalog] start={start} HTTP {exc.code} (attempt {attempt}/{_MAX_PAGE_ATTEMPTS}); retry in {wait:.1f}s")
            time.sleep(wait)
            delay = min(delay * 2, 30.0)
        except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == _MAX_PAGE_ATTEMPTS:
                raise
            log(f"[epic-catalog] start={start} transient error {exc!r} (attempt {attempt}/{_MAX_PAGE_ATTEMPTS}); retry in {delay:.1f}s")
            time.sleep(delay)
            delay = min(delay * 2, 30.0)
    raise RuntimeError(f"unreachable: exhausted retries for start={start}")


def flush_epic_catalog_cache() -> None:
    global _epic_catalog_cache, _epic_covers_cache
    _epic_catalog_cache = None
    _epic_covers_cache = None
