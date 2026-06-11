"""Build most_played.json: Steam's most-played games, focused on Proton.

Steam's GetMostPlayedGames returns the current top titles ranked by players,
each with a peak_in_game count. We keep the ones we have compatibility data for
and attach their overall tier from search-index.json, so the homepage can show
"Popular games on Steam" with each game's Proton rating.

Steam APIs are not CORS-enabled, so this runs in the pipeline (server-side) and
emits a static most_played.json that the web UI fetches.
"""

import json
import urllib.error
import urllib.request
from pathlib import Path

from .common import log

STEAM_MOST_PLAYED_URL = (
    "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/"
)

# Tiers we treat as real compatibility ratings. Anything else (missing/unknown)
# is skipped so every row on the homepage carries a meaningful badge.
KNOWN_TIERS = {"platinum", "gold", "silver", "bronze", "borked"}


def fetch_most_played(timeout: int = 30) -> list[dict]:
    """Return the GetMostPlayedGames ranks list ([{rank, appid, peak_in_game}])."""
    req = urllib.request.Request(
        STEAM_MOST_PLAYED_URL, headers={"Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.load(resp)
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as exc:
        log(f"[most-played] WARN: Steam most-played fetch failed: {exc}")
        return []
    return payload.get("response", {}).get("ranks", [])


def load_search_index(output_dir: Path) -> dict[str, tuple[str, str, int, int]]:
    """Map app_id (str) -> (title, tier, protondb_count, pulse_count) from search-index.json.

    Rows are [app_id, title, tier, protondb_count, pulse_count].
    """
    path = Path(output_dir) / "search-index.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    index: dict[str, tuple[str, str, int, int]] = {}
    for row in rows:
        if not isinstance(row, list) or len(row) < 3:
            continue
        app_id = str(row[0])
        title = row[1] or ""
        tier = (row[2] or "").lower()
        protondb_count = int(row[3]) if len(row) > 3 and isinstance(row[3], int) else 0
        pulse_count = int(row[4]) if len(row) > 4 and isinstance(row[4], int) else 0
        index[app_id] = (title, tier, protondb_count, pulse_count)
    return index


def build_most_played(output_dir, limit: int = 15, ranks: list[dict] | None = None) -> list[dict]:
    """Write <output_dir>/most_played.json and return the rows written.

    Takes Steam's most-played list (rank order), keeps the games we have a real
    compatibility tier for, and emits the top ``limit`` as
    [{appId, title, peak, rating}]. ``ranks`` can be injected for testing.
    """
    output_dir = Path(output_dir)
    index = load_search_index(output_dir)
    if ranks is None:
        ranks = fetch_most_played()

    result: list[dict] = []
    for entry in ranks:
        app_id = str(entry.get("appid"))
        match = index.get(app_id)
        if not match:
            continue  # no compatibility data for this game
        title, tier, protondb_count, pulse_count = match
        if tier not in KNOWN_TIERS:
            continue  # skip untested / unknown so every row has a real badge
        peak = entry.get("peak_in_game")
        result.append({
            "appId": int(app_id),
            "title": title,
            "peak": int(peak) if isinstance(peak, int) else None,
            "rating": tier,
            "protondbCount": protondb_count,
            "pulseCount": pulse_count,
            "headerImage": None,  # filled in by game_images.build_game_images after this step
        })
        if len(result) >= limit:
            break

    out_path = output_dir / "most_played.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    log(f"[most-played] wrote {len(result)} game(s) to {out_path}")
    return result
