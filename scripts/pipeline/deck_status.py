"""Build deck-status.json: per-game Steam Deck compatibility from Valve.

Steam's `ajaxgetdeckappcompatibilityreport` endpoint returns Valve's official
Deck verdict plus per-criterion results for an app. It is NOT CORS-enabled, so
the web UI cannot call it from the browser -- every call fails and the widget
falls back to "Unknown ?". This runs server-side in the pipeline and emits a
static deck-status.json the web UI reads instead (task #37).

Response shape (verified example, app 1245620 Elden Ring):
  { "success": 1, "results": {
      "resolved_category": 3,        # 0 unknown / 1 unsupported / 2 playable / 3 verified
      "resolved_items": [ {"display_type": 4, "loc_token": "..."}, ... ]
  }}

display_type: 4 = pass, 3 = info/caveat, 2 = fail (mapped to True / None / False).
The four resolved_items map, in order, to the four Deck criteria the widget
lists (controller config, glyphs, legible text, performant defaults).

Only games Valve has actually evaluated (resolved_category != 0) are written,
so the file stays small; unknown games fall back to "unknown" client-side.
"""
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from .common import log

STEAM_DECK_COMPAT_URL = (
    "https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID={app_id}"
)
# Matches DECK_CAT_MAP in js/app/api/deck-status.js -- keep in sync.
DECK_CAT_MAP = {0: "unknown", 1: "unsupported", 2: "playable", 3: "verified"}
# Steam Machine uses the same Verified / Playable / Unsupported scale as Deck.
MACHINE_CAT_MAP = DECK_CAT_MAP
# SteamOS has a simpler scale: unsupported vs "Compatible" (the store modal only
# ever shows "Compatible" as the positive verdict). Both 2 and 3 read as
# compatible. #273 -- keep in sync with STEAMOS_CAT_MAP in deck-status.js.
STEAMOS_CAT_MAP = {0: "unknown", 1: "unsupported", 2: "compatible", 3: "compatible"}
# display_type -> per-criterion result. 4 pass, 3 info/caveat, 2 fail.
DECK_DISPLAY_MAP = {4: True, 3: None, 2: False}

CACHE_PATH = Path(__file__).resolve().parents[2] / ".cache" / "steam-deck-compat-cache.json"
CACHE_MAX_AGE_SECONDS = 30 * 86400  # confirmed verdicts
# Unresolved / rate-limited responses expire sooner so a throttled fetch isn't
# locked as "no verdict" for a month (same lesson as the descriptor cache, #185).
CACHE_NEGATIVE_TTL_SECONDS = 3 * 86400

_cache = None
_cache_dirty = False


def _load_cache():
    global _cache
    if _cache is not None:
        return _cache
    try:
        loaded = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        _cache = loaded if isinstance(loaded, dict) else {}
    except Exception:
        _cache = {}
    return _cache


def flush_deck_compat_cache(path=None):
    """Persist the in-memory cache to disk if it changed."""
    global _cache_dirty
    if _cache is None or not _cache_dirty:
        return
    p = Path(path) if path else CACHE_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(_cache), encoding="utf-8")
    _cache_dirty = False


def _fetch_raw(app_id, timeout=15):
    req = urllib.request.Request(
        STEAM_DECK_COMPAT_URL.format(app_id=app_id),
        headers={"Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def fetch_deck_compat(app_id):
    """Return ``{'status', 'criteria'}`` for an app, or ``None`` when Valve has
    no verdict (resolved_category 0) or the fetch failed. Cached on disk.

    ``criteria`` is a list of four True/False/None values from the first four
    resolved_items, or ``None`` when fewer than four are present.
    """
    global _cache_dirty
    cache = _load_cache()
    now = int(time.time())
    key = str(app_id)

    cached = cache.get(key)
    if isinstance(cached, dict):
        cval = cached.get("val")
        # Old-schema positive entries predate #273 and lack machine/steamos --
        # force a refetch so they get enriched. Negative (None) entries have
        # nothing to enrich, so honor their TTL as before.
        stale_schema = isinstance(cval, dict) and "machine" not in cval
        ok = cached.get("ok")
        if ok is None:  # legacy entries: a stored verdict implies a confirmed fetch
            ok = bool(cval)
        ttl = CACHE_MAX_AGE_SECONDS if ok else CACHE_NEGATIVE_TTL_SECONDS
        if not stale_schema and now - cached.get("ts", 0) < ttl:
            return cval

    try:
        data = _fetch_raw(app_id)
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as exc:
        # Network error / rate limit: do NOT poison the cache -- retry next run.
        log(f"[deck-status] WARN: fetch failed for {app_id}: {exc}")
        return None

    results = (data or {}).get("results") or {}
    deck_cat = int(results.get("resolved_category") or 0)
    machine_cat = int(results.get("machine_resolved_category") or 0)
    steamos_cat = int(results.get("steamos_resolved_category") or 0)
    if not data.get("success") or not (deck_cat or machine_cat or steamos_cat):
        # success:false or nothing rated on any target. Short-lived negative so
        # a throttled response is retried; an evaluated-as-unknown app is omitted.
        cache[key] = {"val": None, "ts": now, "ok": False}
        _cache_dirty = True
        return None

    items = results.get("resolved_items") or []
    criteria = (
        [DECK_DISPLAY_MAP.get(i.get("display_type")) for i in items[:4]]
        if len(items) >= 4
        else None
    )
    # machine/steamos keys are ALWAYS present (even "unknown") so the schema
    # check above can distinguish a #273-enriched cache entry from an old one.
    val = {
        "status": DECK_CAT_MAP.get(deck_cat, "unknown"),
        "criteria": criteria,
        "machine": MACHINE_CAT_MAP.get(machine_cat, "unknown"),
        "steamos": STEAMOS_CAT_MAP.get(steamos_cat, "unknown"),
    }
    cache[key] = {"val": val, "ts": now, "ok": True}
    _cache_dirty = True
    return val


def steam_app_ids_with_reports(output_dir):
    """Steam app ids from search-index.json that have at least one report.

    Scopes the fetch to games users actually inspect (they have a real game
    page), instead of every catalog stub. search-index row shape:
    [app_id, title, tier, protondb_count, pulse_count, app_type, ...].
    """
    rows = json.loads((Path(output_dir) / "search-index.json").read_text(encoding="utf-8"))
    ids = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            continue
        app_id = str(row[0])
        app_type = row[5] or "steam"
        pdb = row[3] or 0
        pulse = row[4] or 0
        if app_type == "steam" and app_id.isdigit() and (pdb + pulse) > 0:
            ids.append(app_id)
    return ids


def build_deck_status(output_dir, app_ids=None, delay=0.0):
    """Fetch Deck compat for the scoped Steam apps and write deck-status.json.

    Returns the ``{app_id: {status, criteria}}`` map that was written.
    """
    out = Path(output_dir)
    ids = app_ids if app_ids is not None else steam_app_ids_with_reports(out)
    result = {}
    for app_id in ids:
        val = fetch_deck_compat(app_id)
        if val:
            # Keep the published map lean: only carry machine/steamos when
            # rated (the UI treats a missing field as "not rated").
            out = {"status": val["status"], "criteria": val.get("criteria")}
            if val.get("machine") and val["machine"] != "unknown":
                out["machine"] = val["machine"]
            if val.get("steamos") and val["steamos"] != "unknown":
                out["steamos"] = val["steamos"]
            result[app_id] = out
        if delay:
            time.sleep(delay)
    flush_deck_compat_cache()
    path = out / "deck-status.json"
    path.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    log(f"[deck-status] Wrote {len(result)} Deck verdicts for {len(ids)} Steam apps to {path}")
    return result
