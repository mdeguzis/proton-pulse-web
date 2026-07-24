"""Enrich search-index.json with PCGamingWiki metadata (#377 slice 1).

Data source: PCGamingWiki Cargo API. One paginated query against the
`Infobox_game` cargo table gives us everything we need per game:

    Steam_AppID  -> {os: ["windows", "linux", ...], engine: "Unreal Engine 4"}

Real Cargo field names (verified against the live schema, not the
public docs which drift):
  - `Steam_AppID` is a virtual list field. Bulk-filter with the
    reified `Steam_AppID__full` scalar; per-row payloads still contain
    the comma-separated list.
  - `Available_on` is a scalar comma-list of OS names ("Windows,OS X,Linux,DOS").
  - `Engines` is a scalar comma-list prefixed with the wiki namespace
    ("Engine:Source,Engine:Unity"). We strip the "Engine:" prefix on
    read and keep the first entry.
  - `_pageName` cannot be projected under its raw name -- Cargo rejects
    field aliases that start with underscore -- so we alias every field.

Cached to `pcgamingwiki-cache.json` on disk with a weekly TTL; a
network / API failure falls back to the on-disk cache so a broken
PCGW day never wipes the enrichment.

Columns written to search-index rows:
    col 14: pgw_os     -- lowercased list of natively-supported OS names
                          ("windows", "linux", "os x", "dos"). None when
                          no PGWiki OS entry exists for the game.
    col 15: pgw_engine -- engine name string or None.

Both default to None for apps not in the cache. Rows are padded so col 14
and 15 land at the expected index regardless of what earlier enrichers
wrote at 6, 7, 10, 11, 12, or 13.

License: PCGamingWiki content is CC BY-NC-SA 3.0. Any user-facing surface
that shows this data needs an attribution link back to the source page.
Attribution boilerplate lives in `proton-pulse-web-wiki/Data-Pipeline.md`.
"""
from __future__ import annotations

import http.cookiejar
import json
import os as _os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .common import log

# Cargo endpoint. Every request must carry a descriptive User-Agent WITH
# contact information per https://www.pcgamingwiki.com/wiki/PCGamingWiki:API
# ("clientname/version (contact information) framework/version") -- generic
# UA strings get 403 banned.
CARGO_URL = "https://www.pcgamingwiki.com/w/api.php"
USER_AGENT = (
    "proton-pulse-web/pipeline "
    "(https://www.proton-pulse.com; mdeguzis@gmail.com) python-urllib"
)

CACHE_FILENAME = "pcgamingwiki-cache.json"

# Fresh cadence: weekly. PCGW is community-edited and moves slowly enough
# that a daily fetch wastes their capacity for zero benefit.
FRESH_TTL_SEC = 7 * 24 * 3600

# Cargo pagination. 500 is the documented max per call. PCGW enforces a
# hard 30 requests/minute per IP (429 + 60s IP block past it -- see
# PCGamingWiki:API), so the inter-request delay must stay >= 2.0s; 2.1
# leaves margin for request latency jitter. ~100 pages for the full
# catalog means a weekly refresh costs ~3.5 min, which is fine.
CARGO_LIMIT = 500
CARGO_DELAY_SEC = 2.1
CARGO_TIMEOUT = 20

# On HTTP 429 PCGW blocks the IP for 60 seconds; retrying sooner just
# resets the clock. Wait the documented block window plus margin.
RATE_LIMIT_COOLDOWN_SEC = 65

# Safety cap: if pagination ever loops or PCGW returns unbounded rows,
# stop rather than burn the CI budget. ~50k games with Steam IDs is
# comfortably above the current catalog.
MAX_PAGES = 200

# Overridable via env so a manual dispatch can force a fresh fetch even
# when the on-disk cache is still within its TTL.
FORCE_REFRESH = _os.environ.get("PCGAMINGWIKI_FORCE_REFRESH", "").lower() in ("1", "true", "yes")

# MediaWiki bot-password credentials (#387). PCGW staff confirmed (Discord,
# 2026-07-24) that bot passwords created under a personal SSO account via
# Special:BotPasswords are the supported way to authenticate API reads
# (action=login, the older login method). Anonymous reads remain allowed and
# are the fallback when either var is unset or login fails. The bot password
# needs Basic rights ONLY -- cargoquery reads are covered; grant nothing
# else. Auth does NOT lift the 30 req/min per-IP limit, so the pacing and
# 429 cooldown below stay regardless of login state.
_BOT_USER = _os.environ.get("PCGAMINGWIKI_BOT_USER", "").strip()
_BOT_PASS = _os.environ.get("PCGAMINGWIKI_BOT_PASS", "").strip()

# maxlag politely tells the MediaWiki server "if you are busy, 503 me
# instead of hurting". Value in seconds; 5 is the standard bot value per
# https://www.mediawiki.org/wiki/Manual:Maxlag_parameter
MAXLAG_SEC = 5

# Whitelist of OS strings we accept from PCGW's `Available_on` field.
# Anything else gets dropped so an unexpected value ("Web" experimentation,
# console ports) does not surface in the frontend without a schema review.
_VALID_OS = {"windows", "os x", "linux", "dos"}

# Field alias map used in every Cargo query. Aliases MUST NOT start with
# underscore -- Cargo's `cargoquery-invalidfieldalias` error blocks that.
_CARGO_FIELDS = "_pageName=page,Steam_AppID=appId,Engines=engines,Available_on=available"

# Bulk WHERE clause: virtual list fields need the reified `__full` suffix.
_CARGO_WHERE_BULK = "Steam_AppID__full IS NOT NULL AND Steam_AppID__full != ''"

# Namespace prefix stripped from every engine value ("Engine:Unity" -> "Unity").
_ENGINE_NAMESPACE_PREFIX = "Engine:"


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
        log(f"[pcgamingwiki] WARN: could not read cache: {exc}")
        return {"fetched_at": 0, "by_appid": {}}


def _save_cache(cache_path: Path, cache: dict) -> None:
    cache_path.write_text(json.dumps(cache, sort_keys=True), encoding="utf-8")


# Shared urllib opener with a cookie jar so the one-time bot login carries
# its session cookie through the entire pagination. Constructed lazily on
# first call to _cargo_get and reused for the rest of the process.
# Anonymous fallback: same opener without the login step.
_session_opener: urllib.request.OpenerDirector | None = None
_session_logged_in: bool = False


def _reset_session_for_tests() -> None:
    """Reset the memoized opener + login flag. Only for unit tests -- the
    module is process-scoped in production and we do not want to re-login on
    every Cargo call.
    """
    global _session_opener, _session_logged_in
    _session_opener = None
    _session_logged_in = False


def _build_session_opener() -> urllib.request.OpenerDirector:
    """Return a memoized opener with the contact-info User-Agent attached.

    Attempts a MediaWiki bot login when PCGAMINGWIKI_BOT_USER +
    PCGAMINGWIKI_BOT_PASS are set; falls back to anonymous (allowed for
    reads) when they are missing or login fails. addheaders applies to
    every request the opener makes so we do not need to set User-Agent
    per Request. Login or not, the 30 req/min per-IP pacing applies.
    """
    global _session_opener, _session_logged_in
    if _session_opener is not None:
        return _session_opener
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [
        ("User-Agent", USER_AGENT),
        ("Accept", "application/json"),
    ]
    if _BOT_USER and _BOT_PASS:
        try:
            _mediawiki_bot_login(opener)
            _session_logged_in = True
            log(f"[pcgamingwiki] authenticated as bot user {_BOT_USER}")
        except Exception as exc:
            log(f"[pcgamingwiki] WARN: bot login failed ({exc}); proceeding anonymously")
    _session_opener = opener
    return opener


def _mediawiki_bot_login(opener: urllib.request.OpenerDirector) -> None:
    """Two-step MediaWiki login (https://www.mediawiki.org/wiki/API:Login,
    action=login with a bot password). Raises on any failure so the caller
    can decide whether to fall back to anonymous.

    Step 1: `action=query&meta=tokens&type=login` -> logintoken
    Step 2: `action=login&lgname=...&lgpassword=...&lgtoken=...` -> Success

    Cookies from step 2 land in the opener's CookieJar and get sent on every
    subsequent request.
    """
    if not CARGO_URL.startswith("https://"):
        raise RuntimeError("CARGO_URL scheme is not https:// -- refusing to log in")
    # Step 1: fetch a login token.
    token_url = f"{CARGO_URL}?{urllib.parse.urlencode({'action': 'query', 'meta': 'tokens', 'type': 'login', 'format': 'json'})}"
    with opener.open(token_url, timeout=CARGO_TIMEOUT) as resp:  # nosec B310  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected - URL is the CARGO_URL constant with a fixed action=query
        body = json.loads(resp.read().decode("utf-8"))
    logintoken = body.get("query", {}).get("tokens", {}).get("logintoken")
    if not logintoken:
        raise RuntimeError(f"no logintoken in response: {body!r}")
    # Step 2: POST the login. Note: `action=login` on MediaWiki MUST be POST.
    data = urllib.parse.urlencode({
        "action": "login",
        "lgname": _BOT_USER,
        "lgpassword": _BOT_PASS,
        "lgtoken": logintoken,
        "format": "json",
    }).encode("utf-8")
    req = urllib.request.Request(CARGO_URL, data=data, method="POST")
    with opener.open(req, timeout=CARGO_TIMEOUT) as resp:  # nosec B310  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected - CARGO_URL is the fixed constant
        result = json.loads(resp.read().decode("utf-8"))
    outcome = result.get("login", {}).get("result", "")
    if outcome != "Success":
        raise RuntimeError(f"login result={outcome!r}: {result!r}")


def _cargo_get(params: dict) -> dict | None:
    """One-shot Cargo API GET. Returns the parsed JSON dict on success, None
    on any transport / parse failure. Enforces https:// on the endpoint so a
    future edit that swaps CARGO_URL for a caller-supplied value cannot smuggle
    a file:// URL through urlopen. Every request carries maxlag=5 so the
    MediaWiki server can 503 us politely during high load rather than tipping
    over.
    """
    if not CARGO_URL.startswith("https://"):
        log("[pcgamingwiki] WARN: CARGO_URL scheme is not https:// -- refusing to fetch")
        return None
    params = {**params, "maxlag": MAXLAG_SEC}
    qs = urllib.parse.urlencode(params)
    url = f"{CARGO_URL}?{qs}"
    opener = _build_session_opener()
    try:
        with opener.open(url, timeout=CARGO_TIMEOUT) as resp:  # nosec B310  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected - URL is the fixed CARGO_URL constant with querystring params interpolated
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # 429 = we tripped the 30 req/min limit and the IP is blocked for
        # 60s. Retrying sooner just resets the block, so wait it out once
        # and retry the same request. A second 429 means pacing is broken
        # somewhere -- give up and let the caller fall back to disk cache.
        if exc.code == 429:
            log(f"[pcgamingwiki] WARN: HTTP 429 rate limited -- cooling down {RATE_LIMIT_COOLDOWN_SEC}s before one retry")
            time.sleep(RATE_LIMIT_COOLDOWN_SEC)
            try:
                with opener.open(url, timeout=CARGO_TIMEOUT) as resp:  # nosec B310  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected - same fixed CARGO_URL retry
                    body = resp.read().decode("utf-8")
            except Exception as retry_exc:
                log(f"[pcgamingwiki] WARN: retry after 429 failed: {retry_exc}")
                return None
        else:
            log(f"[pcgamingwiki] WARN: cargo fetch failed: HTTP {exc.code} {exc.reason}")
            return None
    except Exception as exc:
        log(f"[pcgamingwiki] WARN: cargo fetch failed: {exc}")
        return None
    try:
        data = json.loads(body)
    except Exception as exc:
        log(f"[pcgamingwiki] WARN: cargo JSON parse failed: {exc}")
        return None
    if not isinstance(data, dict):
        return None
    # MediaWiki signals lag pressure via `error: {code: "maxlag", ...}` with a
    # 200 HTTP status. Surface it clearly instead of failing silently -- the
    # caller's retry loop can back off.
    err = data.get("error")
    if isinstance(err, dict) and err.get("code") == "maxlag":
        log(f"[pcgamingwiki] WARN: server maxlag pressure -- {err.get('info', '')}")
    return data


def _paginate_cargo(tables: str, fields: str, where: str) -> list[dict]:
    """Walk every page of a Cargo query. Returns the flattened row list."""
    out: list[dict] = []
    for page in range(MAX_PAGES):
        payload = _cargo_get({
            "action": "cargoquery",
            "format": "json",
            "tables": tables,
            "fields": fields,
            "where": where,
            "limit": CARGO_LIMIT,
            "offset": page * CARGO_LIMIT,
        })
        if payload is None:
            log(f"[pcgamingwiki] pagination stopped at page {page} (network error)")
            return out
        rows = payload.get("cargoquery") or []
        if not isinstance(rows, list) or not rows:
            return out
        # Cargo wraps each row's fields under a "title" key. Unwrap so
        # downstream code sees a flat dict per row.
        for row in rows:
            if isinstance(row, dict):
                title = row.get("title")
                if isinstance(title, dict):
                    out.append(title)
        if len(rows) < CARGO_LIMIT:
            return out
        time.sleep(CARGO_DELAY_SEC)
    log(f"[pcgamingwiki] hit MAX_PAGES ({MAX_PAGES}); truncating")
    return out


def _fetch_infobox_rows() -> list[dict] | None:
    """Fetch every Infobox_game row that has a Steam_AppID.

    Returns unwrapped title dicts with keys: page, appId, engines, available.
    Returns None if the very first page fails so refresh_cache can fall
    back to the on-disk cache without partial merging.
    """
    payload = _cargo_get({
        "action": "cargoquery",
        "format": "json",
        "tables": "Infobox_game",
        "fields": _CARGO_FIELDS,
        "where": _CARGO_WHERE_BULK,
        "limit": CARGO_LIMIT,
        "offset": 0,
    })
    if payload is None:
        return None
    rows: list[dict] = []
    first = payload.get("cargoquery") or []
    for row in first:
        if isinstance(row, dict):
            title = row.get("title")
            if isinstance(title, dict):
                rows.append(title)
    if len(first) < CARGO_LIMIT:
        return rows
    # Continue paginating past the first page.
    tail = _paginate_cargo(
        tables="Infobox_game",
        fields=_CARGO_FIELDS,
        where=_CARGO_WHERE_BULK,
    )
    # `_paginate_cargo` restarts at page 0. Skip the first page's worth of
    # rows to avoid double-counting.
    return rows + tail[CARGO_LIMIT:]


def _index_by_appid(infobox_rows: list[dict]) -> dict[str, dict]:
    """Build `{steam_appid: {os, engine}}` from the Cargo title rows.

    Bundles (multiple appids per PCGW page) fan out: every listed appid
    inherits the page's OS + engine so a wishlist search by any of them
    lands on the enrichment. Rows carrying neither OS nor engine are
    dropped so the cache does not bloat with dead entries.
    """
    out: dict[str, dict] = {}
    for row in infobox_rows:
        if not isinstance(row, dict):
            continue
        page = str(row.get("page") or "").strip()
        steam_field = str(row.get("appId") or "").strip()
        if not page or not steam_field:
            continue
        engine = _first_engine(row.get("engines"))
        os_names = _parse_available_on(row.get("available"))
        if not os_names and not engine:
            continue
        entry = {"os": os_names, "engine": engine}
        for appid in _all_numeric(steam_field):
            # First-writer-wins so a duplicate appid across pages does not
            # thrash. In practice bundles overlap rarely.
            out.setdefault(appid, entry)
    return out


def _parse_available_on(field) -> list[str]:
    """Parse `Available_on` ("Windows,OS X,Linux") into a sorted lowercase list.

    Filters to `_VALID_OS` so an unexpected value ("Web") does not surface
    without a schema review.
    """
    if not field:
        return []
    seen: set[str] = set()
    for token in str(field).split(","):
        name = token.strip().lower()
        if name in _VALID_OS:
            seen.add(name)
    return sorted(seen)


def _first_numeric(field: str) -> str | None:
    """Extract the first digits-only token from a comma / whitespace list."""
    for token in _all_numeric(field):
        return token
    return None


def _all_numeric(field: str) -> list[str]:
    """Extract every digits-only token from a comma / semicolon list. Used
    for PCGW pages with multiple Steam_AppIDs -- each numeric token maps
    back to a real appid we want to enrich.
    """
    if not field:
        return []
    out: list[str] = []
    for token in str(field).replace(";", ",").split(","):
        stripped = token.strip()
        if stripped.isdigit() and stripped not in out:
            out.append(stripped)
    return out


def _first_engine(field) -> str | None:
    """PCGW ships engines as `Engine:Source,Engine:Unity`. Strip the wiki
    namespace prefix and keep the first non-empty entry. Empty / non-string
    values -> None.
    """
    if not field:
        return None
    text = str(field).strip()
    if not text:
        return None
    for token in text.split(","):
        name = token.strip()
        if name.startswith(_ENGINE_NAMESPACE_PREFIX):
            name = name[len(_ENGINE_NAMESPACE_PREFIX):].strip()
        if name:
            return name
    return None


def refresh_cache(output_dir: Path, force: bool = False) -> dict[str, dict]:
    """Load or refresh the PCGW cache. Returns `{appid: {os, engine}}`.

    Refreshes when the cache is missing, stale, or `force` (or the
    PCGAMINGWIKI_FORCE_REFRESH env var). Falls back to the on-disk cache
    when the network is down so a broken PCGW day never wipes the
    enrichment.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    now = int(time.time())
    fresh_enough = (now - int(cache.get("fetched_at") or 0)) < FRESH_TTL_SEC
    if fresh_enough and not (force or FORCE_REFRESH) and cache.get("by_appid"):
        log(
            f"[pcgamingwiki] cache hit ({len(cache['by_appid'])} apps, "
            f"age {now - int(cache['fetched_at'])}s)"
        )
        return cache["by_appid"]

    log("[pcgamingwiki] refreshing from cargo API")
    infobox = _fetch_infobox_rows()
    if infobox is None:
        log(f"[pcgamingwiki] cargo unreachable; using {len(cache['by_appid'])} cached rows")
        return cache["by_appid"]

    by_appid = _index_by_appid(infobox)
    cache = {
        "fetched_at": now,
        "by_appid": by_appid,
    }
    _save_cache(cache_path, cache)
    log(f"[pcgamingwiki] cached {len(by_appid)} apps (of {len(infobox)} infobox rows)")
    return by_appid


def enrich_search_index_with_pcgamingwiki(output_dir: Path) -> None:
    """Merge PCGW OS + engine into search-index cols 14 + 15.

    Pads shorter rows with None so both columns land at the expected
    index regardless of what upstream enrichers wrote. Rows without a
    cache hit get None in both slots so the frontend can distinguish
    "no PCGW data" from "runs on nothing but Windows".
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[pcgamingwiki] search-index.json missing, skipping enrichment")
        return

    try:
        entries = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[pcgamingwiki] WARN: could not read search-index.json: {exc}")
        return
    if not isinstance(entries, list) or not entries:
        return

    by_appid = refresh_cache(output_dir)

    hits = 0
    for row in entries:
        if not isinstance(row, list) or not row:
            continue
        # Pad to at least 16 columns so cols 14 + 15 land at the right index
        # without disturbing cols 10-13 (owned by other enrichers).
        while len(row) < 16:
            row.append(None)
        app_id = str(row[0])
        info = by_appid.get(app_id)
        if info:
            row[14] = info["os"] or None
            row[15] = info["engine"] or None
            hits += 1

    index_path.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
    log(f"[pcgamingwiki] enriched {hits}/{len(entries)} search-index rows")

    # Also publish the full mapping so the plugin / other clients can consume
    # per-app deep dives without re-reading search-index.
    published = output_dir / "pcgamingwiki.json"
    published.write_text(json.dumps(by_appid, separators=(",", ":")), encoding="utf-8")
