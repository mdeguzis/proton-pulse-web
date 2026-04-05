import importlib.util
import os
import time
import json
from pathlib import Path
from urllib.parse import urlencode

from .common import fetch_json, log


STEAM_API_KEY_ENV = "STEAM_API_KEY"
STEAM_APP_LIST_URL = "https://api.steampowered.com/IStoreService/GetAppList/v1/"
STEAM_APP_LIST_PAGE_SIZE = 50_000
STEAM_CATALOG_CACHE_MAX_AGE_SECONDS = 24 * 60 * 60
PROTONDB_SIGNAL_CACHE_MAX_AGE_SECONDS = 24 * 60 * 60
PROTONDB_COMPATIBILITY_REPORT_URL = "https://www.protondb.com/data/compatibility_report_with_games.json"
DEFAULT_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
DEFAULT_CACHE_PATH = Path(__file__).resolve().parents[2] / ".cache" / "steam-game-catalog.json"
DEFAULT_PROTONDB_SIGNAL_CACHE_PATH = Path(__file__).resolve().parents[2] / ".cache" / "protondb-signal-catalog.json"
VENDOR_SCRAPER_PATH = (
    Path(__file__).resolve().parents[2] / "vendor" / "Steam-Games-Scraper" / "SteamGamesScraper.py"
)


def _strip_wrapping_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def load_dotenv(path: Path | None = None) -> dict[str, str]:
    path = path or DEFAULT_ENV_PATH
    if not path.exists():
        return {}

    loaded: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = _strip_wrapping_quotes(value.strip())
        if key:
            loaded[key] = value
    return loaded


def get_steam_api_key(env: dict[str, str] | None = None) -> str | None:
    merged_env = {}
    merged_env.update(load_dotenv())
    merged_env.update(env if env is not None else os.environ)
    value = (merged_env.get(STEAM_API_KEY_ENV) or "").strip()
    return value or None


def build_steam_app_list_url(api_key: str, last_appid: int | None = None, max_results: int = STEAM_APP_LIST_PAGE_SIZE) -> str:
    params: dict[str, str | int | bool] = {
        "key": api_key,
        "include_games": "true",
        "include_dlc": "false",
        "include_software": "false",
        "include_videos": "false",
        "include_hardware": "false",
        "max_results": max_results,
    }
    if last_appid:
        params["last_appid"] = last_appid
    return f"{STEAM_APP_LIST_URL}?{urlencode(params)}"


def _coerce_app_id(raw_app: dict) -> str:
    app_id = raw_app.get("appid", raw_app.get("app_id", ""))
    return str(app_id).strip()


def _coerce_app_name(raw_app: dict) -> str:
    return str(raw_app.get("name", "")).strip()


def _read_cached_catalog(
    cache_path: Path,
    max_age_seconds: int,
    label: str,
) -> dict[str, str] | None:
    if not cache_path.exists():
        return None

    try:
        payload = json.loads(cache_path.read_text())
    except Exception:
        return None

    fetched_at = int(payload.get("fetched_at", 0))
    if fetched_at <= 0 or (time.time() - fetched_at) > max_age_seconds:
        return None

    apps = payload.get("apps", {})
    if not isinstance(apps, dict):
        return None

    catalog = {str(app_id): str(title) for app_id, title in apps.items() if str(app_id).isdigit()}
    if catalog:
        log(f"[{label}] Using cached catalog with {len(catalog):,} app IDs")
    return catalog or None


def _write_cached_catalog(catalog: dict[str, str], cache_path: Path) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "fetched_at": int(time.time()),
        "apps": catalog,
    }
    cache_path.write_text(json.dumps(payload, indent=2) + "\n")


def load_vendor_scraper_module(module_path: Path = VENDOR_SCRAPER_PATH):
    if not module_path.exists():
        raise FileNotFoundError(
            f"Steam-Games-Scraper submodule not found at {module_path}. "
            "Run: git submodule update --init --recursive"
        )

    spec = importlib.util.spec_from_file_location("steam_games_scraper_vendor", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load Steam-Games-Scraper module from {module_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fetch_steam_game_catalog(
    api_key: str,
    max_results: int = STEAM_APP_LIST_PAGE_SIZE,
    scraper_module=None,
) -> dict[str, str]:
    scraper = scraper_module or load_vendor_scraper_module()
    catalog: dict[str, str] = {}
    last_appid: int | None = None
    page = 0

    while True:
        page += 1
        parameters = {
            "key": api_key,
            "include_games": "true",
            "include_dlc": "false",
            "include_software": "false",
            "include_videos": "false",
            "include_hardware": "false",
            "max_results": max_results,
            "last_appid": last_appid or 0,
        }
        response_obj = scraper.DoRequest(STEAM_APP_LIST_URL, parameters)
        if response_obj is None:
            raise ValueError("Steam-Games-Scraper request returned no response")
        payload = response_obj.json()
        response = payload.get("response", payload) if isinstance(payload, dict) else {}
        apps = response.get("apps", []) if isinstance(response, dict) else []

        if not isinstance(apps, list):
            raise ValueError("Steam app list response missing apps array")

        added = 0
        for raw_app in apps:
            if not isinstance(raw_app, dict):
                continue
            app_id = _coerce_app_id(raw_app)
            if not app_id.isdigit():
                continue
            catalog[app_id] = _coerce_app_name(raw_app)
            added += 1

        log(f"[steam-catalog] page {page}: {added:,} app IDs", debug=True)

        have_more = bool(response.get("have_more_results"))
        next_last_appid = response.get("last_appid")
        if not have_more:
            break
        if next_last_appid in (None, "", last_appid):
            raise ValueError("Steam app list pagination did not advance")
        last_appid = int(next_last_appid)

    log(f"[steam-catalog] Loaded {len(catalog):,} app IDs from Steam")
    return catalog


def read_cached_steam_game_catalog(
    cache_path: Path = DEFAULT_CACHE_PATH,
    max_age_seconds: int = STEAM_CATALOG_CACHE_MAX_AGE_SECONDS,
) -> dict[str, str] | None:
    return _read_cached_catalog(cache_path, max_age_seconds, "steam-catalog")


def write_cached_steam_game_catalog(catalog: dict[str, str], cache_path: Path = DEFAULT_CACHE_PATH) -> None:
    _write_cached_catalog(catalog, cache_path)


def load_steam_game_catalog(
    api_key: str,
    cache_path: Path = DEFAULT_CACHE_PATH,
    max_results: int = STEAM_APP_LIST_PAGE_SIZE,
    scraper_module=None,
) -> dict[str, str]:
    cached = read_cached_steam_game_catalog(cache_path=cache_path)
    if cached is not None:
        return cached

    catalog = fetch_steam_game_catalog(api_key, max_results=max_results, scraper_module=scraper_module)
    write_cached_steam_game_catalog(catalog, cache_path=cache_path)
    return catalog


def fetch_protondb_signal_catalog(fetch_json_impl=fetch_json) -> dict[str, str]:
    payload = fetch_json_impl(PROTONDB_COMPATIBILITY_REPORT_URL)
    if not isinstance(payload, dict):
        raise ValueError("ProtonDB compatibility report payload must be an object")

    catalog: dict[str, str] = {}
    for section in payload.values():
        if not isinstance(section, dict):
            continue
        games = section.get("games", [])
        if not isinstance(games, list):
            continue
        for game in games:
            if not isinstance(game, dict):
                continue
            app_id = str(game.get("appId", "")).strip()
            if not app_id.isdigit():
                continue
            catalog[app_id] = str(game.get("title", "")).strip()

    log(f"[protondb-signal] Loaded {len(catalog):,} app IDs from ProtonDB signal export")
    return catalog


def read_cached_protondb_signal_catalog(
    cache_path: Path = DEFAULT_PROTONDB_SIGNAL_CACHE_PATH,
    max_age_seconds: int = PROTONDB_SIGNAL_CACHE_MAX_AGE_SECONDS,
) -> dict[str, str] | None:
    return _read_cached_catalog(cache_path, max_age_seconds, "protondb-signal")


def write_cached_protondb_signal_catalog(
    catalog: dict[str, str],
    cache_path: Path = DEFAULT_PROTONDB_SIGNAL_CACHE_PATH,
) -> None:
    _write_cached_catalog(catalog, cache_path)


def load_protondb_signal_catalog(
    fetch_json_impl=fetch_json,
    cache_path: Path = DEFAULT_PROTONDB_SIGNAL_CACHE_PATH,
) -> dict[str, str]:
    cached = read_cached_protondb_signal_catalog(cache_path=cache_path)
    if cached is not None:
        return cached

    catalog = fetch_protondb_signal_catalog(fetch_json_impl=fetch_json_impl)
    write_cached_protondb_signal_catalog(catalog, cache_path=cache_path)
    return catalog
