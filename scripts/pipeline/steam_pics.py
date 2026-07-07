"""Fetch per-depot last-updated timestamps via `steamcmd +app_info_print`.

Steam's storefront /api/appdetails does not include depot manifest metadata,
so per-OS "when was the Linux build last updated" cannot be answered from
the browser at all. That info lives in PICS (Steam's internal Product
Info Client Service). SteamDB scrapes it; the "official" way for us to
reach it without going through steamdb.info or a paid third party is
steamcmd's `+app_info_print <appId>` command, which dumps the same
KeyValues structure the client sees.

Two responsibilities in this module:

    - parse the KeyValues text steamcmd emits (pure function, tested)
    - drive steamcmd once per app and upsert results into Supabase

The runner is deliberately small and re-usable both from `scripts/pipeline`
(nightly cron) and from the manual `make steam-pics APP=<id>` target so
we can spot-check parsing before wiring the full backfill.
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


def extract_depot_rows(app_id: int, parsed: dict) -> list[DepotRow]:
    """Turn a parsed app_info dict into normalized DepotRow entries. One
    row per (depot_id, os) pair. Depots that carry an oslist we do not
    recognize get filed under 'other' so we can surface them if useful.
    """
    if not isinstance(parsed, dict):
        return []
    depots = parsed.get("depots") or {}
    common = parsed.get("common") or {}
    app_name = common.get("name") if isinstance(common, dict) else None
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
            # A depot with no oslist usually ships common data (localization,
            # shaders). Skip -- it is not tied to any OS build.
            continue
        # Newest manifest wins. PICS carries manifests[<branch>].timeupdated;
        # public branch is what non-beta users install.
        manifests = depot.get("manifests") if isinstance(depot.get("manifests"), dict) else {}
        public    = manifests.get("public") if isinstance(manifests.get("public"), dict) else {}
        ts = public.get("timeupdated")
        try:
            ts_int = int(ts) if ts is not None else 0
        except (TypeError, ValueError):
            ts_int = 0
        if ts_int <= 0:
            continue
        manifest_id = public.get("gid") or public.get("manifest") or None
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
    """
    if not steamcmd_available():
        raise RuntimeError(f"steamcmd not on PATH ({STEAMCMD_BINARY}); install it first")
    cmd = [
        STEAMCMD_BINARY,
        "+login", "anonymous",
        "+app_info_update", "1",
        "+app_info_print", str(app_id),
        "+quit",
    ]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, check=False,
    )
    if proc.returncode != 0:
        log(f"steam-pics: steamcmd exit={proc.returncode} app={app_id} stderr={proc.stderr[:200]}")
    return proc.stdout


# --- Supabase upsert -------------------------------------------------------


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
    url = f"{_supabase_base()}/steam_depot_updates?on_conflict=app_id,depot_id,os"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers=_supabase_headers(),
    )
    urllib.request.urlopen(req, timeout=30).read()
    return len(payload)


def upsert_fetch_status(app_id: int, status: str, depot_count: int, error: str | None = None) -> None:
    url = f"{_supabase_base()}/steam_depot_fetch_status?on_conflict=app_id"
    payload = [{
        "app_id":      app_id,
        "app_status":  status,
        "depot_count": depot_count,
        "error":       error,
    }]
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers=_supabase_headers(),
    )
    urllib.request.urlopen(req, timeout=30).read()


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
        log(f"steam-pics: app={app_id} steamcmd failed error={e}")
        upsert_fetch_status(app_id, "error", 0, str(e)[:500])
        return "error", 0
    parsed = parse_app_info(raw)
    if parsed is None:
        upsert_fetch_status(app_id, "no_public_manifest", 0, None)
        return "no_public_manifest", 0
    rows = extract_depot_rows(app_id, parsed)
    if not rows:
        upsert_fetch_status(app_id, "no_public_manifest", 0, None)
        return "no_public_manifest", 0
    n = upsert_depot_rows(rows)
    upsert_fetch_status(app_id, "ok", n, None)
    log(f"steam-pics: app={app_id} rows={n} source=steamcmd-pics")
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
            log(f"steam-pics: app={app_id} unexpected error={e}")
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
    # `python -m scripts.pipeline.steam_pics 367520 730 ...`
    import sys
    ids = [int(x) for x in sys.argv[1:] if x.isdigit()]
    if not ids:
        print("usage: python -m scripts.pipeline.steam_pics <appId> [<appId> ...]", file=sys.stderr)
        sys.exit(2)
    summary = fetch_batch(ids)
    print(json.dumps(summary))
