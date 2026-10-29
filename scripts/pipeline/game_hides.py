"""Drop admin-hidden games from the published search index (#571).

The admin Game Manager writes game_hides (#234). The frontend filters those
app ids live (#238), but the pipeline kept publishing them, so the search
API (Postgres search_index, synced from search-index.json) still returned
them. Removing them from search-index.json before sync_search_index runs is
enough: the sync deletes Postgres rows that are no longer in the file.

Reads game_hides?select=app_id with the same anon credentials the pulse
merge uses; #570 grants anon SELECT on app_id only.

fetch_game_hides raises on any failure. apply_game_hides catches it, logs a
WARNING and leaves the index unchanged: hidden games then stay listed for
one more night and the frontend still filters them, which beats failing
the whole nightly over an admin list.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

from .common import log
from .pulse import _resolve_credentials


def fetch_game_hides(opener: Callable = urllib.request.urlopen) -> set[str]:
    """Hidden app ids from Supabase. Raises on network, HTTP or parse errors."""
    base, key = _resolve_credentials()
    url = f"{base}/game_hides?select=app_id"
    req = urllib.request.Request(url, headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json",
    })
    # URL from the configured Supabase base + a static REST path.
    with opener(req, timeout=30) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        rows = json.loads(resp.read().decode("utf-8"))
    if not isinstance(rows, list):
        raise ValueError(f"game_hides returned {type(rows).__name__}, expected a list")
    return {str(r["app_id"]) for r in rows if isinstance(r, dict) and r.get("app_id")}


INDEX_FILES = ("search-index.json", "search-index-steam-extended.json")


def apply_game_hides(output_dir: Path, fetch: Callable[[], set[str]] = fetch_game_hides) -> int:
    """Remove hidden app ids from the primary and extended search indexes.

    The extended index lists Steam apps NOT in the primary, so a hidden game
    dropped from the primary would otherwise show up there. Returns the
    total rows removed.
    """
    try:
        hides = fetch()
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
        log(f"[game-hides] WARN: could not read game_hides ({type(exc).__name__}: {exc}); "
            f"search-index left unchanged, hidden games stay listed this run")
        return 0
    if not hides:
        log("[game-hides] no hidden games")
        return 0
    total = 0
    for name in INDEX_FILES:
        index_path = output_dir / name
        if not index_path.exists():
            continue
        rows = json.loads(index_path.read_text(encoding="utf-8"))
        kept = [r for r in rows if not (r and str(r[0]) in hides)]
        removed = len(rows) - len(kept)
        if removed:
            index_path.write_text(json.dumps(kept, separators=(",", ":")), encoding="utf-8")
        log(f"[game-hides] {name}: removed {removed} hidden app(s)")
        total += removed
    log(f"[game-hides] {len(hides)} in game_hides: {sorted(hides)[:20]}")
    return total
