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
# Steam Frame (#594) too: `frame_resolved_category` uses the same 0-3 scale
# (verified on Hades 1145360 = 3, Cyberpunk 2077 1091500 = 2). Valve returns
# null rather than 0 for titles it has not rated for Frame yet.
FRAME_CAT_MAP = DECK_CAT_MAP
# SteamOS has a simpler scale: unsupported vs "Compatible" (the store modal only
# ever shows "Compatible" as the positive verdict). Both 2 and 3 read as
# compatible. #273 -- keep in sync with STEAMOS_CAT_MAP in deck-status.js.
STEAMOS_CAT_MAP = {0: "unknown", 1: "unsupported", 2: "compatible", 3: "compatible"}
# display_type -> per-criterion result. 4 pass, 3 info/caveat, 2 fail.
DECK_DISPLAY_MAP = {4: True, 3: None, 2: False}

def _extract_criteria(items, prefix):
    """Compact machine/steamos/frame resolved_items into [[display_type, short_token], ...].

    Strips the `#SteamMachine_TestResult_` / `#SteamOS_TestResult_` /
    `#SteamFrame_TestResult_` prefix from
    each loc_token so the JSON stays small. Returns an empty list when the
    upstream array is empty or missing so the frontend can distinguish
    "evaluated with no notes" from an "unknown" verdict.
    """
    if not isinstance(items, list):
        return []
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        dt = it.get("display_type")
        tok = it.get("loc_token") or ""
        if isinstance(tok, str) and tok.startswith(prefix):
            tok = tok[len(prefix):]
        out.append([dt, tok])
    return out


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
    # URL from hardcoded STEAM_DECK_COMPAT_URL + validated app_id
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        return json.load(resp)


def fetch_deck_compat(app_id):
    """Return ``{'status', 'criteria'}`` for an app, or ``None`` when Valve has
    no verdict (resolved_category 0) or the fetch failed. Cached on disk.

    ``criteria`` is a list of four True/False/None values from the first four
    resolved_items, or ``None`` when fewer than four are present.
    """
    state, cval = _cache_state(app_id)
    if state == "fresh":
        return cval
    val, _failed = _fetch_and_cache(app_id)
    return val


def _cache_state(app_id):
    """Return ``(state, cached_val)``: state is "fresh", "stale" or "missing".

    "stale" covers both an expired TTL and an old-schema positive entry that
    lacks machine/steamos/frame or the per-criterion arrays (refetched to
    enrich). Entries cached before #594 have no "frame" key; they refresh
    inside the normal per-run refresh budget, so Frame ratings fill in over
    about two weeks of nightlies (~20k rated entries at 1,500 a night, sharing
    the budget with TTL expiries) instead of in one long run.
    """
    cache = _load_cache()
    cached = cache.get(str(app_id))
    if not isinstance(cached, dict):
        return "missing", None
    cval = cached.get("val")
    stale_schema = isinstance(cval, dict) and (
        "machine" not in cval or "machine_criteria" not in cval or "frame" not in cval
    )
    ok = cached.get("ok")
    if ok is None:  # legacy entries: a stored verdict implies a confirmed fetch
        ok = bool(cval)
    ttl = CACHE_MAX_AGE_SECONDS if ok else CACHE_NEGATIVE_TTL_SECONDS
    if not stale_schema and int(time.time()) - cached.get("ts", 0) < ttl:
        return "fresh", cval
    return "stale", cval


def _fetch_and_cache(app_id):
    """Fetch one app's Deck verdict from Steam and cache it.

    Returns ``(val, failed)``. ``failed`` is True for a network or parse
    failure (nothing cached, so it is retried next run); a successful fetch
    with no verdict returns ``(None, False)``.
    """
    global _cache_dirty
    cache = _load_cache()
    now = int(time.time())
    key = str(app_id)

    try:
        data = _fetch_raw(app_id)
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as exc:
        # Network error / rate limit: do NOT poison the cache -- retry next run.
        log(f"[deck-status] WARN: fetch failed for {app_id}: {exc}")
        return None, True

    results = (data or {}).get("results") or {}
    deck_cat = int(results.get("resolved_category") or 0)
    machine_cat = int(results.get("machine_resolved_category") or 0)
    steamos_cat = int(results.get("steamos_resolved_category") or 0)
    frame_cat = int(results.get("frame_resolved_category") or 0)
    if not data.get("success") or not (deck_cat or machine_cat or steamos_cat or frame_cat):
        # success:false or nothing rated on any target. Short-lived negative so
        # a throttled response is retried; an evaluated-as-unknown app is omitted.
        cache[key] = {"val": None, "ts": now, "ok": False}
        _cache_dirty = True
        return None, False

    items = results.get("resolved_items") or []
    criteria = (
        [DECK_DISPLAY_MAP.get(i.get("display_type")) for i in items[:4]]
        if len(items) >= 4
        else None
    )
    # Steam Machine + SteamOS ship parallel resolved_items arrays. Length varies
    # per game (TF2 has 3 for both, some games have more or fewer). Frontend
    # needs display_type + a compact token so it can render a per-criterion
    # checklist matching Valve's own tabs. Store as [[display_type, token], ...]
    # with the `#Device_TestResult_` prefix stripped to keep the file small.
    machine_criteria = _extract_criteria(results.get("machine_resolved_items"), "#SteamMachine_TestResult_")
    steamos_criteria = _extract_criteria(results.get("steamos_resolved_items"), "#SteamOS_TestResult_")
    frame_criteria = _extract_criteria(results.get("frame_resolved_items"), "#SteamFrame_TestResult_")
    val = {
        "status": DECK_CAT_MAP.get(deck_cat, "unknown"),
        "criteria": criteria,
        "machine": MACHINE_CAT_MAP.get(machine_cat, "unknown"),
        "steamos": STEAMOS_CAT_MAP.get(steamos_cat, "unknown"),
        "machine_criteria": machine_criteria,
        "steamos_criteria": steamos_criteria,
        "frame": FRAME_CAT_MAP.get(frame_cat, "unknown"),
        "frame_criteria": frame_criteria,
    }
    cache[key] = {"val": val, "ts": now, "ok": True}
    _cache_dirty = True
    return val, False


# Per-run budget for NEW Deck verdict fetches. Cached ids cost nothing (30-day
# TTL), so the map accumulates across runs rather than re-fetching the catalog.
DECK_FETCH_BUDGET = 400

# Per-run budget for REFRESHING expired cache entries (#258). Expired entries
# used to be refetched without any limit, and the cache expires in waves (the
# 3-day negative TTL covers ~13k unrated apps cached together), so one night
# silently spent 23 minutes refetching. Over budget, an expired entry keeps
# serving its cached verdict until a later run refreshes it; refreshed entries
# get new timestamps, which spreads future expiry across nights. 1,500 a night
# cycles the 33k catalog in about 22 nights, inside the 30-day verdict TTL.
DECK_REFRESH_BUDGET = 1500


def _json_or_empty(path):
    """Read a pipeline JSON side-file, or return None when it is absent.

    These are optional inputs: on a finalize-only run most_played.json may not
    have been regenerated. Missing means "no priority hint", not an error.
    """
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def steam_app_ids_for_deck_status(output_dir, budget=DECK_FETCH_BUDGET):
    """Steam app ids to fetch Deck verdicts for, most-visible first.

    Deliberately NOT gated on report counts. It used to be
    `(protondb_count + pulse_count) > 0`, which was fine while ProtonDB counts
    populated the index -- then #474 decoupled ProtonDB, every protondb_count
    went to 0, and the scope silently collapsed from thousands of games to 17.
    Nothing failed: the file wrote successfully and the log reported the new
    count as if it were normal. Counter-Strike 2 showed "Valve has not
    evaluated this title yet" while the store page said Playable.

    Priority order, because the budget cannot cover 32k Steam rows in one run:
      1. games with Pulse reports      (someone cared enough to report)
      2. Steam's most-played chart     (what the home page shows)
      3. recently reported games       (the other home section)
      4. everything else in the index  (fills the remaining budget)

    Ids already in the verdict cache are returned too and cost no request, so
    the published map keeps growing instead of churning.
    """
    out = Path(output_dir)
    rows = json.loads((out / "search-index.json").read_text(encoding="utf-8"))

    steam_ids, reported = [], []
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            continue
        app_id = str(row[0])
        if (row[5] or "steam") != "steam" or not app_id.isdigit():
            continue
        steam_ids.append(app_id)
        if (row[3] or 0) + (row[4] or 0) > 0:
            reported.append(app_id)

    def _ids_from(payload, keys=("appId", "appid", "app_id", "id")):
        found = []
        for entry in payload or []:
            if not isinstance(entry, dict):
                continue
            for key in keys:
                val = entry.get(key)
                if val is not None:
                    found.append(str(val))
                    break
        return found

    ordered, seen = [], set()
    for group in (
        reported,
        _ids_from(_json_or_empty(out / "most_played.json")),
        _ids_from(_json_or_empty(out / "recent-reports.json")),
        steam_ids,
    ):
        for app_id in group:
            if app_id.isdigit() and app_id not in seen:
                seen.add(app_id)
                ordered.append(app_id)

    # Everything already cached rides along for free; the budget only limits
    # ids that would cost a request.
    cache = _load_cache()
    cached_ids = [a for a in ordered if a in cache]
    fresh = [a for a in ordered if a not in cache][:budget]
    log(
        f"[deck-status] scope: {len(ordered):,} steam apps, {len(cached_ids):,} already cached, "
        f"fetching up to {len(fresh):,} new (budget {budget})"
    )
    return cached_ids + fresh


# Back-compat alias: the old name said "with reports", which is exactly the
# assumption that broke. Kept so any external caller keeps working.
steam_app_ids_with_reports = steam_app_ids_for_deck_status


def build_deck_status(output_dir, app_ids=None, delay=0.0, refresh_budget=DECK_REFRESH_BUDGET):
    """Fetch Deck compat for the scoped Steam apps and write deck-status.json.

    Fresh cache entries cost nothing, apps missing from the cache are fetched
    (the scope already caps them at DECK_FETCH_BUDGET), and expired entries
    are refreshed up to ``refresh_budget``; the rest keep their cached
    verdict this run. A failed refresh also keeps the cached verdict.

    Returns the ``{app_id: {status, criteria}}`` map that was written.
    """
    out_dir = Path(output_dir)
    ids = app_ids if app_ids is not None else steam_app_ids_for_deck_status(out_dir)
    result = {}
    stats = {"fresh": 0, "fetched_new": 0, "refreshed": 0, "stale_served": 0, "failed": 0}
    started = time.time()
    for app_id in ids:
        state, cval = _cache_state(app_id)
        fetched = False
        if state == "fresh":
            val = cval
            stats["fresh"] += 1
        elif state == "stale" and stats["refreshed"] >= refresh_budget:
            val = cval
            stats["stale_served"] += 1
        else:
            fetched = True
            val, failed = _fetch_and_cache(app_id)
            if failed:
                stats["failed"] += 1
                val = cval  # keep the stale verdict rather than dropping the app
            elif state == "stale":
                stats["refreshed"] += 1
            else:
                stats["fetched_new"] += 1
        if val:
            # Keep the published map lean: only carry machine/steamos when
            # rated (the UI treats a missing field as "not rated").
            entry = {"status": val["status"], "criteria": val.get("criteria")}
            if val.get("machine") and val["machine"] != "unknown":
                entry["machine"] = val["machine"]
            if val.get("steamos") and val["steamos"] != "unknown":
                entry["steamos"] = val["steamos"]
            if val.get("frame") and val["frame"] != "unknown":
                entry["frame"] = val["frame"]
            # Only carry the per-criterion arrays when non-empty. A rated
            # machine/steamos with zero items is possible (Valve caveat-free
            # game) but rare -- the frontend treats a missing key the same as
            # an empty list, so dropping the key saves a few bytes per entry.
            if val.get("machine_criteria"):
                entry["machine_criteria"] = val["machine_criteria"]
            if val.get("steamos_criteria"):
                entry["steamos_criteria"] = val["steamos_criteria"]
            if val.get("frame_criteria"):
                entry["frame_criteria"] = val["frame_criteria"]
            result[app_id] = entry
        if delay and fetched:
            time.sleep(delay)
    flush_deck_compat_cache()
    log(
        f"[deck-status] cache: {stats['fresh']:,} fresh, {stats['fetched_new']:,} new fetched, "
        f"{stats['refreshed']:,} expired refreshed (budget {refresh_budget:,}), "
        f"{stats['stale_served']:,} expired still served, {stats['failed']:,} failed, "
        f"{time.time() - started:.1f}s"
    )
    path = out_dir / "deck-status.json"
    path.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    log(f"[deck-status] Wrote {len(result)} Deck verdicts for {len(ids)} Steam apps to {path}")
    return result
