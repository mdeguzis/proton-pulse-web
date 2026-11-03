"""Fetch release years for Steam apps whose titles collide in search-index.json.

A small but high-value enrichment: most games have unique titles, but when two
or more (e.g. Prey 2006 vs Prey 2017) share an exact name, the storefront badge
alone is not enough for users to tell them apart. We cache the year and write
it back into search-index column 7.

Source (#411): the finalize store sweep (IStoreBrowseService/GetItems on
api.steampowered.com, 200 apps per call, already run for steam_type and
native-linux). It answers every Steam id in the index each night, so a sweep
year always wins over the cache. That also corrects years cached while a game
was still in early access. appdetails on store.steampowered.com is only a
fallback for colliding ids the sweep did not answer, because it 403s or 429s
from Actions runner IPs (2026-11-02: 8 of 8 requests 403'd on the first try).

Strategy:
  - Only Steam numeric app IDs (GOG/Epic ids are skipped; their catalogs
    already encode store + slug).
  - Only apps whose normalized title appears two or more times in the current
    search-index.
  - Sweep says "no date" ("To be announced", "Coming soon"): not cached, so
    the next night's sweep picks the date up once Valve sets one.
  - appdetails fallback is capped per run with PROBE_CAP and cached forever.
"""

import json
import re
import time
from collections import defaultdict
from pathlib import Path

from . import http_client
from .common import log

STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={appid}"
# Pacing lives in http_client.PROFILES["store.steampowered.com"] (#411).
# This module used to sleep 0.3s between requests to the same endpoint
# steam_type.py had measured 0.3s as getting banned within seconds on.
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
    # The shared client paces store.steampowered.com for every module in
    # finalize, retries a 429 once and opens a breaker after repeated
    # 403s, so this module no longer sleeps or retries on its own (#411).
    try:
        data = http_client.default_client().get_json(url, timeout=timeout)
    except http_client.HttpError as exc:
        log(f"[release-years] WARN: Steam appdetails fetch failed for {app_id}: {exc}")
        return None, False
    if not isinstance(data, dict):
        log(f"[release-years] WARN: Steam appdetails for {app_id} was not an object: {type(data).__name__}")
        return None, False
    app_data = data.get(str(app_id)) or {}
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


def enrich_search_index_with_release_years(output_dir: Path, sweep: dict | None = None) -> None:
    """Detect colliding titles in search-index.json, fill their years, write
    the year as column 7 of each entry that has one.

    `sweep` is the finalize store_sweep result. Years come from it first; only
    colliding ids it did not answer go to appdetails. Without a sweep every
    uncached id goes to appdetails, the pre-#411 behaviour.

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

    swept = (sweep or {}).get("items") or {}
    from_sweep = corrected = undated = 0
    cache_changed = False
    needs_fetch: list[str] = []
    for i in colliding_idxs:
        app_id = str(entries[i][0])
        if not app_id.isdigit():
            continue  # GOG/Epic stubs have no Steam release date
        item = swept.get(app_id)
        if item is not None:
            year = item.get("release_year")
            if year:
                if app_id in cache and cache[app_id] != year:
                    corrected += 1
                if cache.get(app_id) != year:
                    cache[app_id] = year
                    cache_changed = True
                from_sweep += 1
            else:
                undated += 1  # answered, no date yet: re-check next night
            continue
        if app_id not in cache:
            needs_fetch.append(app_id)

    log(
        f"[release-years] {len(colliding_idxs)} colliding entries: {from_sweep} years from the "
        f"GetItems sweep ({corrected} corrected a cached year), {undated} with no date yet, "
        f"{len(needs_fetch)} not in the sweep need appdetails (cap {PROBE_CAP})"
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

    if bail_reason:
        log(f"[release-years] bailing early: {bail_reason} (probed {fetched} of {min(len(needs_fetch), PROBE_CAP)})")

    if fetched or cache_changed:
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
