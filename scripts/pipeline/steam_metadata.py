"""Fetch Steam per-app metadata that is NOT in the public storefront API.

The public store /api/appdetails endpoint covers most of the SteamDB-style
metadata modal (developer, publisher, release date, categories, ...) --
we already surface that via the steam-appdetails edge function. What it
does NOT include is per-depot manifest data: which depot ships which OS
build, and when each was last updated. That lives in PICS (Steam's
internal Product Info Client Service), same source SteamDB scrapes. The
"official" way to reach PICS without a paid third party is steamcmd's
`+app_info_print <appId>` command, which dumps the KeyValues structure
the client sees.

This module owns the steamcmd side of the Steam metadata story so future
per-app fetchers that also need a runner + parser can extend it rather
than fork a sibling file. Two responsibilities today:

    - parse the KeyValues text steamcmd emits (pure function, tested)
    - drive steamcmd once per app and upsert results into Supabase

Note: `scripts/pipeline/metadata.py` handles our OWN per-app metadata.json
output files (site JSON), and `scripts/pipeline/release_years.py` fetches
a single release-year field via HTTP appdetails; both are unrelated to
what we do here.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import urllib.request
from dataclasses import dataclass
from typing import Iterable

from .common import log


STEAMCMD_BINARY = os.environ.get("STEAMCMD_BINARY") or "steamcmd"

# The four canonical OS buckets our web UI reads. PICS reports `oslist`
# as a comma-separated string per depot (e.g. "windows,macos") plus older
# entries that use "macos" instead of "mac". Normalize to what the front
# end already renders.
_OS_ALIASES = {
    "windows": "windows",
    "macos":   "mac",
    "mac":     "mac",
    "linux":   "linux",
}


# --- KeyValues parser ------------------------------------------------------
#
# steamcmd emits Valve KeyValues text. Grammar (loose):
#
#     "key"    "value"
#     "key"
#     {
#         "nested-key"  "value"
#         ...
#     }
#
# We only care about the `common.name`, `depots.*` subtree, and the
# top-level appid; everything else is skipped. The parser is tolerant of
# unquoted keys and blank lines (steamcmd sometimes emits both).

@dataclass
class DepotRow:
    app_id: int
    depot_id: int
    os: str                # 'windows' | 'mac' | 'linux' | 'other'
    name: str | None
    manifest_id: str | None
    last_updated_at: int   # UNIX seconds


class KVParseError(RuntimeError):
    pass


def _kv_tokens(text: str) -> list[str]:
    """Tokenize KV text into strings, braces, and value scalars. Handles
    quoted strings, bare identifiers, and inline // line comments."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            i += 1
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            # eat to end-of-line
            j = text.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if c in "{}":
            out.append(c)
            i += 1
            continue
        if c == '"':
            j = i + 1
            buf = []
            while j < n:
                if text[j] == '\\' and j + 1 < n:
                    buf.append(text[j + 1])
                    j += 2
                    continue
                if text[j] == '"':
                    break
                buf.append(text[j])
                j += 1
            if j >= n:
                raise KVParseError("unterminated string")
            out.append("".join(buf))
            i = j + 1
            continue
        # Bare word until whitespace / brace
        j = i
        while j < n and text[j] not in " \t\r\n{}":
            j += 1
        out.append(text[i:j])
        i = j
    return out


def _parse_kv_object(tokens: list[str], pos: int) -> tuple[dict, int]:
    """Consume a KV object starting at tokens[pos] == '{'. Returns
    (parsed_dict, index_after_closing_brace)."""
    if pos >= len(tokens) or tokens[pos] != "{":
        raise KVParseError(f"expected '{{' at token {pos}")
    pos += 1
    obj: dict = {}
    while pos < len(tokens) and tokens[pos] != "}":
        key = tokens[pos]
        pos += 1
        if pos >= len(tokens):
            raise KVParseError("dangling key at end of input")
        if tokens[pos] == "{":
            child, pos = _parse_kv_object(tokens, pos)
            obj[key] = child
        else:
            obj[key] = tokens[pos]
            pos += 1
    if pos >= len(tokens):
        raise KVParseError("unclosed object")
    return obj, pos + 1


def parse_app_info(text: str) -> dict | None:
    """Parse the `AppID : <appId>` block steamcmd emits after
    `app_info_print`. Returns the inner KV dict, or None when no block is
    found (e.g. steamcmd hit a login prompt or the app is invalid).
    """
    # steamcmd prefixes the KV block with a header like:
    #   AppID : 367520, change number : 12345678
    #   "367520"
    #   {
    #       "common" { ... }
    #       "depots" { ... }
    #   }
    # We anchor on the "<appId>" line so we skip login / usage banners
    # cleanly.
    m = re.search(r'^"(\d+)"\s*\n\s*\{', text, re.MULTILINE)
    if not m:
        return None
    tokens = _kv_tokens(text[m.start():])
    if not tokens:
        return None
    if tokens[0].isdigit():
        # Wrapping app_id key + block.
        _ = tokens[0]
        obj, _ = _parse_kv_object(tokens, 1)
        return obj
    return None


def _branch_timeupdated(depots: dict, branch: str = "public") -> int:
    """Read `depots.branches.<branch>.timeupdated` -- the app-level 'when
    was this branch last updated' timestamp. PICS puts the branch info
    at the SAME LEVEL as the depot IDs inside the depots dict; the
    depot dicts themselves do not carry a per-depot timestamp in
    app_info_print output (SteamKit / ValvePython/steam / patchforge
    all read the branch-level timeupdated for the per-app 'last update'
    signal). Individual depot manifest timestamps live in the depot
    manifest headers -- fetching those requires a separate PICS call
    per depot which we skip for now.
    """
    if not isinstance(depots, dict):
        return 0
    branches = depots.get("branches")
    if not isinstance(branches, dict):
        return 0
    entry = branches.get(branch)
    if not isinstance(entry, dict):
        return 0
    ts = entry.get("timeupdated")
    try:
        return int(ts) if ts is not None else 0
    except (TypeError, ValueError):
        return 0


def extract_depot_rows(app_id: int, parsed: dict) -> list[DepotRow]:
    """Turn a parsed app_info dict into normalized DepotRow entries. One
    row per (depot_id, os) pair.

    Data source shape (matches SteamKit / ValvePython/steam / patchforge):
        depots.<depotId>.config.oslist         -> which OS this depot ships
        depots.<depotId>.manifests.public.gid  -> current manifest id
        depots.branches.public.timeupdated     -> app-level last-updated

    Individual depots do NOT carry a per-depot timestamp in the PICS
    app_info dump; the branch-level timeupdated is the shared 'this app
    last got a public update at this time' signal (same value SteamDB
    displays on the depot page's Last Update column when no per-depot
    manifest fetch has run).

    Depots that carry an oslist we do not recognize get filed under
    'other' so we can surface them if useful. Depots with no oslist
    are language/shared data -- skipped.
    """
    if not isinstance(parsed, dict):
        return []
    depots = parsed.get("depots") or {}
    if not isinstance(depots, dict):
        return []
    common = parsed.get("common") or {}
    app_name = common.get("name") if isinstance(common, dict) else None
    # Public branch timeupdated is the shared last-update timestamp for
    # every OS-tagged depot; the depot dict itself has no timestamp.
    branch_ts = _branch_timeupdated(depots, "public")

    out: list[DepotRow] = []
    for depot_id, depot in depots.items():
        if not depot_id.isdigit():
            continue
        if not isinstance(depot, dict):
            continue
        # PICS puts oslist under depot.config.oslist. Older / edge apps
        # may set it directly on the depot -- handle both.
        cfg = depot.get("config") if isinstance(depot.get("config"), dict) else {}
        oslist_raw = (cfg.get("oslist") or depot.get("oslist") or "").lower()
        oses = {
            _OS_ALIASES.get(part.strip(), "other")
            for part in oslist_raw.split(",")
            if part.strip()
        }
        if not oses:
            # A depot with no oslist usually ships localization / shared
            # data. Skip -- it is not tied to any OS build.
            continue
        # A per-depot manifests.public.timeupdated wins if it exists (rare;
        # SteamPipe leaves this field off on most published apps), then
        # fall back to the branch-level timestamp which every OS depot
        # inherits.
        manifests = depot.get("manifests") if isinstance(depot.get("manifests"), dict) else {}
        public    = manifests.get("public") if isinstance(manifests.get("public"), dict) else {}
        depot_ts_raw = public.get("timeupdated") if isinstance(public, dict) else None
        try:
            depot_ts = int(depot_ts_raw) if depot_ts_raw is not None else 0
        except (TypeError, ValueError):
            depot_ts = 0
        ts_int = depot_ts if depot_ts > 0 else branch_ts
        if ts_int <= 0:
            continue
        manifest_id = None
        if isinstance(public, dict):
            manifest_id = public.get("gid") or public.get("manifest")
        depot_name = depot.get("name") or app_name
        for os_key in oses:
            out.append(DepotRow(
                app_id=app_id,
                depot_id=int(depot_id),
                os=os_key,
                name=depot_name,
                manifest_id=str(manifest_id) if manifest_id else None,
                last_updated_at=ts_int,
            ))
    return out


# --- steamcmd driver -------------------------------------------------------


def steamcmd_available() -> bool:
    return shutil.which(STEAMCMD_BINARY) is not None


def run_steamcmd_app_info(app_id: int, timeout: int = 60) -> str:
    """Shell out to steamcmd anonymous + app_info_print. Returns raw
    stdout. Callers pass the output to parse_app_info().

    Rate limit: steamcmd caches locally, but hammering PICS still risks a
    Steam client ban. Callers should sleep 2-5s between apps in a batch.

    Input validation: the app_id parameter is typed as int but Python does
    not enforce the annotation at runtime. Coerce via int() so anything
    non-numeric raises rather than reaching the subprocess argv. This also
    satisfies Semgrep's dangerous-subprocess-use-tainted-env-args rule --
    the argv is now provably digits-only for the app-id-bearing entries.
    """
    if not steamcmd_available():
        raise RuntimeError(f"steamcmd not on PATH ({STEAMCMD_BINARY}); install it first")
    safe_app_id = str(int(app_id))
    # `+app_info_request <id>` forces PICS to fetch fresh product info for
    # this app. `+app_info_print` alone reads the local cache, which is
    # empty on a fresh runner -- that produced our first-run 'no_manifest'
    # miss. `+app_info_update 1` refreshes the general changelist.
    # `+delay 3` gives PICS a moment to answer before print runs. This
    # combination matches what SteamDB / ArchiSteamFarm docs recommend
    # for anonymous PICS access.
    cmd = [
        STEAMCMD_BINARY,
        "+login", "anonymous",
        "+app_info_update", "1",
        "+app_info_request", safe_app_id,
        "+delay", "3",
        "+app_info_print", safe_app_id,
        "+quit",
    ]
    # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-tainted-env-args.dangerous-subprocess-use-tainted-env-args - argv is a fixed list of literals; the only interpolated slot is safe_app_id which is coerced to str(int(...)) above
    proc = subprocess.run(  # nosec B603
        cmd, capture_output=True, text=True, timeout=timeout, check=False,
    )
    if proc.returncode != 0:
        log(f"steam-metadata: steamcmd exit={proc.returncode} app={app_id} stderr={proc.stderr[:200]}")
    return proc.stdout


# --- Supabase upsert -------------------------------------------------------


def _dry_run() -> bool:
    """#218: honor DRY_RUN=true so a dispatched run can preview PICS output
    without writing to steam_depot_updates / manifest_history / fetch_status."""
    return os.environ.get("DRY_RUN", "").strip().lower() == "true"


def _supabase_headers() -> dict:
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY missing; cannot upsert")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def _supabase_base() -> str:
    url = os.environ.get("SUPABASE_URL")
    if not url:
        raise RuntimeError("SUPABASE_URL missing; cannot upsert")
    return url.rstrip("/") + "/rest/v1"


def upsert_depot_rows(rows: Iterable[DepotRow]) -> int:
    """POST rows to /rest/v1/steam_depot_updates with on-conflict merge."""
    payload = [
        {
            "app_id":          r.app_id,
            "depot_id":        r.depot_id,
            "os":              r.os,
            "name":            r.name,
            "manifest_id":     r.manifest_id,
            "last_updated_at": _iso_from_epoch(r.last_updated_at),
        }
        for r in rows
    ]
    if not payload:
        return 0
    if _dry_run():
        log(f"steam-metadata: dry-run, would upsert {len(payload)} depot rows: sample={payload[0]}")
        return len(payload)
    url = f"{_supabase_base()}/steam_depot_updates?on_conflict=app_id,depot_id,os"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers=_supabase_headers(),
    )
    # URL from hardcoded Supabase base + static REST path
    urllib.request.urlopen(req, timeout=30).read()  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    return len(payload)


def upsert_manifest_history_rows(rows: Iterable[DepotRow]) -> int:
    """Observation history for issue #226 (Phase 2 of the depot plan).

    For each (app_id, depot_id, os, manifest_id) tuple we've never seen,
    INSERT with first_observed_at = now(). For tuples we HAVE seen, bump
    latest_observed_at to now(). When a game ships a build the manifest_id
    changes for the affected depots -> a fresh row is inserted; the
    previous row stays forever with its latest_observed_at frozen at the
    time of the last observation, so we build a durable per-OS timeline.

    Rows without a manifest_id are skipped -- the history is keyed on
    manifest_id, and depots that PICS returned with no manifest are the
    exact rows we cannot record change history for.
    """
    payload = [
        {
            "app_id":             r.app_id,
            "depot_id":           r.depot_id,
            "os":                 r.os,
            "manifest_id":        r.manifest_id,
            "latest_observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        for r in rows
        if r.manifest_id  # skip depots that ship without a public manifest gid
    ]
    if not payload:
        return 0
    if _dry_run():
        log(f"steam-metadata: dry-run, would upsert {len(payload)} manifest history rows")
        return len(payload)
    # on_conflict specifies our composite PK. Prefer: merge-duplicates means
    # existing rows keep first_observed_at (never overwritten) and only
    # latest_observed_at is bumped -- exactly the shape we want. The
    # default column value 'now()' fires on INSERT only.
    url = f"{_supabase_base()}/steam_depot_manifest_history?on_conflict=app_id,depot_id,os,manifest_id"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers=_supabase_headers(),
    )
    # URL from hardcoded Supabase base + static REST path
    urllib.request.urlopen(req, timeout=30).read()  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    return len(payload)


def upsert_fetch_status(
    app_id: int,
    status: str,
    depot_count: int,
    error: str | None = None,
    raw_pics: dict | None = None,
) -> None:
    """Upsert the per-app fetch status row.

    #237: `raw_pics` is the full parsed depots dict from PICS. Persisting it
    verbatim lets downstream stages (write_depot_files.py) surface every
    field steamcmd emitted without a second PICS round-trip.
    """
    row: dict = {
        "app_id":      app_id,
        "app_status":  status,
        "depot_count": depot_count,
        "error":       error,
    }
    if raw_pics is not None:
        row["raw_pics"] = raw_pics
    payload = [row]
    if _dry_run():
        log(f"steam-metadata: dry-run, would upsert fetch_status={row}")
        return
    url = f"{_supabase_base()}/steam_depot_fetch_status?on_conflict=app_id"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers=_supabase_headers(),
    )
    # URL from hardcoded Supabase base + static REST path
    urllib.request.urlopen(req, timeout=30).read()  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected


def _iso_from_epoch(ts: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


# --- Batch driver ----------------------------------------------------------


def fetch_and_store(app_id: int, sleep_between: float = 3.0) -> tuple[str, int]:
    """Run steamcmd for a single app, parse, upsert. Returns (status,
    row_count). Status is one of 'ok', 'no_public_manifest', 'error'.

    The caller usually sleeps `sleep_between` seconds between apps.
    """
    try:
        raw = run_steamcmd_app_info(app_id)
    except Exception as e:
        log(f"steam-metadata: app={app_id} steamcmd failed error={e}")
        upsert_fetch_status(app_id, "error", 0, str(e)[:500])
        return "error", 0
    parsed = parse_app_info(raw)
    if parsed is None:
        # Log a short tail of the raw steamcmd stdout so a workflow log
        # reader can tell whether steamcmd hit a login banner, a rate
        # limit, or actually returned an appid block we then failed to
        # parse. Truncated to keep GH Actions logs readable.
        tail = (raw or "").strip().splitlines()[-6:]
        log(f"steam-metadata: app={app_id} no appinfo block, steamcmd tail={tail}")
        upsert_fetch_status(app_id, "no_public_manifest", 0, "no appinfo block in steamcmd output")
        return "no_public_manifest", 0
    rows = extract_depot_rows(app_id, parsed)
    if not rows:
        depots = parsed.get("depots") or {}
        depot_keys = list(depots.keys())[:8]
        log(f"steam-metadata: app={app_id} parsed but no rows -- depots={depot_keys}")
        # Dump the shape of the first numerically-keyed depot dict so the
        # workflow log tells us EXACTLY what fields PICS returned. My
        # sample data assumed depot.config.oslist + depot.manifests.public
        # .timeupdated; if real PICS uses different field names or nesting
        # we will see it here without needing to add steamcmd to Termux.
        first_num_key = next((k for k in depots.keys() if k.isdigit()), None)
        if first_num_key:
            sample = depots.get(first_num_key)
            try:
                sample_json = json.dumps(sample, sort_keys=True)[:1500]
            except (TypeError, ValueError):
                sample_json = str(sample)[:1500]
            log(f"steam-metadata: app={app_id} sample_depot={first_num_key} shape={sample_json}")
        # #237: even when we could not extract OS-bound rows, keep the raw
        # depots dict so we can inspect what PICS returned via the on-disk
        # depots.json without a re-fetch.
        upsert_fetch_status(app_id, "no_public_manifest", 0, "parsed appinfo but no OS-bound depot rows", raw_pics=parsed.get("depots"))
        return "no_public_manifest", 0
    n = upsert_depot_rows(rows)
    # #226: feed the same rows into the manifest observation history so per-OS
    # tracked_since / Last update become real dates. Failures here should NOT
    # flip the status to error -- the primary depot_updates write is already
    # durable; history is a strict enhancement. Log + continue.
    try:
        h = upsert_manifest_history_rows(rows)
        log(f"steam-metadata: app={app_id} history rows upserted={h} source=depot-history")
    except Exception as e:
        log(f"steam-metadata: app={app_id} history upsert failed error={e}")
    # #237: persist the full parsed depots dict alongside the status. Everything
    # steamcmd emitted (config.oslist, manifests.public.*, branches, sharedinstall,
    # dlc_appids, ...) lands as a single JSONB blob for downstream consumers.
    upsert_fetch_status(app_id, "ok", n, None, raw_pics=parsed.get("depots"))
    log(f"steam-metadata: app={app_id} rows={n} source=steamcmd-pics")
    return "ok", n


def fetch_batch(app_ids: Iterable[int], sleep_between: float = 3.0) -> dict:
    """Iterate app IDs sequentially, respecting a per-app sleep so PICS
    is not hit faster than Steam expects. Returns a summary dict useful
    for the workflow log:

        { 'total': N, 'ok': N, 'no_manifest': N, 'error': N }
    """
    summary = {"total": 0, "ok": 0, "no_manifest": 0, "error": 0}
    for app_id in app_ids:
        summary["total"] += 1
        try:
            status, _ = fetch_and_store(int(app_id))
        except Exception as e:
            log(f"steam-metadata: app={app_id} unexpected error={e}")
            summary["error"] += 1
            continue
        if status == "ok":
            summary["ok"] += 1
        elif status == "no_public_manifest":
            summary["no_manifest"] += 1
        else:
            summary["error"] += 1
        time.sleep(sleep_between)
    return summary


if __name__ == "__main__":
    # `python -m scripts.pipeline.steam_metadata 367520 730 ...`
    import sys
    ids = [int(x) for x in sys.argv[1:] if x.isdigit()]
    if not ids:
        print("usage: python -m scripts.pipeline.steam_metadata <appId> [<appId> ...]", file=sys.stderr)
        sys.exit(2)
    summary = fetch_batch(ids)
    print(json.dumps(summary))
