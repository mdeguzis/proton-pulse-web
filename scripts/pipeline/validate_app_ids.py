"""Validate Steam app IDs by following store page redirects.

Detects:
  - Dead app IDs that redirect to the Steam homepage (removed/invalid)
  - Replaced app IDs that redirect to a different app (superseded entries)
  - Valid app IDs that resolve to their own store page

Output: app-id-redirects.json
  { "<original_id>": { "status": "replaced", "replaced_by": "<new_id>" },
    "<original_id>": { "status": "dead", "final_url": "..." },
    ... }

Only entries with problems are written (valid IDs are omitted to keep the file
small). The frontend and admin panel can use this to fix links and surface
warnings. A persistent cache (app-id-validation-cache.json) avoids re-probing
IDs that have already been checked.
"""

import json
import re
import time
import urllib.request
import urllib.error
from datetime import date, timedelta
from pathlib import Path

from .common import log

STEAM_STORE_URL = "https://store.steampowered.com/app/{app_id}/"
PROBE_CAP = 200
STALE_DAYS = 90
BATCH_DELAY = 0.35


def _follow_redirects(app_id: str) -> dict:
    """Follow redirects for a Steam store page and return the resolution."""
    url = STEAM_STORE_URL.format(app_id=app_id)
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; ProtonPulse/1.0)",
                "Cookie": "birthtime=0; wants_mature_content=1",
            },
        )
        opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler)
        resp = opener.open(req, timeout=15)
        final_url = resp.url
        resp.close()

        if f"/app/{app_id}" in final_url:
            return {"status": "valid"}

        app_match = re.search(r"/app/(\d+)", final_url)
        if app_match:
            new_id = app_match.group(1)
            if new_id != app_id:
                return {"status": "replaced", "replaced_by": new_id, "final_url": final_url}

        if "/app/" not in final_url:
            return {"status": "dead", "final_url": final_url}

        return {"status": "valid"}
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"status": "dead", "final_url": url, "http_status": 404}
        return {"status": "error", "http_status": e.code}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def _load_cache(output_dir: Path) -> dict:
    cache_path = output_dir / "app-id-validation-cache.json"
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception as exc:
            log(f"[validate-appids] WARN: could not load cache: {exc}")
    return {}


def _save_cache(output_dir: Path, cache: dict) -> None:
    cache_path = output_dir / "app-id-validation-cache.json"
    cache_path.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")


def _is_stale(entry: dict) -> bool:
    probed = entry.get("probed_at", "")
    if not probed:
        return True
    try:
        probed_date = date.fromisoformat(probed)
        return (date.today() - probed_date) > timedelta(days=STALE_DAYS)
    except ValueError:
        return True


def validate_steam_app_ids(output_dir: str) -> dict:
    """Validate Steam app IDs from the search index. Returns the redirect map."""
    output_path = Path(output_dir)
    search_index_path = output_path / "search-index.json"
    if not search_index_path.exists():
        log("[validate-appids] No search-index.json found, skipping")
        return {}

    index = json.loads(search_index_path.read_text(encoding="utf-8"))
    steam_ids = []
    for row in index:
        if not isinstance(row, list) or len(row) < 6:
            continue
        app_id = str(row[0])
        app_type = row[5] if len(row) > 5 else "steam"
        if app_type == "steam" and app_id.isdigit():
            steam_ids.append(app_id)

    cache = _load_cache(output_path)
    today = date.today().isoformat()

    to_probe = []
    for app_id in steam_ids:
        entry = cache.get(app_id)
        if entry is None or _is_stale(entry):
            to_probe.append(app_id)

    if not to_probe:
        log("[validate-appids] All app IDs cached and fresh, nothing to probe")
    else:
        capped = to_probe[:PROBE_CAP]
        log(f"[validate-appids] Probing {len(capped)}/{len(to_probe)} uncached/stale Steam app IDs")

        probed = 0
        for app_id in capped:
            result = _follow_redirects(app_id)
            result["probed_at"] = today
            cache[app_id] = result
            probed += 1
            if probed % 50 == 0:
                log(f"[validate-appids]   ...{probed}/{len(capped)} probed")
            if result.get("status") == "error":
                log(f"[validate-appids] WARN: error probing {app_id}: {result}")
            time.sleep(BATCH_DELAY)

        _save_cache(output_path, cache)
        log(f"[validate-appids] Probed {probed} app IDs, cache now has {len(cache)} entries")

    redirects = {}
    for app_id, entry in cache.items():
        status = entry.get("status")
        if status == "replaced":
            redirects[app_id] = {
                "status": "replaced",
                "replaced_by": entry["replaced_by"],
                "final_url": entry.get("final_url", ""),
            }
        elif status == "dead":
            redirects[app_id] = {
                "status": "dead",
                "final_url": entry.get("final_url", ""),
            }

    redirect_path = output_path / "app-id-redirects.json"
    redirect_path.write_text(
        json.dumps(redirects, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    replaced_count = sum(1 for v in redirects.values() if v["status"] == "replaced")
    dead_count = sum(1 for v in redirects.values() if v["status"] == "dead")
    log(f"[validate-appids] Results: {replaced_count} replaced, {dead_count} dead, written to app-id-redirects.json")

    return redirects
