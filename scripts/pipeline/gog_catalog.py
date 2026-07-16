"""Fetch the full GOG game catalog (product_id -> title) for pipeline use.

Uses the public embed.gog.com/games/ajax/filtered endpoint (no auth required).
Paginates all pages and caches locally for 7 days.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from urllib import error, request

from .common import log

# Transient HTTP statuses worth retrying. 429 (rate limited) is the big one:
# embed.gog.com throttles aggressively and dropping those pages loses thousands
# of games from the catalog.
_RETRY_STATUSES = {429, 500, 502, 503, 504}
_MAX_PAGE_ATTEMPTS = 6
_INTER_PAGE_DELAY_SECONDS = 0.25

DEFAULT_GOG_CATALOG_CACHE_PATH = (
    Path(__file__).resolve().parents[2] / ".cache" / "gog-catalog-cache.json"
)
GOG_CATALOG_CACHE_MAX_AGE_SECONDS = 7 * 86400  # 7 days
# Use the modern catalog.gog.com API (what the GOG website catalog page calls).
# The old embed.gog.com/games/ajax/filtered endpoint hard-caps deep pagination
# at ~12,288 items (page 256) and 400s past it, silently dropping the tail of
# the alphabet (SWAT 4 among them). catalog.gog.com paginates the full set.
GOG_CATALOG_URL = (
    "https://catalog.gog.com/v1/catalog"
    "?limit=48&page={page}&order=asc:title"
    "&productType=in:game,pack&countryCode=US&locale=en-US&currencyCode=USD"
)

_gog_catalog_cache: dict[str, str] | None = None
# Parallel map {str(product_id): cover_image_url} populated alongside the title
# catalog. Kept separate so load_gog_catalog stays a {id: title} contract for
# existing callers (search-index stub generation).
_gog_covers_cache: dict[str, str] | None = None
# Parallel map {str(product_id): year_int} for release-year disambiguation
# (#112). GOG's catalog payload carries releaseDate per product, so we pull
# it in the same fetch pass instead of a separate per-product API call.
_gog_years_cache: dict[str, int] | None = None


def load_gog_catalog(
    cache_path: Path = DEFAULT_GOG_CATALOG_CACHE_PATH,
    max_age_seconds: int = GOG_CATALOG_CACHE_MAX_AGE_SECONDS,
    force_refresh: bool = False,
) -> dict[str, str]:
    """Return {str(product_id): title} for all GOG games.

    Reads from local cache if fresh enough, otherwise fetches from the API.
    Returns empty dict on failure so callers degrade gracefully. Cover image
    URLs and release years are loaded into parallel caches; use
    load_gog_covers() and load_gog_release_years() to read them.
    """
    global _gog_catalog_cache, _gog_covers_cache, _gog_years_cache
    if _gog_catalog_cache is not None and not force_refresh:
        return _gog_catalog_cache

    if not force_refresh and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            age = time.time() - cached.get("_ts", 0)
            if age < max_age_seconds:
                _gog_catalog_cache = cached.get("catalog", {})
                _gog_covers_cache = cached.get("covers", {})
                # `years` was added in #112. Older caches without the field
                # load fine -- the years map stays empty until the cache
                # expires and the next fetch populates it.
                _gog_years_cache = cached.get("years", {}) or {}
                log(
                    f"[gog-catalog] loaded {len(_gog_catalog_cache):,} entries"
                    f" ({len(_gog_covers_cache):,} covers, {len(_gog_years_cache):,} years) from cache (age {age / 3600:.1f}h)"
                )
                return _gog_catalog_cache
        except (OSError, json.JSONDecodeError, KeyError):
            pass

    log("[gog-catalog] fetching full GOG catalog from catalog.gog.com ...")
    try:
        catalog, covers, years = _fetch_all_pages()
    except Exception as exc:
        log(f"[gog-catalog] WARN: catalog fetch failed: {exc}; search index will lack GOG stubs")
        _gog_catalog_cache = {}
        _gog_covers_cache = {}
        _gog_years_cache = {}
        return _gog_catalog_cache

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(
            {"_ts": int(time.time()), "catalog": catalog, "covers": covers, "years": years},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    log(f"[gog-catalog] cached {len(catalog):,} entries ({len(covers):,} covers, {len(years):,} years) to {cache_path}")
    _gog_catalog_cache = catalog
    _gog_covers_cache = covers
    _gog_years_cache = years
    return catalog


def load_gog_covers(
    cache_path: Path = DEFAULT_GOG_CATALOG_CACHE_PATH,
    max_age_seconds: int = GOG_CATALOG_CACHE_MAX_AGE_SECONDS,
) -> dict[str, str]:
    """Return {str(product_id): cover_image_url} for GOG games.

    Triggers a catalog load if needed so the covers cache is populated.
    """
    global _gog_covers_cache
    if _gog_covers_cache is None:
        load_gog_catalog(cache_path=cache_path, max_age_seconds=max_age_seconds)
    return _gog_covers_cache or {}


def load_gog_release_years(
    cache_path: Path = DEFAULT_GOG_CATALOG_CACHE_PATH,
    max_age_seconds: int = GOG_CATALOG_CACHE_MAX_AGE_SECONDS,
) -> dict[str, int]:
    """Return {str(product_id): year} for GOG games (#112).

    Triggers a catalog load if needed so the years cache is populated.
    Empty dict if the cached catalog predates #112 -- the next fetch after
    the 7-day TTL populates it automatically. Callers should treat missing
    entries as "no year available" (leave column 6 null).
    """
    global _gog_years_cache
    if _gog_years_cache is None:
        load_gog_catalog(cache_path=cache_path, max_age_seconds=max_age_seconds)
    return _gog_years_cache or {}


def _extract_year(release_date: str | None) -> int | None:
    """Pull a 19xx/20xx year out of GOG's releaseDate string. Formats vary
    (ISO, human-readable, `TBA`); a regex on the whole string catches
    them without a date-parser dependency.
    """
    if not release_date:
        return None
    import re as _re
    m = _re.search(r"\b(19\d{2}|20\d{2})\b", str(release_date))
    return int(m.group(1)) if m else None


def _fetch_all_pages() -> tuple[dict[str, str], dict[str, str], dict[str, int]]:
    catalog: dict[str, str] = {}
    covers: dict[str, str] = {}
    years: dict[str, int] = {}
    page = 1
    total_pages = 1
    skipped_pages = 0

    while page <= total_pages:
        try:
            data = _fetch_page(page)
        except Exception as exc:
            skipped_pages += 1
            log(f"[gog-catalog] WARN: page {page}/{total_pages} failed after retries ({exc}); skipping")
            page += 1
            time.sleep(_INTER_PAGE_DELAY_SECONDS)
            continue

        if page == 1:
            total_pages = int(data.get("pages", 1))
            log(
                f"[gog-catalog] {data.get('productCount', '?')} GOG games"
                f" across {total_pages} pages"
            )

        for product in data.get("products", []):
            pid = product.get("id")
            title = (product.get("title") or "").strip()
            if pid and title:
                catalog[str(pid)] = title
                cover = (product.get("coverHorizontal") or "").strip()
                if cover:
                    covers[str(pid)] = cover
                year = _extract_year(product.get("releaseDate"))
                if year is not None:
                    years[str(pid)] = year

        if page % 100 == 0:
            log(f"[gog-catalog] page {page}/{total_pages} ({len(catalog):,} games so far)")
        page += 1
        time.sleep(_INTER_PAGE_DELAY_SECONDS)

    log(f"[gog-catalog] complete: {len(catalog):,} GOG games ({skipped_pages} page(s) skipped after retries)")
    return catalog, covers, years


def _fetch_page(page: int) -> dict:
    """Fetch one catalog page, retrying transient failures with backoff.

    catalog.gog.com returns HTTP 429 under load. Retry with exponential backoff
    (honoring Retry-After when present) and only give up after _MAX_PAGE_ATTEMPTS,
    so a busy moment no longer truncates the catalog.
    """
    url = GOG_CATALOG_URL.format(page=page)
    req = request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    delay = 1.0
    for attempt in range(1, _MAX_PAGE_ATTEMPTS + 1):
        try:
            # URL from hardcoded GOG_CATALOG_URL + page number
            with request.urlopen(req, timeout=20) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
                return json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as exc:
            if exc.code not in _RETRY_STATUSES or attempt == _MAX_PAGE_ATTEMPTS:
                raise
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            wait = float(retry_after) if (retry_after and str(retry_after).isdigit()) else delay
            log(f"[gog-catalog] page {page} HTTP {exc.code} (attempt {attempt}/{_MAX_PAGE_ATTEMPTS}); retry in {wait:.1f}s")
            time.sleep(wait)
            delay = min(delay * 2, 30.0)
        except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == _MAX_PAGE_ATTEMPTS:
                raise
            log(f"[gog-catalog] page {page} transient error {exc!r} (attempt {attempt}/{_MAX_PAGE_ATTEMPTS}); retry in {delay:.1f}s")
            time.sleep(delay)
            delay = min(delay * 2, 30.0)
    raise RuntimeError(f"unreachable: exhausted retries for page {page}")


def flush_gog_catalog_cache() -> None:
    global _gog_catalog_cache, _gog_covers_cache
    _gog_catalog_cache = None
    _gog_covers_cache = None
