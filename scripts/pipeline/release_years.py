"""Fetch release years for Steam apps whose titles collide in search-index.json.

A small but high-value enrichment: most games have unique titles, but when two
or more (e.g. Prey 2006 vs Prey 2017) share an exact name, the storefront badge
alone is not enough for users to tell them apart. Steam's appdetails endpoint
returns release_date, which we cache and write back into search-index column 7.

Strategy:
  - Only fetch for Steam numeric app IDs (GOG/Epic ids are skipped; their
    catalogs already encode store + slug).
  - Only fetch for apps whose normalized title appears two or more times in the
    current search-index.
  - Cap fetches per run with PROBE_CAP so a cold start does not hammer Steam.
  - Cache forever -- release dates do not change.
"""

import json
import re
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

from .common import log

STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={appid}"
REQUEST_DELAY = 0.3
# Steam soft-throttles appdetails at ~200 req / 5min. game_images.py and
# common.py::fetch_steam_content_descriptors also hit this endpoint in the
# same finalize job -- combined cold-start burst can push over the limit
# for a few minutes. The cache-persistence fix (#109) makes this only bite
# on the first run ever; subsequent runs only probe new-collision apps, so
# the per-file caps rarely fire together.
PROBE_CAP = 200
# Wall-clock budget so a Steam 403-flood does not stall finalize past
# this many seconds regardless of how many apps are still in the queue.
# Mirrors the same defense in steam_type.py (#258).
WALL_CLOCK_BUDGET_SEC = 240
# Bail after this many transport failures in a row -- our proxy for
# "Steam is currently rate-limiting or down".
CONSECUTIVE_FAILURE_LIMIT = 8
# Save the cache mid-run so a cancelled or timed-out job does not lose
# everything it just fetched.
CACHE_SAVE_EVERY = 20
CACHE_FILENAME = "release-years-cache.json"


def _normalize_title(title: str) -> str:
    return (title or "").strip().lower()


def _extract_year(release_date: dict | None) -> int | None:
    """Steam returns release_date as {"coming_soon": bool, "date": "Mar 5, 2017"}.
    Pull the trailing 4-digit year regardless of locale format. Returns None
    when the date is unparseable, missing, or marks a TBD/unreleased game.
    """
    if not isinstance(release_date, dict):
        return None
    raw = (release_date.get("date") or "").strip()
    if not raw:
        return None
    match = re.search(r"\b(19\d{2}|20\d{2})\b", raw)
    if not match:
        return None
    return int(match.group(1))


# Fetch outcome: (year_or_None, success_bool). success is False only for
# transport / API errors (network, 403, 429, 5xx, timeout), NOT for a valid
# response that lacked a parseable year. Mirrors steam_type._fetch_type.
def _fetch_year(app_id: str, timeout: int = 6) -> tuple[int | None, bool]:
    url = STEAM_APPDETAILS_URL.format(appid=app_id)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        # URL from hardcoded STEAM_APPDETAILS_URL + validated app_id
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        log(f"[release-years] WARN: Steam appdetails fetch failed for {app_id}: {exc}")
        return None, False
    app_data = data.get(str(app_id), {})
    if not app_data.get("success"):
        return None, True  # valid response, app is delisted / TBD
    return _extract_year(app_data.get("data", {}).get("release_date")), True


def _load_cache(path: Path) -> dict[str, int | None]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[release-years] WARN: could not load cache {path.name}: {exc}")
        return {}


def enrich_search_index_with_release_years(output_dir: Path) -> None:
    """Detect colliding titles in search-index.json, fetch missing years, write
    the year as column 7 of each entry that has one.

    No-op when no collisions exist. Re-emits search-index.json in-place. Reads
    and writes release-years-cache.json next to it.
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[release-years] search-index.json missing, skipping enrichment")
        return

    try:
        entries = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[release-years] WARN: could not read search-index.json: {exc}")
        return
    if not isinstance(entries, list) or not entries:
        return

    # Group by normalized title; only colliding titles are candidates
    by_title: dict[str, list[int]] = defaultdict(list)
    for i, row in enumerate(entries):
        if isinstance(row, list) and len(row) >= 2:
            by_title[_normalize_title(row[1])].append(i)
    colliding_idxs: set[int] = set()
    for idxs in by_title.values():
        if len(idxs) >= 2:
            colliding_idxs.update(idxs)

    if not colliding_idxs:
        log("[release-years] no title collisions in search-index, skipping")
        return

    # Cache lookup: only Steam numeric IDs are eligible to fetch from appdetails
    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    needs_fetch: list[str] = []
    for i in colliding_idxs:
        app_id = str(entries[i][0])
        if not app_id.isdigit():
            continue  # GOG/Epic stubs skip appdetails
        if app_id not in cache:
            needs_fetch.append(app_id)

    log(
        f"[release-years] {len(colliding_idxs)} colliding entries, "
        f"{len(needs_fetch)} need fetch (cap {PROBE_CAP})"
    )

    fetched = 0
    consecutive_failures = 0
    deadline = time.monotonic() + WALL_CLOCK_BUDGET_SEC
    bail_reason = None
    for app_id in needs_fetch[:PROBE_CAP]:
        if time.monotonic() > deadline:
            bail_reason = f"wall-clock budget {WALL_CLOCK_BUDGET_SEC}s exhausted"
            break
        if consecutive_failures >= CONSECUTIVE_FAILURE_LIMIT:
            bail_reason = (
                f"{consecutive_failures} consecutive transport failures "
                "(assuming Steam rate-limit / outage)"
            )
            break
        year, ok = _fetch_year(app_id)
        if not ok:
            consecutive_failures += 1
        else:
            consecutive_failures = 0
            cache[app_id] = year  # None here means "delisted / TBD"
        fetched += 1
        if year:
            log(f"[release-years] {app_id} -> {year}")
        if fetched % CACHE_SAVE_EVERY == 0:
            cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
        time.sleep(REQUEST_DELAY)

    if bail_reason:
        log(f"[release-years] bailing early: {bail_reason} (probed {fetched} of {min(len(needs_fetch), PROBE_CAP)})")

    if fetched:
        cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
        log(f"[release-years] wrote cache ({len(cache)} entries) to {cache_path.name}")

    # Re-emit search-index with year column populated for colliding entries
    updated = 0
    for i in colliding_idxs:
        app_id = str(entries[i][0])
        year = cache.get(app_id)
        if not year:
            continue
        row = entries[i]
        # Pad to 7 columns and write year at index 6
        while len(row) < 7:
            row.append(None)
        row[6] = year
        updated += 1

    if updated:
        index_path.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
        log(f"[release-years] populated releaseYear on {updated} colliding entries in search-index.json")
