"""Which Steam games ship a native Linux build (#241).

Publishes native-linux.json so the home page can offer an "Exclude native"
filter, the same small-map pattern as anti-cheat.json (#242):

    {"generated_at": ..., "source": "IStoreBrowseService/GetItems",
     "checked": 33100, "unknown": 230, "native": ["10", "570", ...]}

Source: Steam's public IStoreBrowseService/GetItems with
data_request.include_platforms. It takes many app ids per request and needs
no key. A native Linux build shows as platforms.steamos_linux = true; the key
is absent otherwise. Verified 2026-10-28 (Dota 2 and CS2 native, ELDEN RING
and Cyberpunk 2077 not). Storefront appdetails with filters=basic (what the
type enricher calls) leaves platforms out, so there was no cache to reuse.

200 ids per request keeps the GET under Steam's URL limit (300 returned
414). ~33k Steam ids is ~170 requests, about a minute.

The same request carries each app's store type, so one sweep
(store_sweep) feeds both this file and the steam_type enricher (#261):
finalize runs it once and hands the result to both steps.

Failures degrade visibly: a batch that still fails after retries leaves its
games unknown (never hidden), counted in "unknown" and logged. If every
batch fails the file is still written with checked = 0 and an "error", so
the deploy keeps the file and the page can hide the filter instead of
acting on bad data.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

from .common import log

GETITEMS_URL = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/"
BATCH_SIZE = 200
REQUEST_TIMEOUT = 20
REQUEST_DELAY_SEC = 0.5
RETRIES = 2
OUTPUT_FILENAME = "native-linux.json"
SOURCE_LABEL = "IStoreBrowseService/GetItems"


def _getitems_url(app_ids: list[int]) -> str:
    payload = {
        "ids": [{"appid": i} for i in app_ids],
        "context": {"language": "english", "country_code": "US"},
        "data_request": {"include_platforms": True},
    }
    query = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    return f"{GETITEMS_URL}?input_json={query}"


def _fetch_batch(app_ids: list[int], opener: Callable = urllib.request.urlopen) -> list[dict]:
    """One GetItems call. Raises on HTTP / network / parse errors."""
    req = urllib.request.Request(
        _getitems_url(app_ids), headers={"User-Agent": "proton-pulse-pipeline"}
    )
    with opener(req, timeout=REQUEST_TIMEOUT) as resp:
        data = json.loads(resp.read())
    items = (data.get("response") or {}).get("store_items")
    if not isinstance(items, list):
        raise ValueError("GetItems response has no store_items list")
    return items


# EStoreAppType from Steam's store protobufs, mapped to the strings the
# steam-type cache already uses (appdetails' `type` vocabulary). Verified
# 2026-10-29 against 2,144 cached apps: 99.5% agree with appdetails; the rest
# were tools appdetails labels "game" that GetItems calls software (e.g.
# Wallpaper Engine) and one advertising entry.
STORE_APP_TYPES = {
    0: "game", 1: "demo", 2: "mod", 3: "movie", 4: "dlc", 5: "guide",
    6: "software", 7: "video", 8: "series", 9: "episode", 10: "hardware",
    11: "music", 12: "beta", 13: "tool", 14: "advertising",
}


def store_sweep(
    app_ids: Iterable[int],
    fetch: Callable[[list[int]], list[dict]] = _fetch_batch,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """One GetItems pass over app_ids.

    Returns {"items": {appid: {"type": str | None, "native": bool}},
    "checked": int, "unknown": int, "failed_batches": int, "error": str | None}.
    items only holds apps Steam answered for (success == 1); everything else
    is unknown. A type number outside STORE_APP_TYPES maps to None.
    """
    ids = sorted({int(i) for i in app_ids})
    items: dict[str, dict] = {}
    failed_batches = 0
    last_error: str | None = None
    for start in range(0, len(ids), BATCH_SIZE):
        batch = ids[start:start + BATCH_SIZE]
        got = None
        for attempt in range(RETRIES + 1):
            try:
                got = fetch(batch)
                break
            except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt < RETRIES:
                    sleep(2 ** attempt)
        if got is None:
            failed_batches += 1
            log(f"[steam-platforms] WARN: batch at {start} failed after {RETRIES + 1} tries ({last_error}); "
                f"{len(batch)} apps left unknown")
            continue
        for item in got:
            if item.get("success") != 1 or item.get("appid") is None:
                continue
            items[str(item["appid"])] = {
                "type": STORE_APP_TYPES.get(item.get("type")),
                "native": (item.get("platforms") or {}).get("steamos_linux") is True,
            }
        sleep(REQUEST_DELAY_SEC)
    return {
        "items": items,
        "checked": len(items),
        "unknown": len(ids) - len(items),
        "failed_batches": failed_batches,
        "error": last_error if failed_batches else None,
    }


def native_flags(
    app_ids: Iterable[int],
    fetch: Callable[[list[int]], list[dict]] = _fetch_batch,
    sleep: Callable[[float], None] = time.sleep,
    sweep: dict | None = None,
) -> dict:
    """Which app ids are native Linux, from a sweep (run one if not given).

    Returns {"native": set[str], "checked", "unknown", "failed_batches", "error"}.
    """
    result = sweep if sweep is not None else store_sweep(app_ids, fetch=fetch, sleep=sleep)
    return {
        "native": {appid for appid, item in result["items"].items() if item["native"]},
        "checked": result["checked"],
        "unknown": result["unknown"],
        "failed_batches": result["failed_batches"],
        "error": result["error"],
    }


def steam_ids_in_index(output_dir: Path) -> list[int]:
    """Numeric Steam app ids in search-index.json."""
    rows = json.loads((output_dir / "search-index.json").read_text(encoding="utf-8"))
    return [int(r[0]) for r in rows if r and str(r[0]).isdigit()]


def build_native_linux(output_dir: Path, fetch: Callable[[list[int]], list[dict]] = _fetch_batch,
                       sleep: Callable[[float], None] = time.sleep, sweep: dict | None = None) -> dict:
    """Write native-linux.json for every Steam app id in search-index.json.

    Pass the finalize-wide store_sweep result to avoid a second GetItems pass.
    """
    steam_ids = steam_ids_in_index(output_dir)
    result = native_flags(steam_ids, fetch=fetch, sleep=sleep, sweep=sweep)
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SOURCE_LABEL,
        "checked": result["checked"],
        "unknown": result["unknown"],
        "native": sorted(result["native"], key=lambda s: (len(s), s)),
    }
    if result["checked"] == 0 and steam_ids:
        payload["error"] = result["error"] or "no app ids answered"
        log(f"[steam-platforms] WARN: Steam answered for no apps ({payload['error']}); "
            f"publishing checked=0 so the page hides the filter")
    (output_dir / OUTPUT_FILENAME).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    log(f"[steam-platforms] {len(result['native'])} native of {result['checked']} checked "
        f"({result['unknown']} unknown, {result['failed_batches']} failed batches) -> {OUTPUT_FILENAME}")
    return payload
