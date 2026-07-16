"""Enrich search-index.json with anti-cheat status per Steam app (#242).

Data source: AreWeAntiCheatYet/AreWeAntiCheatYet on GitHub. Their `games.json`
publishes one row per game with:
    - status: "Supported" | "Running" | "Broken" | "Denied" | "Planned"
    - anticheats: ["Easy Anti-Cheat", "BattlEye", "VAC", ...]
    - storeIds.steam: numeric Steam app id (present on ~60% of rows)

We fetch nightly, index by Steam appid, and cache to disk. The enricher
maps each cache hit into two columns on search-index rows:

    col 10 (index 10): ac_status -- one of the enum values above, lowercased.
    col 11 (index 11): ac_vendors -- list of anti-cheat vendor strings.

Both default to None for apps not in the cache. Older frontend consumers
that only read columns 0..9 keep working (JS destructuring ignores extras).

License: AreWeAntiCheatYet ships CC-BY. Attribution lives in
proton-pulse-web-wiki/Data-Pipeline.md.
"""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

from .common import log

# Steam appdetails is our secondary signal for games AreWeAntiCheatYet does
# not track. Text search on drm_notice + about_the_game for these vendor
# keywords produces a "Uses <vendor>" label (no Linux verdict). Order matters
# only for the log line -- the first hit sticks per game.
STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails?appids={appid}"
_APPDETAILS_TIMEOUT = 6
_APPDETAILS_DELAY = 0.3

# Vendor -> case-insensitive substrings we look for in drm_notice + about text.
# Keep the substrings on the tighter side so a game that just mentions
# "we do NOT use Denuvo" does not get mislabeled -- prefer trademark
# strings that only appear when the vendor is actually integrated.
_APPDETAILS_VENDOR_PATTERNS: dict[str, tuple[str, ...]] = {
    "Easy Anti-Cheat": ("easy anti-cheat", "eac (kernel)"),
    "BattlEye":        ("battleye",),
    "Vanguard":        ("riot vanguard",),
    "PunkBuster":      ("punkbuster",),
    "Denuvo":          ("denuvo anti-cheat", "denuvo anti-tamper"),
    "Xigncode3":       ("xigncode",),
    "nProtect":        ("nprotect gameguard",),
    "Anti-Cheat Expert": ("anti-cheat expert",),
    "Hyperion":        ("hyperion anti-cheat",),
    "FairFight":       ("fairfight",),
}

# Wall-clock + per-run caps for the appdetails vendor scan. Same defense-in-
# depth pattern release_years.py uses so a Steam 403-flood cannot stall
# finalize. The scan queues at most PROBE_CAP fresh appids per run, then
# stops -- the cache persists so subsequent runs pick up the tail.
#
# Default 0 for the initial rollout so first prod run ships with just the
# zero-network passes (AreWeAntiCheatYet + title-match backfill). Raise
# once staging finalize wall-clock is healthy. Overridable via env var
# so a manual dispatch can flip it on without a code change.
import os as _os
APPDETAILS_PROBE_CAP = int(_os.environ.get("ANTI_CHEAT_APPDETAILS_PROBE_CAP", "0"))
APPDETAILS_WALL_CLOCK_BUDGET_SEC = 240
APPDETAILS_CONSECUTIVE_FAILURE_LIMIT = 8

# Canonical upstream. HEAD branch (main) is stable + the maintainers
# publish `games.json` as the release artifact.
UPSTREAM_URL = (
    "https://raw.githubusercontent.com/AreWeAntiCheatYet/AreWeAntiCheatYet/HEAD/games.json"
)

CACHE_FILENAME = "anti-cheat-cache.json"

# Fresh fetch cadence. Twice a day is plenty -- the upstream repo does not
# update more often than that in practice. Cache file records the fetch
# timestamp so a re-run within the window skips the HTTP call.
FRESH_TTL_SEC = 12 * 3600

# Statuses upstream uses today. Lowercased on write so the frontend does
# not have to case-normalize on every filter check.
_VALID_STATUSES = {"supported", "running", "broken", "denied", "planned"}


def _load_cache(cache_path: Path) -> dict:
    if not cache_path.exists():
        return {"fetched_at": 0, "by_appid": {}}
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"fetched_at": 0, "by_appid": {}}
        data.setdefault("fetched_at", 0)
        data.setdefault("by_appid", {})
        return data
    except Exception as exc:
        log(f"[anti-cheat] WARN: could not read cache: {exc}")
        return {"fetched_at": 0, "by_appid": {}}


def _save_cache(cache_path: Path, cache: dict) -> None:
    cache_path.write_text(json.dumps(cache, sort_keys=True), encoding="utf-8")


def _fetch_upstream(timeout: int = 20) -> list | None:
    """Download the AreWeAntiCheatYet games.json. Returns None on failure."""
    req = urllib.request.Request(UPSTREAM_URL, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except Exception as exc:
        log(f"[anti-cheat] WARN: upstream fetch failed: {exc}")
        return None
    try:
        data = json.loads(body)
    except Exception as exc:
        log(f"[anti-cheat] WARN: upstream JSON parse failed: {exc}")
        return None
    if not isinstance(data, list):
        log(f"[anti-cheat] WARN: upstream returned non-list ({type(data).__name__})")
        return None
    return data


def _index_by_appid(rows: list) -> dict[str, dict]:
    """Build {steam_appid: {status, vendors}} from the upstream rows.

    Skips entries without a Steam appid or with an unknown status so the
    cache only contains data we can actually surface.
    """
    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        store_ids = row.get("storeIds") or {}
        steam_id = store_ids.get("steam") if isinstance(store_ids, dict) else None
        if not steam_id:
            continue
        status = (row.get("status") or "").strip().lower()
        if status not in _VALID_STATUSES:
            continue
        vendors = row.get("anticheats") or []
        if not isinstance(vendors, list):
            vendors = []
        # Sanitize vendors -- upstream sometimes ships stray whitespace / dupes.
        vendors = sorted({str(v).strip() for v in vendors if str(v).strip()})
        out[str(steam_id)] = {"status": status, "vendors": vendors}
    return out


def refresh_cache(output_dir: Path, force: bool = False) -> dict[str, dict]:
    """Load or refresh the anti-cheat cache. Returns {appid: {status, vendors}}.

    Refreshes when the cache is missing, stale (> FRESH_TTL_SEC), or `force`.
    Falls back to the on-disk cache when the network is down so a broken
    upstream never wipes the enrichment.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    now = int(time.time())
    fresh_enough = (now - int(cache.get("fetched_at") or 0)) < FRESH_TTL_SEC
    if fresh_enough and not force and cache.get("by_appid"):
        log(
            f"[anti-cheat] cache hit ({len(cache['by_appid'])} apps, "
            f"age {now - int(cache['fetched_at'])}s)"
        )
        return cache["by_appid"]

    log("[anti-cheat] refreshing from upstream")
    upstream = _fetch_upstream()
    if upstream is None:
        # Network / parse failure. Fall back to whatever we already have on disk.
        log(f"[anti-cheat] upstream unreachable; using {len(cache['by_appid'])} cached rows")
        return cache["by_appid"]

    by_appid = _index_by_appid(upstream)
    # Preserve the raw upstream rows so subsequent runs can do the title-
    # match backfill without re-fetching from the network. Also preserve
    # any existing appdetails_scan cache the enricher grew last time.
    cache = {
        "fetched_at": now,
        "by_appid": by_appid,
        "upstream_snapshot": upstream,
        "appdetails_scan": cache.get("appdetails_scan") or {},
    }
    _save_cache(cache_path, cache)
    log(f"[anti-cheat] cached {len(by_appid)} apps with Steam ids")
    return by_appid


def _normalize_title(title: str) -> str:
    """Fold titles into a compare-friendly key: lowercased, punctuation stripped."""
    import re as _re
    return _re.sub(r"[^a-z0-9]+", "", (title or "").lower())


def _backfill_from_search_index_titles(
    upstream_rows: list, by_appid: dict[str, dict], entries: list,
) -> int:
    """Fill in Steam appids for AreWeAntiCheatYet rows that lack storeIds.steam
    by matching upstream game names against the search-index titles we already have.

    Returns the number of appids we added. Mutates by_appid in place. Only
    considers upstream rows with valid status + no existing Steam id, so we
    never overwrite the authoritative mapping.
    """
    if not upstream_rows or not entries:
        return 0
    # index search-index titles -> appid (Steam only, first-writer-wins so
    # duplicate titles do not clobber a match).
    title_to_appid: dict[str, str] = {}
    for row in entries:
        if not isinstance(row, list) or len(row) < 6:
            continue
        app_id = str(row[0])
        if not app_id.isdigit():
            continue  # skip GOG/Epic canonical ids
        key = _normalize_title(row[1])
        if key and key not in title_to_appid:
            title_to_appid[key] = app_id

    added = 0
    for row in upstream_rows:
        if not isinstance(row, dict):
            continue
        store_ids = row.get("storeIds") or {}
        if isinstance(store_ids, dict) and store_ids.get("steam"):
            continue  # already has a Steam id, primary indexer handled it
        status = (row.get("status") or "").strip().lower()
        if status not in _VALID_STATUSES:
            continue
        key = _normalize_title(row.get("name") or "")
        if not key:
            continue
        app_id = title_to_appid.get(key)
        if not app_id or app_id in by_appid:
            continue
        vendors = row.get("anticheats") or []
        if not isinstance(vendors, list):
            vendors = []
        vendors = sorted({str(v).strip() for v in vendors if str(v).strip()})
        by_appid[app_id] = {"status": status, "vendors": vendors}
        added += 1
    return added


def _detect_vendors_from_text(*texts: str) -> list[str]:
    """Return the list of vendor names whose substrings appear in the given text
    fields. Empty list when nothing matches.
    """
    joined = " ".join(t.lower() for t in texts if t)
    if not joined:
        return []
    found = []
    for vendor, needles in _APPDETAILS_VENDOR_PATTERNS.items():
        if any(n in joined for n in needles):
            found.append(vendor)
    return sorted(set(found))


def _fetch_appdetails_snippets(app_id: str) -> tuple[str, str] | None:
    """Return (drm_notice, about_the_game) for one Steam appid, or None on any
    failure. Uses the public storefront endpoint -- Steam sends CORS headers so
    a curl works the same as fetch().
    """
    url = STEAM_APPDETAILS_URL.format(appid=app_id)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=_APPDETAILS_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    app_data = data.get(str(app_id), {})
    if not isinstance(app_data, dict) or not app_data.get("success"):
        return None
    payload = app_data.get("data") or {}
    if not isinstance(payload, dict):
        return None
    drm = str(payload.get("drm_notice") or "")
    about = str(payload.get("about_the_game") or "")
    return drm, about


def _scan_appdetails_for_vendors(
    entries: list, by_appid: dict[str, dict], cache: dict,
) -> int:
    """Scan Steam appdetails for anti-cheat vendor mentions on games that
    AreWeAntiCheatYet does not cover. Writes only when we find at least one
    vendor. Status is None (no Linux verdict) so the frontend can show
    "Uses <vendor>" without falsely claiming a compat rating.

    Uses the same appdetails cache the primary AreWeAntiCheatYet fetch already
    persists so re-runs skip work. Respects PROBE_CAP + wall-clock budget +
    consecutive-failure bail so a Steam rate-limit does not stall finalize.
    """
    scan_cache = cache.setdefault("appdetails_scan", {})
    # Candidates: numeric Steam appids we do not already have a verdict for
    # and that have not been probed yet.
    candidates: list[str] = []
    for row in entries:
        if not isinstance(row, list) or len(row) < 6:
            continue
        app_id = str(row[0])
        if not app_id.isdigit() or app_id in by_appid or app_id in scan_cache:
            continue
        candidates.append(app_id)
    if not candidates:
        return 0

    to_probe = candidates[:APPDETAILS_PROBE_CAP]
    log(
        f"[anti-cheat] appdetails vendor scan: {len(candidates)} candidates, "
        f"probing {len(to_probe)} (cap {APPDETAILS_PROBE_CAP})"
    )

    deadline = time.time() + APPDETAILS_WALL_CLOCK_BUDGET_SEC
    consecutive_failures = 0
    added = 0
    for app_id in to_probe:
        if time.time() > deadline:
            log("[anti-cheat] appdetails vendor scan: wall-clock budget hit, stopping")
            break
        if consecutive_failures >= APPDETAILS_CONSECUTIVE_FAILURE_LIMIT:
            log("[anti-cheat] appdetails vendor scan: transport failures, stopping")
            break
        snippets = _fetch_appdetails_snippets(app_id)
        time.sleep(_APPDETAILS_DELAY)
        if snippets is None:
            consecutive_failures += 1
            continue
        consecutive_failures = 0
        drm, about = snippets
        vendors = _detect_vendors_from_text(drm, about)
        # Cache the probe outcome either way so we do not re-hit Steam for
        # this app until the cache is manually invalidated.
        scan_cache[app_id] = {"vendors": vendors, "probed_at": int(time.time())}
        if vendors:
            by_appid[app_id] = {"status": None, "vendors": vendors}
            added += 1
    log(f"[anti-cheat] appdetails vendor scan: added {added} apps with detected vendors")
    return added


def enrich_search_index_with_anti_cheat(output_dir: Path) -> None:
    """Merge anti-cheat status + vendors into search-index columns 10 + 11.

    Pads shorter rows with None so both columns land at the expected index
    regardless of what upstream enrichers wrote. Rows without a cache hit
    get None in both slots so the frontend can distinguish "no anti-cheat
    data" from "no anti-cheat".
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[anti-cheat] search-index.json missing, skipping enrichment")
        return

    try:
        entries = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[anti-cheat] WARN: could not read search-index.json: {exc}")
        return
    if not isinstance(entries, list) or not entries:
        return

    by_appid = refresh_cache(output_dir)

    # #242 followup: broaden coverage beyond AreWeAntiCheatYet's ~698 Steam-
    # tagged rows. Two extra passes, both cheap and both persistent.
    cache_path = output_dir / CACHE_FILENAME
    persistent_cache = _load_cache(cache_path)
    upstream_snapshot = persistent_cache.get("upstream_snapshot") or []

    # Pass A: title-match backfill for AreWeAntiCheatYet rows without a Steam id.
    if upstream_snapshot:
        backfilled = _backfill_from_search_index_titles(upstream_snapshot, by_appid, entries)
        if backfilled:
            log(f"[anti-cheat] title-match backfill: added {backfilled} apps")

    # Pass B: Steam appdetails vendor scan for games AreWeAntiCheatYet does
    # not cover at all. Status is None so the frontend can render "Uses
    # <vendor>" without a Linux verdict.
    scan_added = _scan_appdetails_for_vendors(entries, by_appid, persistent_cache)

    # Persist the appdetails scan cache so future runs skip probed apps.
    # Refresh_cache already wrote upstream to disk; we only need to save
    # the additive scan_cache changes here.
    persistent_cache["by_appid"] = by_appid
    _save_cache(cache_path, persistent_cache)

    hits = 0
    for row in entries:
        if not isinstance(row, list) or not row:
            continue
        # Pad to at least 12 columns so col 10 + 11 land at the right index.
        while len(row) < 12:
            row.append(None)
        app_id = str(row[0])
        info = by_appid.get(app_id)
        if info:
            row[10] = info["status"]
            row[11] = info["vendors"] or None
            hits += 1
        else:
            # Keep any previous value if a prior enricher already wrote here
            # (defensive: no other enricher owns these columns today).
            if row[10] is None:
                row[10] = None
            if row[11] is None:
                row[11] = None

    index_path.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
    log(f"[anti-cheat] enriched {hits}/{len(entries)} search-index rows")

    # Also publish data/anti-cheat.json so the plugin (and any other client)
    # can consume the full mapping directly. Frontend uses search-index for
    # the filter chip; this mirror is for per-app deep dives.
    published = output_dir / "anti-cheat.json"
    published.write_text(json.dumps(by_appid, separators=(",", ":")), encoding="utf-8")
