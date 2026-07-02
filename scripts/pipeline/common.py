import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib import request


DEBUG = False
DEFAULT_STEAM_TITLE_CACHE_PATH = Path(__file__).resolve().parents[2] / ".cache" / "steam-title-cache.json"
STEAM_TITLE_CACHE_MAX_AGE_SECONDS = 30 * 86400  # 30 days

# Steam content descriptor cache -- keeps the { app_id -> descriptor_ids }
# mapping so we don't re-hit appdetails on every pipeline run.
DEFAULT_STEAM_DESCRIPTORS_CACHE_PATH = Path(__file__).resolve().parents[2] / ".cache" / "steam-content-descriptors-cache.json"
STEAM_DESCRIPTORS_CACHE_MAX_AGE_SECONDS = 30 * 86400  # 30 days
# Steam descriptor IDs that flag a game as adult-only for our purposes.
# Reference: https://partner.steamgames.com/doc/store/community_engagement/content_descriptors
# 1 = Some Nudity or Sexual Content
# 2 = Frequent Violence or Gore              (NOT filtered -- most action games)
# 3 = Adult Only Sexual Content              (porn / VN games)
# 4 = Frequent Nudity or Sexual Content
# 5 = General Mature Content                 (NOT filtered -- CS2, DBD, Rust, etc.)
ADULT_DESCRIPTOR_IDS = {1, 3, 4}

# In-memory Steam title cache (loaded once per run)
_steam_title_cache: dict[str, dict] | None = None
_steam_title_cache_dirty = False
# In-memory Steam content descriptor cache
_steam_descriptors_cache: dict[str, dict] | None = None
_steam_descriptors_cache_dirty = False
LIVE_COUNTS_URL = "https://www.protondb.com/data/counts.json"
LIVE_REPORTS_URL = "https://www.protondb.com/data/reports/{device}/app/{hash}.json"
LIVE_REPORT_DEVICE = "all-devices"
LIVE_REPORT_HASH_DEVICE = "any"
STEAM_APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={app_id}"
STEAM_STORE_PAGE_URL = "https://store.steampowered.com/app/{app_id}"
STEAM_INVALID_TITLES = {"eemmmpty"}
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


def _scrape_steam_store_title(app_id: str) -> str:
    """Scrape the Steam store page for the app name when the API returns empty."""
    import re

    try:
        req = request.Request(
            STEAM_STORE_PAGE_URL.format(app_id=app_id),
            headers={"Cookie": "birthtime=0; wants_mature_content=1"},
        )
        with request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        match = re.search(r'class="apphub_AppName"[^>]*>([^<]+)<', html)
        if match:
            title = match.group(1).strip()
            if title and title.lower() not in STEAM_INVALID_TITLES:
                return title
    except Exception:
        pass
    return ""


def _load_steam_title_cache(
    cache_path: Path = DEFAULT_STEAM_TITLE_CACHE_PATH,
) -> dict[str, dict]:
    """Load the persistent Steam title cache from disk."""
    global _steam_title_cache
    if _steam_title_cache is not None:
        return _steam_title_cache
    if cache_path.exists():
        try:
            raw = json.loads(cache_path.read_text())
            if isinstance(raw, dict):
                _steam_title_cache = raw
                log(f"[steam-title-cache] Loaded {len(raw):,} entries from {cache_path}")
                return _steam_title_cache
        except (json.JSONDecodeError, OSError):
            pass
    _steam_title_cache = {}
    return _steam_title_cache


def _save_steam_title_cache(
    cache_path: Path = DEFAULT_STEAM_TITLE_CACHE_PATH,
) -> None:
    """Persist the Steam title cache to disk if dirty."""
    global _steam_title_cache_dirty
    if not _steam_title_cache_dirty or _steam_title_cache is None:
        return
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(_steam_title_cache))
    _steam_title_cache_dirty = False
    log(f"[steam-title-cache] Saved {len(_steam_title_cache):,} entries to {cache_path}")


def flush_steam_title_cache(
    cache_path: Path = DEFAULT_STEAM_TITLE_CACHE_PATH,
) -> None:
    """Public flush for callers to persist cache at end of pipeline."""
    _save_steam_title_cache(cache_path)


def fetch_steam_title_with_source(app_id: str) -> tuple[str, str]:
    global _steam_title_cache_dirty
    cache = _load_steam_title_cache()
    now = int(time.time())

    # Check cache first
    cached = cache.get(app_id)
    if cached and isinstance(cached, dict):
        age = now - cached.get("ts", 0)
        if age < STEAM_TITLE_CACHE_MAX_AGE_SECONDS:
            title = cached.get("title", "")
            source = cached.get("source", "steam-title-cache")
            if title:
                return title, "steam-title-cache"
            # Negative cache: we tried and got nothing, don't retry for a while
            return "", source

    # Cache miss -- fetch from Steam
    try:
        data = fetch_json(STEAM_APP_DETAILS_URL.format(app_id=app_id))
        app_data = (data or {}).get(str(app_id), {})
        if app_data.get("success"):
            title = app_data.get("data", {}).get("name", "")
            if isinstance(title, str) and title.strip():
                cache[app_id] = {"title": title.strip(), "source": "steam-store", "ts": now}
                _steam_title_cache_dirty = True
                return title.strip(), "steam-store"
            scraped = _scrape_steam_store_title(app_id)
            if scraped:
                cache[app_id] = {"title": scraped, "source": "steam-store-scrape", "ts": now}
                _steam_title_cache_dirty = True
                return scraped, "steam-store-scrape"
            cache[app_id] = {"title": "", "source": "steam-store-empty-name", "ts": now}
            _steam_title_cache_dirty = True
            return "", "steam-store-empty-name"
        cache[app_id] = {"title": "", "source": "steam-store-unsuccessful", "ts": now}
        _steam_title_cache_dirty = True
        return "", "steam-store-unsuccessful"
    except Exception:
        cache[app_id] = {"title": "", "source": "steam-store-error", "ts": now}
        _steam_title_cache_dirty = True
        return "", "steam-store-error"


def _load_steam_descriptors_cache(
    cache_path: Path = DEFAULT_STEAM_DESCRIPTORS_CACHE_PATH,
) -> dict[str, dict]:
    """Load the persistent Steam content-descriptor cache from disk."""
    global _steam_descriptors_cache
    if _steam_descriptors_cache is not None:
        return _steam_descriptors_cache
    if cache_path.exists():
        try:
            raw = json.loads(cache_path.read_text())
            if isinstance(raw, dict):
                _steam_descriptors_cache = raw
                log(f"[steam-descriptors-cache] Loaded {len(raw):,} entries from {cache_path}")
                return _steam_descriptors_cache
        except (json.JSONDecodeError, OSError):
            pass
    _steam_descriptors_cache = {}
    return _steam_descriptors_cache


def _save_steam_descriptors_cache(
    cache_path: Path = DEFAULT_STEAM_DESCRIPTORS_CACHE_PATH,
) -> None:
    global _steam_descriptors_cache_dirty
    if not _steam_descriptors_cache_dirty or _steam_descriptors_cache is None:
        return
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(_steam_descriptors_cache))
    _steam_descriptors_cache_dirty = False
    log(f"[steam-descriptors-cache] Saved {len(_steam_descriptors_cache):,} entries to {cache_path}")


def flush_steam_descriptors_cache(
    cache_path: Path = DEFAULT_STEAM_DESCRIPTORS_CACHE_PATH,
) -> None:
    _save_steam_descriptors_cache(cache_path)


def fetch_steam_content_descriptors(app_id: str) -> list[int]:
    """Return Steam content-descriptor ids for an app, cached on disk.

    Descriptor list comes from the same appdetails endpoint the title
    fetcher uses. Empty list on miss / unsuccessful response so callers
    can safely treat "no data" as "no flags". The result is cached for
    STEAM_DESCRIPTORS_CACHE_MAX_AGE_SECONDS (30 days) so pipeline reruns
    only pay the Steam API cost for new / expired entries.
    """
    global _steam_descriptors_cache_dirty
    cache = _load_steam_descriptors_cache()
    now = int(time.time())

    cached = cache.get(app_id)
    if cached and isinstance(cached, dict):
        age = now - cached.get("ts", 0)
        if age < STEAM_DESCRIPTORS_CACHE_MAX_AGE_SECONDS:
            ids = cached.get("ids", [])
            return list(ids) if isinstance(ids, list) else []

    try:
        data = fetch_json(STEAM_APP_DETAILS_URL.format(app_id=app_id))
        app_data = (data or {}).get(str(app_id), {})
        if app_data.get("success"):
            descriptors = app_data.get("data", {}).get("content_descriptors", {}) or {}
            raw_ids = descriptors.get("ids", []) or []
            ids = [int(i) for i in raw_ids if isinstance(i, (int, float)) and not isinstance(i, bool)]
            cache[app_id] = {"ids": ids, "ts": now}
            _steam_descriptors_cache_dirty = True
            return ids
        cache[app_id] = {"ids": [], "ts": now}
        _steam_descriptors_cache_dirty = True
        return []
    except Exception:
        cache[app_id] = {"ids": [], "ts": now}
        _steam_descriptors_cache_dirty = True
        return []


def is_adult_app(app_id: str) -> bool:
    """True when Steam flags the app with any ADULT_DESCRIPTOR_IDS."""
    ids = fetch_steam_content_descriptors(app_id)
    return bool(set(ids) & ADULT_DESCRIPTOR_IDS)


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
            if json_file.stem in {"index", "latest", "votes", "metadata"}:
                continue
            count += 1
    return count


# Non-Steam app ID helpers

def app_id_to_dir(app_id: str) -> str:
    """Convert canonical app_id (e.g. 'gog:123') to filesystem-safe directory name."""
    return app_id.replace(":", "_")


def dir_to_app_id(dir_name: str) -> str:
    """Convert filesystem directory name back to canonical app_id."""
    if dir_name.startswith("gog_") and dir_name[4:].isdigit():
        return "gog:" + dir_name[4:]
    if dir_name.startswith("epic_"):
        return "epic:" + dir_name[5:]
    return dir_name


def app_type_from_id(app_id: str) -> str:
    """Derive store type string from app_id prefix."""
    if app_id.startswith("gog:"):
        return "gog"
    if app_id.startswith("epic:"):
        return "epic"
    return "steam"


def is_valid_app_id(app_id: str) -> bool:
    """Return True for Steam (digit) IDs and known non-Steam prefixes."""
    return app_id.isdigit() or app_id.startswith("gog:") or app_id.startswith("epic:")
