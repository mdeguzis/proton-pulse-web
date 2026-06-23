"""Fetch the full GOG game catalog (product_id -> title) for pipeline use.

Uses the public embed.gog.com/games/ajax/filtered endpoint (no auth required).
Paginates all pages and caches locally for 7 days.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from urllib import request

from .common import log

DEFAULT_GOG_CATALOG_CACHE_PATH = (
    Path(__file__).resolve().parents[2] / ".cache" / "gog-catalog-cache.json"
)
GOG_CATALOG_CACHE_MAX_AGE_SECONDS = 7 * 86400  # 7 days
GOG_CATALOG_URL = (
    "https://embed.gog.com/games/ajax/filtered"
    "?mediaType=game&sort=title&limit=48&page={page}"
)

_gog_catalog_cache: dict[str, str] | None = None


def load_gog_catalog(
    cache_path: Path = DEFAULT_GOG_CATALOG_CACHE_PATH,
    max_age_seconds: int = GOG_CATALOG_CACHE_MAX_AGE_SECONDS,
    force_refresh: bool = False,
) -> dict[str, str]:
    """Return {str(product_id): title} for all GOG games.

    Reads from local cache if fresh enough, otherwise fetches from the API.
    Returns empty dict on failure so callers degrade gracefully.
    """
    global _gog_catalog_cache
    if _gog_catalog_cache is not None and not force_refresh:
        return _gog_catalog_cache

    if not force_refresh and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            age = time.time() - cached.get("_ts", 0)
            if age < max_age_seconds:
                _gog_catalog_cache = cached.get("catalog", {})
                log(
                    f"[gog-catalog] loaded {len(_gog_catalog_cache):,} entries"
                    f" from cache (age {age / 3600:.1f}h)"
                )
                return _gog_catalog_cache
        except (OSError, json.JSONDecodeError, KeyError):
            pass

    log("[gog-catalog] fetching full GOG catalog from embed.gog.com ...")
    try:
        catalog = _fetch_all_pages()
    except Exception as exc:
        log(f"[gog-catalog] WARN: catalog fetch failed: {exc}; search index will lack GOG stubs")
        _gog_catalog_cache = {}
        return _gog_catalog_cache

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps({"_ts": int(time.time()), "catalog": catalog}, ensure_ascii=False),
        encoding="utf-8",
    )
    log(f"[gog-catalog] cached {len(catalog):,} entries to {cache_path}")
    _gog_catalog_cache = catalog
    return catalog


def _fetch_all_pages() -> dict[str, str]:
    catalog: dict[str, str] = {}
    page = 1
    total_pages = 1

    while page <= total_pages:
        url = GOG_CATALOG_URL.format(page=page)
        req = request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            log(f"[gog-catalog] WARN: page {page} failed ({exc}); skipping")
            page += 1
            continue

        if page == 1:
            total_pages = int(data.get("totalPages", 1))
            log(
                f"[gog-catalog] {data.get('totalResults', '?')} GOG games"
                f" across {total_pages} pages"
            )

        for product in data.get("products", []):
            pid = product.get("id")
            title = (product.get("title") or "").strip()
            if pid and title:
                catalog[str(pid)] = title

        if page % 100 == 0:
            log(f"[gog-catalog] page {page}/{total_pages} ({len(catalog):,} games so far)")
        page += 1

    log(f"[gog-catalog] complete: {len(catalog):,} GOG games")
    return catalog


def flush_gog_catalog_cache() -> None:
    global _gog_catalog_cache
    _gog_catalog_cache = None
