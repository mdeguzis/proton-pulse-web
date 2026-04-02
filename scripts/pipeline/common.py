import json
import subprocess
import sys
from pathlib import Path
from urllib import request


DEBUG = False
LIVE_COUNTS_URL = "https://www.protondb.com/data/counts.json"
LIVE_REPORTS_URL = "https://www.protondb.com/data/reports/{device}/app/{hash}.json"
LIVE_REPORT_DEVICE = "all-devices"
BACKFILL_MANIFEST_PATH = Path(__file__).resolve().parents[2] / "config" / "live_backfill_app_ids.json"


def set_debug(enabled: bool) -> None:
    global DEBUG
    DEBUG = enabled


def log(msg, debug=False):
    """Flush-safe print for CI environments. Skipped if debug=True and DEBUG is off."""
    if debug and not DEBUG:
        return
    print(msg, flush=True)


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


def fetch_json(url: str):
    with request.urlopen(url) as response:
        return json.load(response)


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
