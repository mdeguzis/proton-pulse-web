"""Emit PCGamingWiki catalog entries (#377 slice 3, reworked in #406).

Slice 1 enriched existing Steam entries with PCGW metadata. This pass goes
the other direction: it fetches every PCGamingWiki game with a Windows
build (so Proton can run it) and merges them into `search-index.json` as
new rows keyed by a short deterministic hash id `pw_<8-char-base36>`.

#406: games that ALSO exist on Steam / GOG get an entry too -- a user with
a physical CD-ROM copy has no Steam appid to report against, so the PCGW
entry is where their report goes. Earlier revisions excluded those rows;
that WHERE filter is gone.

The id is `pw_` + the first 48 bits of sha256(<wiki page slug>) encoded
as 8 base36 chars (e.g. `pw_xd71ad9b`). Deterministic (same page name
always hashes to the same id, so re-runs are stable with no registry to
persist), short enough for URLs / dropdowns / DB keys, and unambiguously
non-Steam. Collision space is 36^8 = 2.8 trillion; PCGW is ~50k games.
`pcgw-id-map.json` publishes the id -> slug map so old `pgwiki:<slug>`
links and rows can be translated.

Query criteria (Infobox_game):
  Available_on HOLDS "Windows"    -- has a Windows build (Proton runs it)

Excluded on purpose: DOS-only entries. Proton does not play DOS games,
so those would just clutter the catalog. Adding them is out of scope
for this slice; a future slice can add DOSBox-flagged entries if needed.

Emits:
  pcgwiki-catalog.json  { "pw_<hash>": {
                              name, slug, engine, developers[], publishers[],
                              release_year, wiki_url, steam_app_id, gog_id } }
  pcgw-id-map.json      { "pw_<hash>": "<slug>" }
  Merged into search-index.json as new rows:
    [ "pw_<hash>",      # col 0: canonical id
      <title>,          # col 1: game title
      "pending",        # col 2: tier (no ProtonDB verdict)
      0,                # col 3: protondb report count
      0,                # col 4: pulse report count
      "pgwiki",         # col 5: source
      <release year>,   # col 6
      None,             # col 7: delisted
      False,            # col 8: adult
      "",               # col 9: trend
      None,             # col 10: replaced_by
      None,             # col 11: steam_type
      None,             # col 12: ac_status
      None,             # col 13: ac_vendors
      ["windows"],      # col 14: pgw_os (always at least windows here)
      <engine>,         # col 15: pgw_engine
    ]

License: PCGamingWiki content is CC BY-NC-SA 3.0. The wiki_url points
back to the source page from every rendered stub.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .common import log
from .pcgamingwiki import (
    CARGO_DELAY_SEC,
    CARGO_LIMIT,
    CARGO_TIMEOUT,
    CARGO_URL,
    MAX_PAGES,
    USER_AGENT,
    _cargo_get,
    _first_engine,
    _parse_available_on,
)

CACHE_FILENAME = "pcgwiki-catalog-cache.json"
OUTPUT_FILENAME = "pcgwiki-catalog.json"
ID_MAP_FILENAME = "pcgw-id-map.json"

_PW_ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz"


def slug_to_pw_id(slug: str) -> str:
    """Deterministic short id for a PCGW page slug: `pw_` + 8 base36 chars.

    Uses the first 48 bits of sha256(slug). 36^8 = 2.8 trillion values --
    the birthday-collision threshold for a 50% chance is ~2M entries, far
    above PCGW's ~50k games. _build_entries still detects and logs any
    collision as a hard error rather than silently dropping a game.

    Keep in sync with js/lib/app-id.js pcgwSlugToPwId (frontend redirect
    for old pgwiki:<slug> URLs computes the same hash).
    """
    n = int.from_bytes(hashlib.sha256(slug.encode("utf-8")).digest()[:6], "big")
    chars = []
    for _ in range(8):
        chars.append(_PW_ID_CHARS[n % 36])
        n //= 36
    return "pw_" + "".join(chars)

# Weekly refresh matches the metadata enricher. PCGW catalog changes slowly.
FRESH_TTL_SEC = 7 * 24 * 3600

# Query shape. Field aliases must NOT start with underscore (Cargo blocks it).
# `Cover_URL` is PGWiki's pre-resolved image URL -- no follow-up File: lookup
# needed. Kept as a final-resort boxart source (#375 tier 4) since covers
# are typically portrait product-shots, not widescreen hero art.
_CARGO_FIELDS = ",".join([
    "_pageName=page",
    "Steam_AppID=appId",
    "GOGcom_ID=gogId",
    "Engines=engines",
    "Available_on=available",
    "Released_Windows=relWin",
    "Developers=developers",
    "Publishers=publishers",
    "Cover_URL=coverUrl",
])

# #406: no Steam / GOG exclusion -- every Windows game gets a PCGW entry so
# physical-copy owners have something to report against. The Steam_AppID /
# GOGcom_ID fields are still fetched and stored on the entry for cross-refs.
_CARGO_WHERE = "Available_on HOLDS \"Windows\""

# Match the enricher's namespace strip for the Company / Engine prefixes.
_COMPANY_NAMESPACE_PREFIX = "Company:"
_ENGINE_NAMESPACE_PREFIX = "Engine:"


def _load_cache(cache_path: Path) -> dict:
    if not cache_path.exists():
        return {"fetched_at": 0, "entries": {}}
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"fetched_at": 0, "entries": {}}
        data.setdefault("fetched_at", 0)
        data.setdefault("entries", {})
        # #406 migration: pre-hash caches are keyed `pgwiki:<slug>`. Re-key
        # them so the network-down fallback still serves usable ids, but
        # zero the timestamp -- the old cache only holds the no-Steam subset
        # and MUST be refetched to pick up the expanded catalog.
        entries = data["entries"]
        if isinstance(entries, dict) and any(k.startswith("pgwiki:") for k in entries):
            rekeyed: dict[str, dict] = {}
            for key, entry in entries.items():
                if not isinstance(entry, dict):
                    continue
                slug = key[len("pgwiki:"):] if key.startswith("pgwiki:") else str(entry.get("slug") or "")
                if not slug:
                    continue
                entry.setdefault("slug", slug)
                rekeyed[slug_to_pw_id(slug)] = entry
            data["entries"] = rekeyed
            data["fetched_at"] = 0
            log(f"[pcgwiki-catalog] migrated {len(rekeyed)} cache entries from pgwiki: keys to pw_ ids (refetch forced)")
        return data
    except Exception as exc:
        log(f"[pcgwiki-catalog] WARN: could not read cache: {exc}")
        return {"fetched_at": 0, "entries": {}}


def _save_cache(cache_path: Path, cache: dict) -> None:
    cache_path.write_text(json.dumps(cache, sort_keys=True), encoding="utf-8")


def _fetch_all_pages() -> list[dict] | None:
    """Walk every page of the catalog query. Returns the flattened row list
    or None if the very first page fails so the caller can fall back to the
    on-disk cache without a partial merge.
    """
    out: list[dict] = []
    for page in range(MAX_PAGES):
        payload = _cargo_get({
            "action": "cargoquery",
            "format": "json",
            "tables": "Infobox_game",
            "fields": _CARGO_FIELDS,
            "where": _CARGO_WHERE,
            "limit": CARGO_LIMIT,
            "offset": page * CARGO_LIMIT,
        })
        if payload is None:
            if page == 0:
                return None  # nothing to merge, force disk fallback
            log(f"[pcgwiki-catalog] pagination stopped at page {page} (network error)")
            return out
        rows = payload.get("cargoquery") or []
        if not isinstance(rows, list) or not rows:
            return out
        for row in rows:
            if isinstance(row, dict):
                title = row.get("title")
                if isinstance(title, dict):
                    out.append(title)
        if len(rows) < CARGO_LIMIT:
            return out
        time.sleep(CARGO_DELAY_SEC)
    log(f"[pcgwiki-catalog] hit MAX_PAGES ({MAX_PAGES}); truncating")
    return out


def _slugify_page_name(page: str) -> str:
    """Convert a PCGW page name into a URL-safe slug that mirrors the wiki's
    own URL scheme (spaces -> underscores, other chars percent-encoded).
    """
    # PCGW wiki URLs use MediaWiki's title convention: spaces become underscores
    # and the rest is left largely intact (colons, exclamation marks, etc).
    # A basic slug that keeps the raw title recognizable is more useful than
    # aggressive stripping.
    return page.replace(" ", "_")


def _year_from_iso(value) -> int | None:
    """PCGW ships release dates as YYYY-MM-DD (sometimes YYYY only). Pull the
    year and return an int, or None if we cannot parse it.
    """
    if not value:
        return None
    m = re.match(r"^(\d{4})", str(value))
    return int(m.group(1)) if m else None


def _split_company_list(field) -> list[str]:
    """PCGW ships developers / publishers as `Company:Foo,Company:Bar`.
    Strip the namespace prefix + trim.
    """
    if not field:
        return []
    out: list[str] = []
    for token in str(field).split(","):
        name = token.strip()
        if name.startswith(_COMPANY_NAMESPACE_PREFIX):
            name = name[len(_COMPANY_NAMESPACE_PREFIX):].strip()
        if name and name not in out:
            out.append(name)
    return out


def _build_entries(rows: list[dict]) -> dict[str, dict]:
    """Convert Cargo rows into `{pw_<hash>: {name, slug, engine, ...}}`.

    Rejects rows without a page name. Duplicate page names (Cargo sometimes
    returns a row per infobox) collapse first-writer-wins; a HASH collision
    between two DIFFERENT slugs is logged loudly and the later row dropped
    so a truncated 48-bit space can never silently merge two games.
    """
    out: dict[str, dict] = {}
    id_to_slug: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        page = str(row.get("page") or "").strip()
        if not page:
            continue
        # Must have a Windows entry -- Proton requires it.
        os_list = _parse_available_on(row.get("available"))
        if "windows" not in os_list:
            continue
        slug = _slugify_page_name(page)
        canonical_id = slug_to_pw_id(slug)
        if canonical_id in out:
            if id_to_slug.get(canonical_id) != slug:
                log(
                    f"[pcgwiki-catalog] ERROR: pw_id collision: {canonical_id} "
                    f"already maps to {id_to_slug.get(canonical_id)!r}, dropping {slug!r}"
                )
            continue
        engine = _first_engine(row.get("engines"))
        release_year = _year_from_iso(row.get("relWin"))
        # Cover_URL is pre-resolved by PGWiki to its images.pcgamingwiki.com
        # CDN. Nullable -- older wiki pages sometimes lack it. Frontend uses
        # this as the final-resort boxart tier (after SGDB) so PGWiki-only
        # entries at least get their wiki cover instead of the placeholder.
        cover_url = _clean_cover_url(row.get("coverUrl"))
        # #406: keep the store cross-refs when PCGW knows them. steam_app_id
        # lets the frontend link "also on Steam" from a physical-copy entry;
        # both stay None-able and are informational only.
        steam_app_id = str(row.get("appId") or "").strip().split(",")[0] or None
        gog_id = str(row.get("gogId") or "").strip().split(",")[0] or None
        entry = {
            "name": page,
            "slug": slug,
            "engine": engine,
            "developers": _split_company_list(row.get("developers")),
            "publishers": _split_company_list(row.get("publishers")),
            "release_year": release_year,
            "os": os_list,
            "wiki_url": f"https://www.pcgamingwiki.com/wiki/{urllib.parse.quote(slug)}",
            "cover_url": cover_url,
            "steam_app_id": steam_app_id,
            "gog_id": gog_id,
        }
        out[canonical_id] = entry
        id_to_slug[canonical_id] = slug
    return out


def _normalize_title_tokens(title: str) -> frozenset[str]:
    """Lowercase + strip punctuation + split into whitespace tokens.

    Used by the delisted cross-check to compare a PCGW title against
    the current Steam title for the same appid. Non-word chars collapse
    to spaces so "Solo Leveling: Arise" and "solo leveling arise" tokenize
    identically. Empty tokens dropped so a trailing punctuation does not
    inflate the set size and drag Jaccard down.
    """
    lower = (title or "").lower()
    normalized = re.sub(r"[^a-z0-9]+", " ", lower)
    return frozenset(t for t in normalized.split() if t)


# Title-token Jaccard threshold for the "Steam appid was repurposed"
# case (Rule B in the delisted cross-check). PCGW's "Solo Leveling:
# Arise" vs Steam's current "Solo Leveling: ARISE OVERDRIVE" scores
# 3/4 = 0.75. Comparison is inclusive so SLA-vs-OVERDRIVE (a real
# remake, not a rename) trips the rule. First-run candidates are
# logged verbose so the threshold can be reviewed against real data
# before tightening.
_RULE_B_JACCARD_THRESHOLD = 0.75  # jaccard <= this fires the rule


def _pcgw_steam_delisted_status(
    entry: dict,
    steam_title_by_appid: dict[str, str],
    rule_b_candidates: list[dict],
) -> tuple[bool, str | None]:
    """Return (delisted, replaced_by) for a PCGW catalog entry.

    Rule A: PCGW knows a Steam appid but Steam side of the search-index
    does not include it. Steam removed the app entirely, or the appid
    was never a real listing. Mark delisted and record the historical
    appid in replaced_by as "steam:<appid>" so the frontend can link out
    to steamdb historical page.

    Rule B: The Steam appid IS in the index but under a title that
    diverges from PCGW's title beyond the Jaccard threshold. Steam kept
    the appid but repurposed it for a different game (the SLA / SLA:O
    remake case). Mark delisted and record replaced_by the same way.
    Candidates are appended to rule_b_candidates for human review.

    When PCGW has no Steam appid at all, or the appid is present with a
    matching title, returns (False, None).
    """
    steam_app_id = str(entry.get("steam_app_id") or "").strip() or None
    if not steam_app_id:
        return False, None
    steam_title = steam_title_by_appid.get(steam_app_id)
    if steam_title is None:
        # Rule A: PCGW claims a Steam appid but Steam has no row for it.
        return True, f"steam:{steam_app_id}"
    pcgw_tokens = _normalize_title_tokens(entry.get("name") or "")
    steam_tokens = _normalize_title_tokens(steam_title)
    if not pcgw_tokens or not steam_tokens:
        return False, None
    union = pcgw_tokens | steam_tokens
    inter = pcgw_tokens & steam_tokens
    jaccard = len(inter) / len(union) if union else 0.0
    if jaccard <= _RULE_B_JACCARD_THRESHOLD:
        rule_b_candidates.append({
            "pcgw_title": entry.get("name"),
            "steam_title": steam_title,
            "steam_app_id": steam_app_id,
            "jaccard": round(jaccard, 3),
        })
        return True, f"steam:{steam_app_id}"
    return False, None


def _clean_cover_url(value) -> str | None:
    """PGWiki ships `Cover_URL` as a pre-resolved HTTPS URL. Belt-and-braces:
    require https:// on the images.pcgamingwiki.com host and reject anything
    else so a schema drift cannot smuggle a data: / javascript: / http: URL
    into the frontend.
    """
    if not value:
        return None
    text = str(value).strip()
    if not text.startswith("https://images.pcgamingwiki.com/"):
        return None
    return text


def refresh_catalog(output_dir: Path, force: bool = False) -> dict[str, dict]:
    """Load or refresh the catalog cache. Returns `{pw_<hash>: entry}`.

    Falls back to the on-disk cache when the network is down so a broken
    PCGW day never wipes the catalog.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    now = int(time.time())
    fresh_enough = (now - int(cache.get("fetched_at") or 0)) < FRESH_TTL_SEC
    if fresh_enough and not force and cache.get("entries"):
        log(f"[pcgwiki-catalog] cache hit ({len(cache['entries'])} entries, age {now - int(cache['fetched_at'])}s)")
        return cache["entries"]

    log("[pcgwiki-catalog] refreshing from cargo API")
    rows = _fetch_all_pages()
    if rows is None:
        # None covers both a dead endpoint and a query the server rejected
        # with a 200 (#497) -- either way we have no rows and must not treat
        # that as an empty catalog.
        log(f"[pcgwiki-catalog] cargo fetch failed; using {len(cache['entries'])} cached entries")
        return cache["entries"]

    entries = _build_entries(rows)

    # An empty result must never replace a catalog we already have. _cargo_get
    # returns None for a rejected query now (#497), so reaching here with zero
    # rows should mean PCGW genuinely has no Windows games -- which is never
    # true. Treating it as real is what emptied the published catalog: the run
    # logged "cached 0 entries" like a normal day and wrote {} over thousands
    # of entries, and every later run repeated it from the now-empty cache.
    if not entries and cache.get("entries"):
        log(
            f"[pcgwiki-catalog] ERROR: refresh produced 0 entries but cache holds "
            f"{len(cache['entries'])}; keeping the cache. Upstream query returned "
            f"no rows without reporting an error."
        )
        return cache["entries"]

    cache = {"fetched_at": now, "entries": entries}
    _save_cache(cache_path, cache)
    log(f"[pcgwiki-catalog] cached {len(entries)} entries (of {len(rows)} candidate rows)")
    return entries


def merge_catalog_into_search_index(output_dir: Path) -> None:
    """Add one row per PCGWiki-only entry to `search-index.json`.

    Rows carry the same 16-column shape the enrichers write, filled with
    sensible defaults for a stub game (tier=pending, 0 reports, Windows
    OS list from PCGW). Existing rows are left alone so a re-run does
    not duplicate an entry.

    #434 delisted cross-check: every PCGW entry with a Steam appid gets
    checked against the Steam side of the search-index. Two rules mark
    the pw_ row as delisted:
      - Rule A: PCGW's steam_app_id is not in the Steam side of the
        index. Steam removed it, or it never existed.
      - Rule B: The Steam appid IS in the index but under a title that
        diverges from PCGW's title beyond a token-Jaccard threshold.
        That is the "appid repurposed" case (SLA / SLA:O -- Netmarble
        reused 2373990 for the OVERDRIVE remake).
    Rule B candidates are logged verbose so a first run can be reviewed.
    """
    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[pcgwiki-catalog] search-index.json missing, skipping merge")
        return

    try:
        entries_index = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[pcgwiki-catalog] WARN: could not read search-index.json: {exc}")
        return
    if not isinstance(entries_index, list):
        return

    catalog = refresh_catalog(output_dir)
    if not catalog:
        log("[pcgwiki-catalog] catalog empty; nothing to merge")
        return

    # #406: drop legacy `pgwiki:<slug>` rows from earlier runs -- the same
    # game re-merges below under its pw_ hash id. Leaving both would show
    # every PCGW game twice in search.
    before = len(entries_index)
    entries_index = [
        row for row in entries_index
        if not (isinstance(row, list) and row and str(row[0]).startswith("pgwiki:"))
    ]
    dropped = before - len(entries_index)
    if dropped:
        log(f"[pcgwiki-catalog] dropped {dropped} legacy pgwiki: rows (re-keyed to pw_ ids)")

    # Build a title lookup from the Steam side so the cross-check does
    # not do a linear scan per pw_ entry. Keys are the raw appid strings.
    steam_title_by_appid: dict[str, str] = {}
    for row in entries_index:
        if not (isinstance(row, list) and len(row) >= 6):
            continue
        if row[5] == "steam":
            steam_title_by_appid[str(row[0])] = str(row[1] or "")

    # Two-track pass: pw_ rows already in the index need their delisted
    # flag re-evaluated (otherwise a game like Solo Leveling: Arise that
    # was stubbed on a prior run never picks up the Rule B flag when we
    # ship the cross-check later). New pw_ rows still append.
    existing_ids: set[str] = set()
    existing_pw_indices: dict[str, int] = {}
    for i, row in enumerate(entries_index):
        if not (isinstance(row, list) and row):
            continue
        rid = str(row[0])
        existing_ids.add(rid)
        if rid.startswith("pw_"):
            existing_pw_indices[rid] = i

    added = 0
    updated = 0
    delisted_A = 0
    delisted_B = 0
    rule_b_candidates: list[dict] = []
    for canonical_id, entry in sorted(catalog.items()):
        delisted, replaced_by = _pcgw_steam_delisted_status(
            entry, steam_title_by_appid, rule_b_candidates,
        )
        if delisted:
            # Rule A vs Rule B tally: A fires only when the PCGW-known
            # steam_app_id is missing from the Steam side of the index;
            # B fires when it is present but title diverges. Both encode
            # replaced_by as "steam:<appid>" so we distinguish here by
            # re-checking membership rather than inspecting the string.
            sid = str(entry.get("steam_app_id") or "").strip()
            if sid and sid in steam_title_by_appid:
                delisted_B += 1
            else:
                delisted_A += 1
        if canonical_id in existing_pw_indices:
            # Update in place. Pad legacy short rows to full 16-col shape.
            idx = existing_pw_indices[canonical_id]
            row = entries_index[idx]
            while len(row) < 16:
                row.append(None)
            new_flag = delisted if delisted else None
            if row[7] != new_flag or row[10] != replaced_by:
                row[7] = new_flag
                row[10] = replaced_by
                updated += 1
            continue
        if canonical_id in existing_ids:
            # A non-pw_ row somehow collided on id -- leave it alone.
            continue
        row = [
            canonical_id,                      # 0: id
            entry["name"],                     # 1: title
            "pending",                          # 2: tier (no ProtonDB verdict)
            0,                                  # 3: protondb reports
            0,                                  # 4: pulse reports
            "pgwiki",                          # 5: source
            entry.get("release_year"),         # 6: releaseYear
            delisted if delisted else None,    # 7: delisted (#434 cross-check)
            False,                              # 8: adult
            "",                                 # 9: trend
            replaced_by,                        # 10: replaced_by ("steam:<appid>" when delisted, else None)
            None,                               # 11: steam_type
            None,                               # 12: ac_status
            None,                               # 13: ac_vendors
            entry.get("os") or ["windows"],    # 14: pgw_os
            entry.get("engine"),               # 15: pgw_engine
        ]
        entries_index.append(row)
        added += 1

    index_path.write_text(json.dumps(entries_index, separators=(",", ":")), encoding="utf-8")
    log(
        f"[pcgwiki-catalog] merged {added} new rows, updated {updated} existing pw_ rows "
        f"(skipped {len(catalog) - added - updated} unchanged)"
    )
    if delisted_A or delisted_B:
        log(
            f"[pcgwiki-catalog] delisted cross-check: rule A (steam appid missing)={delisted_A}, "
            f"rule B (title diverged on same appid)={delisted_B}"
        )
    # Publish Rule B candidates verbose so we can review the divergence
    # threshold before hardening. Small file; skipped when empty.
    if rule_b_candidates:
        candidates_path = output_dir / "pcgw-delisted-candidates.json"
        candidates_path.write_text(
            json.dumps(rule_b_candidates, indent=2), encoding="utf-8"
        )
        log(
            f"[pcgwiki-catalog] wrote {len(rule_b_candidates)} rule-B candidates to "
            f"{candidates_path.name} for review"
        )

    # Publish the full catalog so the game page can render richer stubs
    # (developers, publishers, wiki_url) without a separate fetch per app.
    published = output_dir / OUTPUT_FILENAME
    published.write_text(json.dumps(catalog, separators=(",", ":")), encoding="utf-8")

    # #406: id -> slug map. The frontend redirects legacy #/app/pgwiki:<slug>
    # URLs by hashing the slug client-side, and the Supabase remap migration
    # consumes this file to translate stored pgwiki: app_ids.
    id_map = {pw_id: entry.get("slug") or "" for pw_id, entry in sorted(catalog.items())}
    (output_dir / ID_MAP_FILENAME).write_text(
        json.dumps(id_map, separators=(",", ":")), encoding="utf-8"
    )
    log(f"[pcgwiki-catalog] wrote {ID_MAP_FILENAME} ({len(id_map)} ids)")
