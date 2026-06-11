"""Generate game-images.json: correct Steam header image URLs for games where
the standard /header.jpg path is hashed (newer Steam releases).

The front-end STEAM_IMG() function generates the non-hashed URL which works
for older games but 404s for titles released after Steam started requiring
per-asset hashes. This pipeline step fetches the real URL from the Steam store
API (server-side, no CORS issue) and writes a small lookup map.

Covers: all games in most_played.json + all Pulse report app IDs from Supabase.
"""

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from .common import log
from .pulse import fetch_pulse_rows

STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={appid}&filters=basic"
REQUEST_DELAY = 0.3  # seconds between Steam API calls to avoid rate limiting


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


def _collect_app_ids(output_dir: Path) -> list[str]:
    """Return unique app IDs from most_played.json + Supabase pulse reports."""
    ids: set[str] = set()

    most_played_path = output_dir / "most_played.json"
    if most_played_path.exists():
        try:
            entries = json.loads(most_played_path.read_text(encoding="utf-8"))
            for entry in entries:
                app_id = str(entry.get("appId", "")).strip()
                if app_id.isdigit():
                    ids.add(app_id)
        except Exception as exc:
            log(f"[game-images] WARN: could not read most_played.json: {exc}")

    try:
        rows = fetch_pulse_rows(limit=500)
        for row in rows:
            app_id = str(row.get("app_id", "")).strip()
            if app_id.isdigit():
                ids.add(app_id)
    except Exception as exc:
        log(f"[game-images] WARN: could not fetch Supabase pulse rows: {exc}")

    return sorted(ids, key=lambda x: int(x))


def build_game_images(output_dir) -> dict[str, str]:
    """Write <output_dir>/game-images.json and return the map written.

    Only stores URLs for games where the standard header.jpg path 404s.
    Games with working standard URLs are omitted to keep the file small.
    """
    output_dir = Path(output_dir)
    app_ids = _collect_app_ids(output_dir)
    log(f"[game-images] Checking {len(app_ids)} app IDs for hashed image URLs")

    result: dict[str, str] = {}
    for app_id in app_ids:
        standard_url = _standard_header_url(app_id)
        if _url_is_ok(standard_url):
            log(f"[game-images] {app_id}: standard URL ok, skipping", debug=True)
            continue
        log(f"[game-images] {app_id}: standard URL 404, fetching from Steam API")
        real_url = _fetch_steam_header(app_id)
        if real_url:
            # Strip the query string timestamp - URL works without it
            result[app_id] = real_url.split("?")[0]
            log(f"[game-images] {app_id}: resolved to {result[app_id]}")
        else:
            log(f"[game-images] {app_id}: no header image found via Steam API")
        time.sleep(REQUEST_DELAY)

    out_path = output_dir / "game-images.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    log(f"[game-images] wrote {len(result)} override URL(s) to {out_path}")
    return result
