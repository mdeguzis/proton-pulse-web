"""Generate game-images.json: correct Steam header image URLs for games where
the standard /header.jpg path is hashed (newer Steam releases).

Uses a unified cache (game-images-cache.json) tracking status + probe date per app ID:
  - status "ok":      standard CDN URL works, no frontend override needed.
  - status "hashed":  standard URL 404s; real URL stored and written to game-images.json.
  - status "sgdb":    Steam APIs gave nothing usable; SteamGridDB has community
                      artwork instead. URL stored and written to game-images.json.
  - status "missing": Steam APIs AND SteamGridDB both gave nothing.

SteamGridDB is the last-resort fallback: we only ask it when the standard CDN
404s AND appdetails has no header (delisted / freshly missing apps). Rate limit
is 500 req/hour on the free tier; the fallback trigger keeps calls sparse.

Hot games (visible in recent-reports.json + most_played.json) are always probed
first and re-probed when their cache entry is older than STALE_DAYS. Backlog
entries (all other app IDs with ProtonDB data) are only probed when uncached,
capped at PROBE_CAP per run. Extended Steam catalog stubs (search-index-steam-
extended.json, ~140k store entries with no reports) sit at the tail of the
backlog so they trickle in over many runs without blowing Steam rate limits.

On first run after this format change, legacy game-images.json and
game-images-skip.json entries are migrated into the unified cache automatically.
"""

import json
import os
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from .common import log

# SteamGridDB API — free tier public artwork DB. Requires an API key set as
# the SGDB_API_KEY env var (mirrors the Supabase edge function secret used
# for the admin refetch button). If unset, we skip the SGDB fallback path
# entirely and just tag entries "missing" as before.
SGDB_API_KEY = os.environ.get("SGDB_API_KEY", "").strip()
SGDB_STEAM_LOOKUP = "https://www.steamgriddb.com/api/v2/games/steam/{appid}"
SGDB_GRIDS_URL    = "https://www.steamgriddb.com/api/v2/grids/game/{game_id}?dimensions=460x215&types=static"

# Admin overrides: box_art_overrides table on Supabase. Reads use the
# anon key -- the table's RLS grants SELECT to anon so the pipeline
# doesn't need a service role key. Empty envs => skip the fetch and
# proceed as before.
SUPABASE_URL      = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "").strip()

STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={appid}&filters=basic"
STEAM_STORE_PAGE_URL = "https://store.steampowered.com/app/{appid}/"
REQUEST_DELAY = 0.3       # seconds between Steam API calls
PROBE_CAP = 500           # max backlog IDs to probe per run (hot IDs are uncapped)
EXTENDED_STEAM_INDEX = "search-index-steam-extended.json"  # catalog stubs with no reports
STALE_DAYS = 30           # re-probe hot games whose cache entry is older than this
# A known-live Steam app used as a canary: if the store page redirects for THIS
# id during a run, Steam's storefront is wobbling and we must not flag anything
# as delisted. Half-Life 2 (220) has been continuously listed since 2004.
CANARY_APPID = "220"


def _standard_header_url(app_id: str) -> str:
    return f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{app_id}/header.jpg"


def _fetch_admin_overrides(timeout: int = 10) -> dict[str, dict]:
    """Fetch all rows from Supabase box_art_overrides via the anon REST API.

    Returns { app_id: {image_url, source, updated_at} }. Empty dict on any
    failure (missing env, HTTP error, bad JSON) -- the pipeline continues
    without overrides in that case, same as before overrides existed.
    """
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        log("[game-images] admin overrides: SUPABASE_URL/ANON_KEY unset, skipping fetch")
        return {}
    url = f"{SUPABASE_URL}/rest/v1/box_art_overrides?select=app_id,image_url,source,updated_at"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            rows = json.loads(r.read())
    except Exception as e:
        log(f"[game-images] admin overrides fetch failed: {e}")
        return {}
    if not isinstance(rows, list):
        log(f"[game-images] admin overrides fetch: unexpected shape {type(rows).__name__}")
        return {}
    out = {}
    for row in rows:
        aid = str(row.get("app_id") or "").strip()
        img = row.get("image_url")
        if aid and img:
            out[aid] = {"image_url": img, "source": row.get("source"), "updated_at": row.get("updated_at")}
    log(f"[game-images] admin overrides: {len(out)} row(s) loaded")
    return out


def _fetch_sgdb_header(app_id: str, timeout: int = 8) -> str | None:
    """Ask SteamGridDB for a header-shaped grid for this Steam appId.

    Returns the URL or None on any failure. Called only when Steam's own
    APIs failed to yield a header (see build_game_images). Silent on
    error so the outer flow can fall through to status='missing'.
    """
    if not SGDB_API_KEY:
        return None
    hdrs = {"Authorization": f"Bearer {SGDB_API_KEY}"}
    # Step 1: Steam appId -> SGDB game id.
    try:
        req = urllib.request.Request(SGDB_STEAM_LOOKUP.format(appid=app_id), headers=hdrs)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read())
    except Exception:
        return None
    if not body.get("success"):
        return None
    game_id = (body.get("data") or {}).get("id")
    if not game_id:
        return None
    # Step 2: pull 460x215 static grids for that game id.
    try:
        req = urllib.request.Request(SGDB_GRIDS_URL.format(game_id=game_id), headers=hdrs)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read())
    except Exception:
        return None
    if not body.get("success"):
        return None
    grids = body.get("data") or []
    if not grids:
        return None
    # Prefer PNG (transparent + lossless). Otherwise SGDB returns top-voted first.
    for g in grids:
        if "png" in (g.get("mime") or "") and g.get("url"):
            return g["url"]
    return grids[0].get("url")


def _url_is_ok(url: str, timeout: int = 8) -> bool:
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urlopen handler that refuses to follow 3xx so we can inspect the
    Location header ourselves. Live store pages return 200 with the game
    name in apphub_AppName; banned/delisted/invalid ids 302 to the
    storefront homepage (https://store.steampowered.com/)."""

    def http_error_302(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)
    http_error_301 = http_error_303 = http_error_307 = http_error_302


def _probe_store_page(app_id: str, timeout: int = 10) -> bool | None:
    """Returns True if the store page exists (200 OK), False if it redirects
    to the homepage (banned/delisted/invalid), or None on transport error.

    The HEAD method works -- Steam returns the same 200/302 we get via GET
    without spending bandwidth on the full body.
    """
    url = STEAM_STORE_PAGE_URL.format(appid=app_id)
    req = urllib.request.Request(
        url, method="HEAD", headers={"User-Agent": "Mozilla/5.0 (proton-pulse pipeline probe)"},
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307):
            # Live store pages do not redirect; this is the banned/delisted signal
            return False
        return None
    except Exception as exc:
        log(f"[game-images] WARN: store page probe failed for {app_id}: {exc}", debug=True)
        return None


def _extract_replaced_by(app_id: str, timeout: int = 10) -> str | None:
    """When appdetails says success=false, the store page may redirect to a
    NEWER appid (e.g. 5488 -> 45700 for Devil May Cry 4, or Hitman 1/2 ->
    World of Assassination). Follows redirects and returns the new appid if
    the final URL is /app/{different_id}/, else None.

    Distinct from _probe_store_page which only cares about 200 vs redirect.
    Called only on the delisted path so cost is bounded.
    """
    url = STEAM_STORE_PAGE_URL.format(appid=app_id)
    req = urllib.request.Request(
        url, method="GET", headers={"User-Agent": "Mozilla/5.0 (proton-pulse pipeline probe)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final_url = resp.geturl()
    except Exception as exc:
        log(f"[game-images] WARN: replaced_by probe failed for {app_id}: {exc}", debug=True)
        return None
    # Steam's replacement redirects always land on /app/<newid>/<slug>/.
    # Anything else (homepage, agecheck, region-block) is not a replacement.
    import re as _re
    match = _re.search(r"/app/(\d+)(?:/|$)", final_url)
    if not match:
        return None
    new_id = match.group(1)
    if new_id == str(app_id):
        return None
    return new_id


def is_steam_store_up() -> bool:
    """Canary check: probe a known-good app's store page once per run. If the
    canary fails we cannot trust the per-app delisted signal because Steam's
    storefront is misbehaving globally.
    """
    result = _probe_store_page(CANARY_APPID)
    if result is True:
        return True
    log(f"[game-images] canary check FAILED for app {CANARY_APPID}; suppressing delisted detection for this run")
    return False


# Returned by _fetch_steam_header for a single app probe. "live" is the happy
# path. "delisted" requires BOTH the appdetails success=false signal and a
# store-page 302 -- a SteamDB-style two-signal corroboration that rules out
# single-endpoint API hiccups. "unknown" means we cannot conclude either way
# this run (transient network, ambiguous response, or canary down).
_STATUS_LIVE = "live"
_STATUS_DELISTED = "delisted"
_STATUS_UNKNOWN = "unknown"


def _fetch_steam_header(app_id: str, store_up: bool, timeout: int = 10) -> tuple[str | None, str]:
    """Return (header_url, status). status is one of _STATUS_LIVE,
    _STATUS_DELISTED, _STATUS_UNKNOWN.

    Delisted requires both signals to fire: appdetails returns success=false
    AND the store page redirects to homepage. Either alone is treated as
    unknown (transient API behavior, region restriction, or wobbling Steam
    backend). When store_up is False (canary down) we never return delisted
    -- the safe default during a Steam outage is to keep apps live until
    the next run can confirm.
    """
    url = STEAM_APPDETAILS_URL.format(appid=app_id)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        app_data = data.get(str(app_id), {})
        if app_data.get("success"):
            return app_data.get("data", {}).get("header_image") or None, _STATUS_LIVE
    except Exception as exc:
        log(f"[game-images] WARN: Steam appdetails fetch failed for {app_id}: {exc}")
        return None, _STATUS_UNKNOWN

    # appdetails said success=false. Need a second signal to confirm.
    if not store_up:
        # Canary failed at start of run; do not flag anything as delisted
        return None, _STATUS_UNKNOWN
    store_page_alive = _probe_store_page(app_id, timeout=timeout)
    if store_page_alive is False:
        return None, _STATUS_DELISTED
    return None, _STATUS_UNKNOWN


def _collect_all_app_ids(data_dir: Path) -> list[str]:
    ids: set[str] = set()
    if data_dir.is_dir():
        for entry in data_dir.iterdir():
            if entry.is_dir() and entry.name.isdigit():
                ids.add(entry.name)
    return sorted(ids, key=lambda x: int(x))


def _hot_app_ids(output_dir: Path) -> list[str]:
    """App IDs currently visible on the site (recent-reports + most_played + steam-catalog), deduplicated."""
    ids: list[str] = []
    seen: set[str] = set()
    for fname in ("recent-reports.json", "most_played.json"):
        p = output_dir / fname
        if not p.exists():
            continue
        try:
            for entry in json.loads(p.read_text(encoding="utf-8")):
                aid = str(entry.get("appId", entry.get("app_id", ""))).strip()
                if aid.isdigit() and aid not in seen:
                    seen.add(aid)
                    ids.append(aid)
        except Exception as exc:
            log(f"[game-images] WARN: could not read {fname}: {exc}")
    # Catalog-only games (Steam chart games with no ProtonDB data) always probe images.
    catalog_path = output_dir / "steam-catalog.json"
    if catalog_path.exists():
        try:
            for aid in json.loads(catalog_path.read_text(encoding="utf-8")).keys():
                if str(aid).isdigit() and aid not in seen:
                    seen.add(aid)
                    ids.append(aid)
        except Exception as exc:
            log(f"[game-images] WARN: could not read steam-catalog.json: {exc}")
    return ids


def _extended_steam_ids(output_dir: Path) -> list[str]:
    """Steam app IDs from the extended catalog index (search-index-steam-extended.json).

    These are Steam store entries with no ProtonDB/Pulse reports, so they have no
    data/ directory and never show up in _collect_all_app_ids. Most resolve fine via
    the standard header.jpg path client-side; only the hashed-path stragglers need a
    game-images.json override. Returned in index order so they drain deterministically
    through the capped backlog rather than probing 140k+ IDs in a single run.
    """
    p = output_dir / EXTENDED_STEAM_INDEX
    if not p.exists():
        return []
    ids: list[str] = []
    seen: set[str] = set()
    try:
        for entry in json.loads(p.read_text(encoding="utf-8")):
            if not isinstance(entry, list) or not entry:
                continue
            aid = str(entry[0]).strip()
            if aid.isdigit() and aid not in seen:
                seen.add(aid)
                ids.append(aid)
    except Exception as exc:
        log(f"[game-images] WARN: could not read {EXTENDED_STEAM_INDEX}: {exc}")
    return ids


def _load_cache(path: Path) -> dict:
    """Load unified cache: { appId: {status, url?, probed_at} }"""
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            log(f"[game-images] WARN: could not load cache {path.name}: {exc}")
    return {}


def _migrate_legacy(output_dir: Path, cache: dict) -> None:
    """One-time import of old game-images.json + game-images-skip.json into unified cache."""
    today = date.today().isoformat()
    migrated = 0

    overrides_path = output_dir / "game-images.json"
    if overrides_path.exists():
        try:
            old = json.loads(overrides_path.read_text(encoding="utf-8"))
            for aid, val in old.items():
                if aid not in cache and isinstance(val, str):
                    cache[aid] = {"status": "hashed", "url": val, "probed_at": today}
                    migrated += 1
        except Exception:
            pass

    skip_path = output_dir / "game-images-skip.json"
    if skip_path.exists():
        try:
            old = json.loads(skip_path.read_text(encoding="utf-8"))
            for aid in old.get("ids", []):
                if aid not in cache:
                    cache[aid] = {"status": "ok", "probed_at": today}
                    migrated += 1
        except Exception:
            pass

    if migrated:
        log(f"[game-images] migrated {migrated} entries from legacy cache files")


def _is_stale(entry: dict) -> bool:
    try:
        probed = date.fromisoformat(entry["probed_at"])
        return (date.today() - probed) > timedelta(days=STALE_DAYS)
    except Exception:
        return True


def build_game_images(output_dir) -> dict[str, str]:
    """Write game-images-cache.json (unified) and game-images.json (frontend).

    Returns the frontend override map: { appId: url } for hashed entries only.
    """
    output_dir = Path(output_dir)
    data_dir = output_dir / "data"
    cache_path = output_dir / "game-images-cache.json"

    cache = _load_cache(cache_path)
    if not cache:
        _migrate_legacy(output_dir, cache)

    # Admin overrides are the top of the fallback chain and MUST survive
    # every pipeline rerun. Seed the cache with them BEFORE any probing
    # so the skip-check below excludes them from hot/backlog lists.
    override_map = _fetch_admin_overrides()
    today_iso = date.today().isoformat()
    for aid, ov in override_map.items():
        cache[aid] = {
            "status": "override",
            "url": ov["image_url"],
            "source": ov.get("source"),
            "probed_at": today_iso,
        }

    all_ids = _collect_all_app_ids(data_dir)
    hot_ids = _hot_app_ids(output_dir)
    hot_set = set(hot_ids)

    # Hot: probe if uncached or stale (but never re-probe an override)
    hot_to_probe = [
        a for a in hot_ids
        if a not in override_map and (a not in cache or _is_stale(cache[a]))
    ]
    # Backlog: probe if uncached OR if hashed entry is stale (cover art hash may change), cap applies
    backlog_to_probe = [
        a for a in all_ids if a not in hot_set and a not in override_map and (
            a not in cache or
            (cache[a].get("status") == "hashed" and _is_stale(cache[a]))
        )
    ]
    # Extended Steam catalog stubs have no data/ dir, so _collect_all_app_ids never
    # sees them. Append the uncached ones to the END of the backlog: apps with real
    # reports drain first, and PROBE_CAP still bounds the whole backlog per run so the
    # 140k+ catalog IDs trickle in over many runs instead of probing all at once.
    extended_seen = hot_set | set(all_ids)
    extended_to_probe = [
        a for a in _extended_steam_ids(output_dir)
        if a not in extended_seen and a not in override_map and a not in cache
    ]
    backlog_to_probe += extended_to_probe

    log(
        f"[game-images] {len(all_ids)} total app IDs | cache: {len(cache)} | "
        f"hot: {len(hot_to_probe)} to probe | backlog: {len(backlog_to_probe)} uncached/stale-hashed "
        f"({len(extended_to_probe)} extended-steam) (cap {PROBE_CAP})"
    )

    # Run-wide canary: do we even believe Steam's storefront right now? If not,
    # _fetch_steam_header refuses to return delisted for any app this run.
    store_up = is_steam_store_up()
    log(f"[game-images] storefront canary: {'OK' if store_up else 'DOWN'}")

    today = date.today().isoformat()
    backlog_probed = 0

    # Wall-clock budget so a Steam 403-flood does not stall the whole finalize
    # step (#258). Same defense as steam_type + release_years. game_images
    # writes its cache and returns partial results instead of hanging.
    WALL_CLOCK_BUDGET_SEC = 600
    deadline = time.monotonic() + WALL_CLOCK_BUDGET_SEC
    # Save cache periodically so a bail (SIGTERM, timeout) does not lose the
    # probes we already ran. Saves are cheap since the cache is small JSON.
    CACHE_SAVE_EVERY = 50
    saved_at = 0

    for app_id in hot_to_probe + backlog_to_probe:
        if time.monotonic() > deadline:
            log(f"[game-images] wall-clock budget {WALL_CLOCK_BUDGET_SEC}s exhausted, deferring rest")
            break
        is_backlog = app_id not in hot_set
        if is_backlog:
            if backlog_probed >= PROBE_CAP:
                log(f"[game-images] hit backlog cap ({PROBE_CAP}), deferring {len(backlog_to_probe) - backlog_probed}")
                break
            backlog_probed += 1

        standard_url = _standard_header_url(app_id)
        if _url_is_ok(standard_url):
            log(f"[game-images] {app_id}: standard URL ok", debug=True)
            cache[app_id] = {"status": "ok", "probed_at": today}
        else:
            log(f"[game-images] {app_id}: standard URL 404, fetching from Steam API")
            real_url, status = _fetch_steam_header(app_id, store_up=store_up)
            if real_url:
                url_clean = real_url.split("?")[0]
                cache[app_id] = {"status": "hashed", "url": url_clean, "probed_at": today}
                log(f"[game-images] {app_id}: hashed URL -> {url_clean}")
            elif status == _STATUS_DELISTED:
                # Two-signal confirmation fired: appdetails success=false AND
                # store page 302's to the homepage. Canary verified Steam was
                # responsive at run start, so this is a high-confidence flag.
                # Additionally probe whether Steam redirected to a NEWER appid
                # (e.g. 5488 -> 45700 for Devil May Cry 4). When replaced, the
                # entry stays delisted but records replaced_by so the frontend
                # can show a "now sold as X" banner and fall back to the new
                # appid's header image.
                replaced_by = _extract_replaced_by(app_id)
                entry = {"status": "delisted", "probed_at": today}
                if replaced_by:
                    entry["replaced_by"] = replaced_by
                    log(f"[game-images] {app_id}: delisted, replaced by {replaced_by}")
                else:
                    log(f"[game-images] {app_id}: delisted (appdetails false + store page redirect)")
                cache[app_id] = entry
            else:
                # _STATUS_LIVE with no header, or _STATUS_UNKNOWN. Try
                # SteamGridDB as a last-resort fallback -- community
                # artwork often exists for delisted / freshly-missing
                # apps that Steam's own APIs no longer serve. Verified
                # with _url_is_ok so we don't stamp a URL that itself
                # 404s. If SGDB has nothing (or the key isn't set),
                # fall through to status="missing" like before.
                sgdb_url = _fetch_sgdb_header(app_id)
                if sgdb_url and _url_is_ok(sgdb_url):
                    cache[app_id] = {"status": "sgdb", "url": sgdb_url, "probed_at": today}
                    log(f"[game-images] {app_id}: SGDB fallback -> {sgdb_url}")
                else:
                    cache[app_id] = {"status": "missing", "probed_at": today}
                    log(f"[game-images] {app_id}: no image found (status={status})")
        # Persist mid-run so a bail keeps the work we already did.
        if len(cache) - saved_at >= CACHE_SAVE_EVERY:
            cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
            saved_at = len(cache)
        time.sleep(REQUEST_DELAY)

    cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
    log(f"[game-images] wrote unified cache ({len(cache)} entries) to {cache_path.name}")

    # Derive frontend game-images.json: hashed + SGDB entries, { appId: url }.
    # Both categories represent "the frontend needs a non-standard URL
    # for this app" -- the fallback chain in steam-img.js reads this
    # map after the standard CDN 404s.
    # override entries beat all other sources in the frontend map so
    # the fallback chain in steam-img.js finds them first when the
    # standard CDN 404s.
    frontend = {
        aid: e["url"]
        for aid, e in cache.items()
        if e.get("status") in ("override", "hashed", "sgdb") and e.get("url")
    }
    # Replaced-by inheritance: an old appid without its own header URL falls
    # back to the new appid's URL (or standard CDN) so cards keep box art
    # instead of showing the missing tile. Frontend still shows the "now sold
    # as X" banner from search-index column 10 so users see the replacement.
    for aid, e in cache.items():
        new_aid = e.get("replaced_by") if isinstance(e, dict) else None
        if not new_aid or aid in frontend:
            continue
        new_entry = cache.get(str(new_aid), {})
        if new_entry.get("url"):
            frontend[aid] = new_entry["url"]
        else:
            frontend[aid] = _standard_header_url(str(new_aid))
    frontend_path = output_dir / "game-images.json"
    frontend_path.write_text(json.dumps(frontend, indent=2) + "\n", encoding="utf-8")
    override_ct = sum(1 for e in cache.values() if e.get("status") == "override")
    hashed_ct   = sum(1 for e in cache.values() if e.get("status") == "hashed")
    sgdb_ct     = sum(1 for e in cache.values() if e.get("status") == "sgdb")
    replaced_ct = sum(1 for e in cache.values() if isinstance(e, dict) and e.get("replaced_by"))
    log(f"[game-images] wrote {len(frontend)} URL(s) to {frontend_path.name} ({override_ct} override, {hashed_ct} hashed, {sgdb_ct} sgdb, {replaced_ct} replaced-inherit)")

    return frontend


def enrich_search_index_with_delisted(output_dir) -> None:
    """Write a delisted=True flag into column 7 of search-index.json for any
    Steam app the cache marked as delisted (appdetails returned success=false).

    Read-modify-write of search-index in place. Pads rows to length 8 so column
    7 lands consistently regardless of whether column 6 (releaseYear) was
    populated by release_years.py.
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    cache_path = output_dir / "game-images-cache.json"
    if not index_path.exists() or not cache_path.exists():
        return
    try:
        entries = json.loads(index_path.read_text(encoding="utf-8"))
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[delisted] WARN: could not read input files: {exc}")
        return
    if not isinstance(entries, list) or not isinstance(cache, dict):
        return

    delisted_ids = {aid for aid, e in cache.items() if isinstance(e, dict) and e.get("status") == "delisted"}
    # Map of oldAppId -> newAppId for Steam entries replaced by a newer appid
    # (see _extract_replaced_by). Emitted into column 10 of search-index so
    # the frontend can render a "now sold as X" banner and inherit box art.
    replaced_by_map: dict[str, str] = {
        aid: str(e["replaced_by"])
        for aid, e in cache.items()
        if isinstance(e, dict) and e.get("replaced_by")
    }
    if not delisted_ids and not replaced_by_map:
        log("[delisted] no delisted or replaced Steam apps in cache, skipping enrich")
        return

    updated_delisted = 0
    updated_replaced = 0
    for row in entries:
        if not isinstance(row, list) or len(row) < 1:
            continue
        aid = str(row[0])
        # Pad to 11 columns: [id, title, tier, pdb, pulse, appType, releaseYear,
        # delisted, adult, trend, replaced_by]. Column 10 is new.
        if aid in delisted_ids or aid in replaced_by_map:
            while len(row) < 11:
                row.append(None)
        if aid in delisted_ids:
            row[7] = True
            updated_delisted += 1
        if aid in replaced_by_map:
            row[10] = replaced_by_map[aid]
            updated_replaced += 1

    if updated_delisted or updated_replaced:
        index_path.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
        log(f"[delisted] flagged {updated_delisted} entries as delisted, {updated_replaced} as replaced")
