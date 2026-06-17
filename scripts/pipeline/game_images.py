"""Generate game-images.json: correct Steam header image URLs for games where
the standard /header.jpg path is hashed (newer Steam releases).

The front-end STEAM_IMG() function generates the non-hashed URL which works
for older games but 404s for titles released after Steam started requiring
per-asset hashes. This pipeline step fetches the real URL from the Steam store
API (server-side, no CORS issue) and writes a small lookup map.

Covers: ALL app IDs found in the data/ directory, with two persistent caches:
  - game-images.json: IDs where standard URL 404s, mapped to the real URL.
  - game-images-skip.json: IDs where the standard URL is confirmed OK.

Daily runs probe only uncached IDs (cap: PROBE_CAP per run) so the full
backfill completes incrementally without timing out in CI.
"""

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from .common import log

STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={appid}&filters=basic"
REQUEST_DELAY = 0.3  # seconds between Steam API calls to avoid rate limiting
PROBE_CAP = 500      # max new IDs to probe per pipeline run


def _standard_header_url(app_id: str) -> str:
    return f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{app_id}/header.jpg"


def _url_is_ok(url: str, timeout: int = 8) -> bool:
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _fetch_steam_header(app_id: str, timeout: int = 10) -> str | None:
    url = STEAM_APPDETAILS_URL.format(appid=app_id)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        app_data = data.get(str(app_id), {})
        if not app_data.get("success"):
            return None
        return app_data.get("data", {}).get("header_image") or None
    except Exception as exc:
        log(f"[game-images] WARN: Steam appdetails fetch failed for {app_id}: {exc}")
        return None


def _collect_all_app_ids(data_dir: Path) -> list[str]:
    """Return all numeric app IDs found as subdirectories under data_dir."""
    ids: set[str] = set()
    if data_dir.is_dir():
        for entry in data_dir.iterdir():
            if entry.is_dir() and entry.name.isdigit():
                ids.add(entry.name)
    return sorted(ids, key=lambda x: int(x))


def _load_json_map(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            log(f"[game-images] WARN: could not load {path.name}: {exc}")
    return {}


def _hot_app_ids(output_dir: Path) -> list[str]:
    """Return app IDs visible to users right now: recent-reports + most_played."""
    ids: list[str] = []
    for fname in ("recent-reports.json", "most_played.json"):
        p = output_dir / fname
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            for entry in data:
                aid = str(entry.get("appId", entry.get("app_id", ""))).strip()
                if aid.isdigit():
                    ids.append(aid)
        except Exception as exc:
            log(f"[game-images] WARN: could not read {fname}: {exc}")
    seen: set[str] = set()
    deduped: list[str] = []
    for aid in ids:
        if aid not in seen:
            seen.add(aid)
            deduped.append(aid)
    return deduped


def build_game_images(output_dir) -> dict[str, str]:
    """Write game-images.json and game-images-skip.json, return the overrides map.

    game-images.json  -- app IDs where standard URL 404s, mapped to real URL.
    game-images-skip.json -- app IDs where standard URL is confirmed OK.

    Visible games (recent-reports + most_played) are always probed first so
    newly released high-ID games don't wait months in the numeric backlog.
    Remaining uncached IDs are appended up to PROBE_CAP per run.
    """
    output_dir = Path(output_dir)
    data_dir = output_dir / "data"

    overrides_path = output_dir / "game-images.json"
    skip_path = output_dir / "game-images-skip.json"

    overrides: dict[str, str] = _load_json_map(overrides_path)
    skip_set: set[str] = set(_load_json_map(skip_path).get("ids", []))

    all_ids = _collect_all_app_ids(data_dir)
    cached = set(overrides.keys()) | skip_set

    hot = [a for a in _hot_app_ids(output_dir) if a not in cached]
    hot_set = set(hot)
    rest = [a for a in all_ids if a not in cached and a not in hot_set]
    to_probe = hot + rest

    log(
        f"[game-images] {len(all_ids)} total app IDs | "
        f"{len(overrides)} override cache | {len(skip_set)} skip cache | "
        f"{len(hot)} hot uncached (all will probe) | {len(rest)} backlog uncached (cap {PROBE_CAP})"
    )

    probed = 0  # total for logging
    backlog_probed = 0
    for app_id in to_probe:
        is_backlog = app_id not in hot_set
        if is_backlog and backlog_probed >= PROBE_CAP:
            log(f"[game-images] hit backlog cap ({PROBE_CAP}), deferring {len(rest) - backlog_probed} to next run")
            break
        standard_url = _standard_header_url(app_id)
        if _url_is_ok(standard_url):
            log(f"[game-images] {app_id}: standard URL ok", debug=True)
            skip_set.add(app_id)
        else:
            log(f"[game-images] {app_id}: standard URL 404, fetching from Steam API")
            real_url = _fetch_steam_header(app_id)
            if real_url:
                overrides[app_id] = real_url.split("?")[0]
                log(f"[game-images] {app_id}: resolved to {overrides[app_id]}")
            else:
                log(f"[game-images] {app_id}: no header image found via Steam API, marking skip")
                skip_set.add(app_id)
        probed += 1
        if is_backlog:
            backlog_probed += 1
        time.sleep(REQUEST_DELAY)

    overrides_path.write_text(json.dumps(overrides, indent=2) + "\n", encoding="utf-8")
    log(f"[game-images] wrote {len(overrides)} override URL(s) to {overrides_path}")

    skip_path.write_text(
        json.dumps({"ids": sorted(skip_set, key=lambda x: int(x) if x.isdigit() else 0)}, indent=2) + "\n",
        encoding="utf-8",
    )
    log(f"[game-images] wrote {len(skip_set)} skip-cache entries to {skip_path}")

    return overrides
