import json
import subprocess
import sys
from pathlib import Path
from urllib import request


DEBUG = False
LIVE_COUNTS_URL = "https://www.protondb.com/data/counts.json"
LIVE_REPORTS_URL = "https://www.protondb.com/data/reports/{device}/app/{hash}.json"
LIVE_REPORT_DEVICE = "all-devices"
LIVE_REPORT_HASH_DEVICE = "any"
STEAM_APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={app_id}"
BACKFILL_MANIFEST_PATH = Path(__file__).resolve().parents[2] / "config" / "live_backfill_app_ids.json"


def set_debug(enabled: bool) -> None:
    global DEBUG
    DEBUG = enabled


def log(msg, debug=False):
    """Flush-safe log to stderr for CI environments. Skipped if debug=True and DEBUG is off."""
    if debug and not DEBUG:
        return
    # stderr so we dont corrupt stdout when its redirected to capture JSON
    print(msg, file=sys.stderr, flush=True)


def clone_repo(url, target_dir):
    log(f"[clone] Cloning {url} -> {target_dir}", debug=True)
    result = subprocess.run(
        ["git", "clone", "--depth=1", url, target_dir],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        log(f"!! git clone failed:\n{result.stderr}")
        sys.exit(1)
    log("[clone] Clone complete.", debug=True)


def fetch_json(url: str, retries: int = 3):
    for attempt in range(retries):
        try:
            with request.urlopen(url) as response:
                data = response.read()
                return json.loads(data)
        except Exception:
            if attempt == retries - 1:
                raise


def fetch_steam_title(app_id: str) -> str:
    title, _source = fetch_steam_title_with_source(app_id)
    return title


def fetch_steam_title_with_source(app_id: str) -> tuple[str, str]:
    try:
        data = fetch_json(STEAM_APP_DETAILS_URL.format(app_id=app_id))
        app_data = (data or {}).get(str(app_id), {})
        if app_data.get("success"):
            title = app_data.get("data", {}).get("name", "")
            if isinstance(title, str) and title.strip():
                return title.strip(), "steam-store"
            return "", "steam-store-empty-name"
        return "", "steam-store-unsuccessful"
    except Exception:
        return "", "steam-store-error"


def normalize_whitespace(value):
    return value.strip() if isinstance(value, str) else ""


def infer_duration(playtime_minutes):
    if not playtime_minutes or playtime_minutes <= 0:
        return "unreported"
    if playtime_minutes < 60:
        return "underOneHour"
    if playtime_minutes < 240:
        return "oneToFourHours"
    if playtime_minutes < 900:
        return "severalHours"
    return "allTheTime"


def count_year_bucket_files(data_output_path: Path) -> int:
    count = 0
    for app_dir in data_output_path.iterdir():
        if not app_dir.is_dir():
            continue
        for json_file in app_dir.glob("*.json"):
            if json_file.stem in {"index", "latest", "votes"}:
                continue
            count += 1
    return count
