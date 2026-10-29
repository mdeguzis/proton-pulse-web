"""Fetch the Steam appdetails `type` field for Steam apps in search-index.

Steam apps come in several flavors: game, dlc, mod, demo, video, hardware,
software, movie, series, episode, music. The browse view needs this to
offer a Type filter chip (so a user can hide DLC/video/software while
scanning their library) and to drop truly-non-game types (movie / music /
hardware / series) that will never have Proton compat data.

Since #261 the main source is Steam's batched IStoreBrowseService/GetItems
(see steam_platforms.store_sweep): finalize sweeps every Steam id once,
200 per request, and passes the result in. Its type wins over the cache, so
the backlog and the cached nulls clear in one run. Apps the sweep could not
answer keep their cached type; any still missing fall back to the per-app
appdetails path below, with its original cap.

Strategy for that fallback mirrors release_years.py:
  - Only Steam numeric app IDs get probed (GOG / Epic ids ship a store
    prefix and are not covered by Steam's appdetails endpoint).
  - Fetches are capped per run so a cold start does not hammer Steam.
  - Cache-forever semantics: an app's type is a Valve-side classification
    that effectively never changes.

The cache stores the raw string ("game", "dlc", ...) or None when Steam
returned success=false (delisted, region-locked, or non-existent app).
Empty-string writes into search-index column 11 mean "unknown"; the
frontend defaults to treating unknown as game for filtering purposes.
"""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

from .common import log

STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={appid}&filters=basic"
# Steam's soft throttle is ~200 requests / 5 minutes -- so at least 1.5s
# per request. At 0.3s we tripped the rolling-window ban within seconds
# and every subsequent probe returned 403 until the whole cycle bailed.
# 2.0s keeps us comfortably under the limit so each cycle finishes with
# real cache writes instead of a wall of failures.
REQUEST_DELAY = 2.0
# Shared budget with the other appdetails-fetching modules (release_years,
# game_images). Steam soft-throttles at ~200 req / 5 min. If we ever
# want faster than the throttle, batched appids (#261) is the fix, not
# reducing the delay here.
PROBE_CAP = 200
# Wall-clock budget for the whole enricher. At 2s per request, PROBE_CAP
# = 200 apps takes about 400s of pure I/O, so 600s leaves headroom for
# network jitter and the mid-cycle cache writes. Cycles that get stuck
# on real API failures (transport errors, DNS drops) still bail out via
# CONSECUTIVE_FAILURE_LIMIT below.
WALL_CLOCK_BUDGET_SEC = 600
# Give up if this many probes in a row fail. That is our proxy for
# "Steam is currently rate-limiting or down"; retrying more will not
# get better data and just burns the budget.
CONSECUTIVE_FAILURE_LIMIT = 8
# Save cache every N successful writes so a cancelled or timed-out run
# does not lose everything it fetched. Trade off: a smaller number means
# more disk churn but tighter recovery.
CACHE_SAVE_EVERY = 20
CACHE_FILENAME = "steam-type-cache.json"

# Types that will never have Proton compat data. Emitted as an empty
# entry in search-index so the finalize pass can drop them, but kept in
# the cache so we do not re-probe them next run.
NON_GAME_TYPES = frozenset({"movie", "music", "series", "episode", "hardware"})


# Fetch outcome: (type_or_None, success_bool). success is False only for
# transport / API errors (network, 403, 429, 5xx, timeout), NOT for a valid
# response that said the app is delisted. That distinction lets the caller
# short-circuit only on real failures.
def _fetch_type(app_id: str, timeout: int = 6) -> tuple[str | None, bool]:
    url = STEAM_APPDETAILS_URL.format(appid=app_id)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        # URL from hardcoded STEAM_APPDETAILS_URL + validated app_id
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        log(f"[steam-type] WARN: Steam appdetails fetch failed for {app_id}: {exc}")
        return None, False
    app_data = data.get(str(app_id), {})
    if not app_data.get("success"):
        return None, True  # valid response, app is delisted or region-locked
    t = app_data.get("data", {}).get("type")
    if isinstance(t, str) and t:
        return str(t).strip().lower(), True
    return None, True


def _load_cache(path: Path) -> dict[str, str | None]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[steam-type] WARN: could not load cache {path.name}: {exc}")
        return {}


# GetItems types we do not take. On 2026-10-29 the sweep tagged 29 retired
# but real games (Call of Duty: Modern Warfare 2 2009, Crysis Warhead, Dark
# Messiah) as "advertising" (store type 14), which would mislabel games that
# have Proton reports. Those apps keep their cached appdetails type, and new
# ones go through the appdetails fallback.
UNTRUSTED_SWEEP_TYPES = frozenset({"advertising"})


def _apply_sweep(cache: dict[str, str | None], sweep: dict | None, steam_ids: set[str]) -> tuple[int, int]:
    """Copy GetItems types into the cache. Returns (added, reclassified)."""
    if not sweep:
        return 0, 0
    added = reclassified = 0
    for app_id, item in sweep.get("items", {}).items():
        t = item.get("type")
        if not t or t in UNTRUSTED_SWEEP_TYPES or app_id not in steam_ids:
            continue
        old = cache.get(app_id)
        if old == t:
            continue
        if old:
            reclassified += 1
        else:
            added += 1
        cache[app_id] = t
    return added, reclassified


def enrich_search_index_with_steam_type(output_dir: Path, sweep: dict | None = None) -> None:
    """Fetch missing Steam app types and write the type as column 11 of
    search-index.json.

    Non-game types (movie / music / series / episode / hardware) are
    written back too so the frontend can filter them out; downstream
    passes may choose to drop the entire row if the type is one of those.

    Re-emits search-index.json in place. Reads and writes
    steam-type-cache.json next to it.
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[steam-type] search-index.json missing, skipping enrichment")
        return

    try:
        entries = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[steam-type] WARN: could not read search-index.json: {exc}")
        return
    if not isinstance(entries, list) or not entries:
        return

    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    steam_idxs: list[int] = []
    for i, row in enumerate(entries):
        if not isinstance(row, list) or len(row) < 1:
            continue
        app_id = str(row[0])
        if not app_id.isdigit():
            continue
        steam_idxs.append(i)

    added, reclassified = _apply_sweep(cache, sweep, {str(entries[i][0]) for i in steam_idxs})
    if sweep is not None:
        log(f"[steam-type] GetItems sweep: {added} types added, {reclassified} reclassified "
            f"({sweep.get('checked', 0)} answered, {sweep.get('unknown', 0)} unknown)")
    # Not in cache at all. A cached None is a valid negative (delisted /
    # region-locked) and is not re-probed; the sweep above already filled
    # any of those GetItems can now answer.
    needs_fetch = [str(entries[i][0]) for i in steam_idxs if str(entries[i][0]) not in cache]
    log(
        f"[steam-type] {len(steam_idxs)} Steam entries in search-index, "
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
        t, ok = _fetch_type(app_id)
        if not ok:
            consecutive_failures += 1
        else:
            consecutive_failures = 0
            cache[app_id] = t  # None here means "delisted", valid negative
        fetched += 1
        if t:
            log(f"[steam-type] {app_id} -> {t}")
        # Persist mid-run so a wall-clock bail or SIGTERM does not lose
        # everything we just fetched.
        if fetched % CACHE_SAVE_EVERY == 0:
            cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
        time.sleep(REQUEST_DELAY)

    if bail_reason:
        log(f"[steam-type] bailing early: {bail_reason} (probed {fetched} of {min(len(needs_fetch), PROBE_CAP)})")

    if fetched or added or reclassified:
        cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
        log(f"[steam-type] wrote cache ({len(cache)} entries) to {cache_path.name}")

    # Write the type into column 11 for every Steam row that has a cached
    # value. Pad rows to 12 columns first so column 11 lands at the
    # expected index regardless of whether earlier enrichers padded already.
    updated = 0
    for i in steam_idxs:
        app_id = str(entries[i][0])
        t = cache.get(app_id)
        if not t:
            continue
        row = entries[i]
        while len(row) < 12:
            row.append(None)
        row[11] = t
        updated += 1

    if updated:
        index_path.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
        log(f"[steam-type] populated type on {updated} Steam entries in search-index.json")
