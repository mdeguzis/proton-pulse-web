"""Build most_played.json: Steam's most-played games, focused on Proton.

Steam's GetMostPlayedGames returns the current top titles ranked by players,
each with a peak_in_game count. We keep the ones we have compatibility data for
and attach their overall tier from search-index.json, so the homepage can show
"Popular games on Steam" with each game's Proton rating.

Games with a known compatibility tier (platinum/gold/silver/bronze/borked) fill
the first section. Games that appear in Steam charts but have no rated reports
yet are collected separately with rating="pending", so the homepage can offer a
"Not rated yet" toggle pointing contributors at popular untested games.

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


def _last_report_date(data_dir: Path, app_id: str) -> str | None:
    """Return ISO date (YYYY-MM-DD) of the most recent report for app_id, or None."""
    from datetime import datetime, timezone
    app_dir = data_dir / app_id
    if not app_dir.is_dir():
        return None
    year_files = sorted(
        (f for f in app_dir.glob("*.json") if f.stem not in {"latest", "index", "votes", "metadata"}),
        key=lambda p: p.stem,
    )
    if not year_files:
        return None
    try:
        rows = json.loads(year_files[-1].read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            return None
        latest_ts = max((int(r.get("timestamp", 0)) for r in rows if r.get("timestamp")), default=0)
        if not latest_ts:
            return None
        return datetime.fromtimestamp(latest_ts, tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return None


def build_most_played(
    output_dir,
    limit: int = 100,
    unrated_limit: int = 50,
    ranks: list[dict] | None = None,
) -> list[dict]:
    """Write <output_dir>/most_played.json and return the rows written.

    Takes Steam's most-played list (rank order) and produces two buckets:
    - Rated games (tier in KNOWN_TIERS): up to ``limit`` rows, rank order.
    - Unrated games (tier == "pending", i.e. in our index but no rated reports):
      up to ``unrated_limit`` rows, appended after the rated section.

    Games not in our search-index at all are skipped (no title available).
    ``ranks`` can be injected for testing.

    Shape: [{appId, title, peak, rating, protondbCount, pulseCount, lastReportDate, headerImage}]
    """
    output_dir = Path(output_dir)
    data_dir = output_dir / "data"
    index = load_search_index(output_dir)
    if ranks is None:
        ranks = fetch_most_played()

    rated: list[dict] = []
    unrated: list[dict] = []
    for entry in ranks:
        if len(rated) >= limit and len(unrated) >= unrated_limit:
            break
        app_id = str(entry.get("appid"))
        match = index.get(app_id)
        if not match:
            continue  # no title in our index, skip
        title, tier, protondb_count, pulse_count = match
        peak = entry.get("peak_in_game")
        row = {
            "appId": int(app_id),
            "title": title,
            "peak": int(peak) if isinstance(peak, int) else None,
            "rating": tier,
            "protondbCount": protondb_count,
            "pulseCount": pulse_count,
            "lastReportDate": _last_report_date(data_dir, app_id),
            "headerImage": None,  # filled in by game_images.build_game_images after this step
        }
        if tier in KNOWN_TIERS and len(rated) < limit:
            rated.append(row)
        elif tier == "pending" and len(unrated) < unrated_limit:
            unrated.append(row)

    result = rated + unrated
    out_path = output_dir / "most_played.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    log(f"[most-played] wrote {len(rated)} rated + {len(unrated)} unrated game(s) to {out_path}")
    return result
