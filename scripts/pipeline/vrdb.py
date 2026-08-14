"""Ingest VR-on-Linux compatibility reports from the community VRDB project.

Source: https://github.com/Respuit/VRDB (MIT), rendered at https://db.vronlinux.org/.
There is no API -- the site is an Eleventy build over one markdown file per
game at `src/games/<steam_app_id>.md`, so we shallow-clone the repo and parse
the YAML frontmatter.

Per-game frontmatter carries an `opinions` list; each opinion rates up to four
VR runtimes on VRDB's 1-5 scale (see `_data/ratings.json` upstream, mirrored in
VRDB_RATINGS below) where 0 means "did not test this runtime". Lower is better,
which is the inverse of how Pulse tiers read, so nothing here is mixed into
Pulse scoring -- it is surfaced as a separate VR panel with attribution (#246).

The device field upstream is free text: 61 distinct spellings for about a dozen
headsets ("Meta Quest 3", "Quest 3", "quest 3", "Quest3", "Oculus Quest 3"),
plus junk that is clearly not a headset ("AMD", "CachyOS"). normalize_headset
maps them onto the same canonical list the submit form offers so our reports
and theirs can sit side by side.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

import yaml

from .common import log

VRDB_REPO_URL = "https://github.com/Respuit/VRDB.git"
DEFAULT_VRDB_CLONE_PATH = Path(__file__).resolve().parents[2] / ".cache" / "vrdb-repo"
VRDB_CLONE_MAX_AGE_SECONDS = 7 * 86400  # 7 days

# VRDB's rating scale, copied from _data/ratings.json upstream. LOWER IS
# BETTER, the opposite of a Pulse tier. 0 is not in their table: it is the
# "did not try this runtime" default the issue form submits.
VRDB_RATINGS = {
    1: "Perfect",
    2: "Requires manual configuration",
    3: "Playable with graphical/controller issues",
    4: "Unplayable because of graphical/controller issues",
    5: "Crashes or won't start",
}
VRDB_RUNTIME_KEYS = ("steamVR", "monado", "alvr", "wivrn")
# Canonical keys we emit, matching the submit form's VR runtime picker.
VRDB_RUNTIME_LABELS = {
    "steamVR": "steamvr",
    "monado": "monado",
    "alvr": "alvr",
    "wivrn": "wivrn",
}

# Canonical headsets offered on the submit form, most common first. Kept in
# sync with VR_HEADSETS in js/shared/vr.js -- a test asserts both lists match.
VRDB_HEADSETS = (
    "Meta Quest 3",
    "Meta Quest 3S",
    "Meta Quest 2",
    "Meta Quest Pro",
    "Meta Quest 1",
    "Valve Index",
    "HTC Vive",
    "HTC Vive Pro",
    "Pico 4",
    "HP Reverb G2",
    "Bigscreen Beyond",
    "Pimax",
    "Oculus Rift",
)

# Ordered most-specific-first: "quest 3s" must win before the "quest 3" rule
# sees it, and "vive pro" before "vive".
_HEADSET_PATTERNS = (
    (re.compile(r"quest\s*3\s*s\b|quest3s\b"), "Meta Quest 3S"),
    (re.compile(r"quest\s*3\b|quest3\b"), "Meta Quest 3"),
    (re.compile(r"quest\s*pro\b"), "Meta Quest Pro"),
    # "Q2" and the "qest 2" typo both appear upstream.
    (re.compile(r"quest\s*2\b|quest2\b|\bq2\b|\bqest\s*2\b|\boculus\s*2\b"), "Meta Quest 2"),
    (re.compile(r"quest\s*1\b|\boculus\s+quest\s*$"), "Meta Quest 1"),
    (re.compile(r"reverb\s*g2\b"), "HP Reverb G2"),
    (re.compile(r"bigscreen\s+beyond\b"), "Bigscreen Beyond"),
    (re.compile(r"\bpimax\b"), "Pimax"),
    (re.compile(r"\bindex\b"), "Valve Index"),
    # "HTV Vive Pro" is an upstream typo for HTC.
    (re.compile(r"\bh[tv][cv]?\s*vive\s*pro\b|\bvive\s*pro\b"), "HTC Vive Pro"),
    (re.compile(r"\bvive\b"), "HTC Vive"),
    (re.compile(r"\bpico\b"), "Pico 4"),
    (re.compile(r"\brift\b"), "Oculus Rift"),
)

# Values that are clearly not a headset. Upstream's form lets these through
# because the field is free text; "_No response_" is GitHub's placeholder for
# a skipped issue-form field.
_HEADSET_JUNK = {"", "_no response_", "n/a", "na", "none", "amd", "nvidia", "intel", "cachyos"}


def normalize_headset(raw: str | None) -> str | None:
    """Map a free-text headset string onto VRDB_HEADSETS.

    Returns None when the value is junk or unrecognized so callers can drop it
    rather than render "AMD" as a headset. Multi-headset entries ("Valve Index,
    Quest 2", "Pico 4 & Quest 2") resolve to the first one named, which is the
    one the reporter led with.
    """
    if raw is None:
        return None
    text = str(raw).strip().lower()
    if text in _HEADSET_JUNK:
        return None
    # Split on separators so "Valve Index, Quest 2" is judged left to right
    # instead of letting a later segment win on pattern order alone.
    for segment in re.split(r"\s*(?:,|&|\||\+|\band\b)\s*", text):
        segment = segment.strip()
        if not segment:
            continue
        for pattern, canonical in _HEADSET_PATTERNS:
            if pattern.search(segment):
                return canonical
    return None


def _coerce_rating(value) -> int | None:
    """VRDB rating -> 1-5, or None for 'not tested' (0) and unparseable input."""
    if isinstance(value, bool):
        return None
    try:
        rating = int(value)
    except (TypeError, ValueError):
        return None
    return rating if rating in VRDB_RATINGS else None


def parse_vrdb_game(path: Path) -> dict | None:
    """Parse one VRDB markdown file into a game record.

    Returns None when the file carries no usable opinions (most of the 6079
    files upstream are catalog stubs with an empty `opinions:` list). Raises
    on malformed YAML so the caller can count and threshold parse failures --
    one bad file is upstream noise, hundreds means the format changed.
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        raise ValueError(f"{path.name}: no YAML frontmatter")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError(f"{path.name}: unterminated YAML frontmatter")
    data = yaml.safe_load(parts[1]) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path.name}: frontmatter is not a mapping")

    app_id = data.get("id")
    if app_id is None:
        return None
    app_id = str(app_id).strip()
    if not app_id.isdigit():
        return None

    opinions = data.get("opinions") or []
    if not isinstance(opinions, list):
        return None

    runtimes: dict[str, dict] = {}
    devices: dict[str, int] = {}
    latest = ""
    kept = 0
    for opinion in opinions:
        if not isinstance(opinion, dict):
            continue
        rated_any = False
        for key in VRDB_RUNTIME_KEYS:
            rating = _coerce_rating(opinion.get(key))
            if rating is None:
                continue
            rated_any = True
            slot = runtimes.setdefault(
                VRDB_RUNTIME_LABELS[key], {"count": 0, "best": rating, "worst": rating}
            )
            slot["count"] += 1
            slot["best"] = min(slot["best"], rating)
            slot["worst"] = max(slot["worst"], rating)
        if not rated_any:
            continue
        kept += 1
        headset = normalize_headset(opinion.get("device"))
        if headset:
            devices[headset] = devices.get(headset, 0) + 1
        date = str(opinion.get("date") or "").strip()
        if date > latest:
            latest = date

    if not kept:
        return None

    return {
        "app_id": app_id,
        "title": str(data.get("title") or "").strip(),
        "reports": kept,
        "runtimes": runtimes,
        # Most-reported headset first so the UI can show the popular ones.
        "devices": [d for d, _ in sorted(devices.items(), key=lambda kv: (-kv[1], kv[0]))],
        "latest": latest,
    }


def clone_or_update_vrdb(
    dest: Path = DEFAULT_VRDB_CLONE_PATH,
    max_age_seconds: int = VRDB_CLONE_MAX_AGE_SECONDS,
    force_refresh: bool = False,
) -> Path:
    """Shallow-clone VRDB (or refresh an existing clone) and return its path.

    Blob-filtered shallow clone: the repo is ~27MB of markdown and we only ever
    read the tip. Raises on git failure -- an unavailable upstream must fail the
    pipeline rather than silently publish a VR panel with no data.
    """
    dest = Path(dest)
    games_dir = dest / "src" / "games"
    if games_dir.is_dir() and not force_refresh:
        age = time.time() - games_dir.stat().st_mtime
        if age < max_age_seconds:
            log(f"[vrdb] using cached clone at {dest} (age {int(age / 3600)}h)")
            return dest
        try:
            subprocess.run(
                ["git", "-C", str(dest), "fetch", "--depth", "1", "origin", "HEAD"],
                check=True, capture_output=True, text=True, timeout=300,
            )
            subprocess.run(
                ["git", "-C", str(dest), "reset", "--hard", "FETCH_HEAD"],
                check=True, capture_output=True, text=True, timeout=300,
            )
            games_dir.touch()
            log(f"[vrdb] refreshed existing clone at {dest}")
            return dest
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            # Fall through to a fresh clone; log the reason so a repeatedly
            # failing fetch is visible in the runner log rather than looking
            # like a slow step.
            log(f"[vrdb] refresh failed, recloning: {type(exc).__name__}: {exc}")

    if dest.exists():
        subprocess.run(["rm", "-rf", str(dest)], check=True, timeout=120)
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"[vrdb] cloning {VRDB_REPO_URL} -> {dest}")
    subprocess.run(
        [
            "git", "clone", "--depth", "1", "--filter=blob:none", "--quiet",
            VRDB_REPO_URL, str(dest),
        ],
        check=True, capture_output=True, text=True, timeout=600,
    )
    return dest


def build_vrdb_index(
    repo_path: Path = DEFAULT_VRDB_CLONE_PATH,
    max_parse_failure_ratio: float = 0.05,
) -> dict[str, dict]:
    """Parse every VRDB game file into {app_id: record}.

    Files with no usable opinions are skipped (most of them). Individual YAML
    syntax errors upstream are logged and counted -- one malformed file is
    community-data noise, but a failure ratio above max_parse_failure_ratio
    means their format changed and we raise instead of publishing a thinned
    index that looks like "VR data disappeared".
    """
    games_dir = Path(repo_path) / "src" / "games"
    if not games_dir.is_dir():
        raise FileNotFoundError(f"VRDB games dir missing: {games_dir}")

    files = sorted(games_dir.glob("*.md"))
    if not files:
        raise FileNotFoundError(f"VRDB games dir has no markdown files: {games_dir}")

    index: dict[str, dict] = {}
    failures: list[str] = []
    for path in files:
        try:
            record = parse_vrdb_game(path)
        except (yaml.YAMLError, ValueError, OSError) as exc:
            failures.append(f"{path.name}: {type(exc).__name__}")
            continue
        if record:
            index[record["app_id"]] = record

    ratio = len(failures) / len(files)
    if failures:
        log(
            f"[vrdb] {len(failures)} of {len(files)} files failed to parse "
            f"({ratio:.1%}): {', '.join(failures[:5])}"
        )
    if ratio > max_parse_failure_ratio:
        raise ValueError(
            f"VRDB parse failure ratio {ratio:.1%} exceeds "
            f"{max_parse_failure_ratio:.1%} -- upstream format likely changed"
        )
    log(f"[vrdb] parsed {len(index):,} games with VR reports from {len(files):,} files")
    return index


def vr_capable_app_ids(repo_path: Path = DEFAULT_VRDB_CLONE_PATH) -> set[str]:
    """Steam app ids VRDB tracks, reported or not.

    Their catalog is VR titles, so a file existing is itself a VR-support
    signal -- useful as a cross-check on the Steam `categories` flag, which
    misses games whose VR mode ships as a separate branch or a free DLC.
    """
    games_dir = Path(repo_path) / "src" / "games"
    if not games_dir.is_dir():
        raise FileNotFoundError(f"VRDB games dir missing: {games_dir}")
    return {p.stem for p in games_dir.glob("*.md") if p.stem.isdigit()}


# Budget for the VR-category backfill below. Matches the shared appdetails
# throttle the other enrichers use (steam_type, release_years, game_images):
# Steam soft-throttles at ~200 requests / 5 minutes, and going faster earns a
# rolling-window 403 that makes every later probe fail.
VR_REQUEST_DELAY = 2.0
VR_PROBE_CAP = 200
VR_WALL_CLOCK_BUDGET_SEC = 600
VR_CONSECUTIVE_FAILURE_LIMIT = 8


def backfill_vr_categories(
    vr_app_ids: set[str],
    probe_cap: int = VR_PROBE_CAP,
    request_delay: float = VR_REQUEST_DELAY,
) -> int:
    """Fetch Steam VR categories for VRDB-known apps missing them. Returns count fetched.

    Without this, the only/supported split is useless at launch. The category
    data rides along in the descriptors cache, but the ~47k entries written
    before #246 carry no VR data and only refresh on their 30-day TTL -- so
    "VR Only" would stay nearly empty for a month while VRDB's fallback marks
    every VR title merely "supported".

    Scoped to the VRDB catalog (~6k ids) rather than the whole index, because
    those are exactly the games where the answer matters. Capped per run with
    the same budget + bail-out guards as the other appdetails enrichers, so it
    fills in over a few runs and can never stall the pipeline.
    """
    from .common import (
        fetch_steam_content_descriptors,
        flush_steam_descriptors_cache,
        vr_support_cached,
    )

    pending = sorted(a for a in vr_app_ids if a.isdigit() and vr_support_cached(a) is None)
    if not pending:
        log("[vrdb] VR category backfill: nothing pending")
        return 0

    log(f"[vrdb] VR category backfill: {len(pending):,} apps missing VR data (cap {probe_cap})")
    deadline = time.monotonic() + VR_WALL_CLOCK_BUDGET_SEC
    fetched = 0
    consecutive_failures = 0
    bail_reason = None
    for app_id in pending[:probe_cap]:
        if time.monotonic() > deadline:
            bail_reason = f"wall-clock budget {VR_WALL_CLOCK_BUDGET_SEC}s exhausted"
            break
        if consecutive_failures >= VR_CONSECUTIVE_FAILURE_LIMIT:
            bail_reason = (
                f"{consecutive_failures} consecutive failures "
                "(assuming Steam rate-limit / outage)"
            )
            break
        # force_refresh is required, not an optimization: an app cached before
        # #246 has a valid, unexpired entry with no vr_cats key, so a normal
        # call returns straight from cache and never learns the VR answer.
        # Without this the app stays unknown AND trips the failure counter,
        # aborting a perfectly healthy run after 8 such apps.
        # The fetch writes vr_cats into the shared descriptors cache as a side
        # effect; we only care that the entry now exists.
        fetch_steam_content_descriptors(app_id, force_refresh=True)
        if vr_support_cached(app_id) is None:
            consecutive_failures += 1
        else:
            consecutive_failures = 0
        fetched += 1
        time.sleep(request_delay)

    if bail_reason:
        log(f"[vrdb] VR category backfill bailed early: {bail_reason} (probed {fetched})")
    flush_steam_descriptors_cache()
    remaining = max(0, len(pending) - fetched)
    log(f"[vrdb] VR category backfill: probed {fetched}, {remaining:,} still pending for a later run")
    return fetched


def drain_vr_categories(
    vr_app_ids: set[str],
    total_cap: int = 2000,
    pass_cap: int = VR_PROBE_CAP,
    cooldown_seconds: float = 300.0,
    request_delay: float = VR_REQUEST_DELAY,
    sleep=time.sleep,
) -> dict:
    """Drain the VR-category backlog over multiple passes. Returns a summary dict.

    The in-pipeline backfill is deliberately capped at ~200 apps so finalize
    stays predictable, which means a cold backlog (~6k apps) takes weeks of
    daily runs to clear. This is the ad-hoc drain: run it from the
    vr-backfill workflow to clear the backlog in one sitting.

    Steam's throttle is a ROLLING window (~200 requests / 5 minutes), so the
    fix for a rate-limit bail is to wait it out, not to slow the per-request
    delay further. Each pass stops on its own consecutive-failure guard; we
    then cool down past the window and try again. Passes that make no progress
    at all end the drain -- that is a real outage or a bad token, not
    throttling, and hammering it further will not help.
    """
    remaining_cap = max(0, int(total_cap))
    summary = {"probed": 0, "passes": 0, "pending_before": 0, "pending_after": 0, "stopped": ""}
    from .common import vr_support_cached

    def _pending() -> int:
        return sum(1 for a in vr_app_ids if a.isdigit() and vr_support_cached(a) is None)

    summary["pending_before"] = _pending()
    if not summary["pending_before"]:
        summary["stopped"] = "nothing pending"
        log("[vrdb] drain: nothing pending")
        return summary

    log(
        f"[vrdb] drain starting: {summary['pending_before']:,} pending, "
        f"total_cap={remaining_cap}, pass_cap={pass_cap}, cooldown={cooldown_seconds}s"
    )
    while remaining_cap > 0:
        this_pass = min(pass_cap, remaining_cap)
        probed = backfill_vr_categories(
            vr_app_ids, probe_cap=this_pass, request_delay=request_delay
        )
        summary["passes"] += 1
        summary["probed"] += probed
        remaining_cap -= probed if probed else this_pass

        pending = _pending()
        if not pending:
            summary["stopped"] = "backlog cleared"
            break
        if not probed:
            # A pass that probed nothing is not throttling -- backfill only
            # skips apps that already have data, and everything else counts as
            # an attempt. Stop rather than spin.
            summary["stopped"] = "a pass made no progress (upstream down?)"
            break
        if remaining_cap <= 0:
            summary["stopped"] = "total cap reached"
            break
        log(f"[vrdb] drain: {pending:,} still pending, cooling down {cooldown_seconds}s for the rate-limit window")
        sleep(cooldown_seconds)

    summary["pending_after"] = _pending()
    if not summary["stopped"]:
        summary["stopped"] = "total cap reached"
    log(
        f"[vrdb] drain done: probed {summary['probed']:,} over {summary['passes']} pass(es), "
        f"{summary['pending_after']:,} still pending ({summary['stopped']})"
    )
    return summary


def enrich_search_index_with_vr(
    output_dir: Path,
    vr_app_ids: set[str] | None = None,
) -> int:
    """Write VR capability into column 16 of search-index.json (#246).

    Two sources, neither sufficient alone:

    * Steam `categories` (via the descriptors cache) distinguishes "VR Only"
      from "VR Supported", which is the distinction a flatscreen player cares
      about -- but 47k cached entries predate the VR capture and read as
      unknown until their 30-day TTL rolls over.
    * The VRDB catalog covers ~6k VR titles at zero API cost, including games
      whose VR mode ships as a separate branch or free DLC and therefore
      carries no Steam category at all. It cannot tell "only" from
      "supported", so it only ever sets "supported".

    Steam wins where it has a definitive answer; VRDB fills the gaps. Returns
    the number of rows flagged.
    """
    from .common import vr_support_cached  # local import: avoids a cycle at module load

    output_dir = Path(output_dir)
    index_path = output_dir / "search-index.json"
    if not index_path.exists():
        log("[vrdb] search-index.json missing, skipping VR enrichment")
        return 0

    entries = json.loads(index_path.read_text(encoding="utf-8"))
    if not isinstance(entries, list) or not entries:
        return 0

    vr_app_ids = vr_app_ids or set()
    flagged = 0
    only = supported = 0
    # Compact {app_id: 'supported'|'only'} map published alongside the index.
    # The home page's rows come from most_played.json / recent-reports.json,
    # not from the search API, so a card there has no vr field to read. Same
    # pattern as anti-cheat.json: one small file the frontend memoizes.
    vr_map: dict[str, str] = {}
    for row in entries:
        if not isinstance(row, list) or not row:
            continue
        app_id = str(row[0] or "").strip()
        if not app_id.isdigit():
            continue  # VRDB and Steam categories are both Steam-appid keyed

        # Steam wins when it has an answer ('only' / 'supported'). Both of the
        # other cases -- '' (checked, no VR category) and None (never checked)
        # -- defer to VRDB, which catches VR modes shipped as a separate branch
        # or free DLC and so absent from the store categories.
        value = vr_support_cached(app_id) or ("supported" if app_id in vr_app_ids else None)

        if not value:
            continue
        # Column 16. Everything through 15 is spoken for: 10 replaced_by,
        # 11 steam_type, 12-13 anti-cheat, 14-15 PCGamingWiki. Pad first so the
        # index is right regardless of which enrichers have run.
        while len(row) < 17:
            row.append(None)
        row[16] = value
        vr_map[app_id] = value
        flagged += 1
        if value == "only":
            only += 1
        else:
            supported += 1

    if flagged:
        index_path.write_text(json.dumps(entries, separators=(",", ":")), encoding="utf-8")
    map_path = output_dir / "vr-index.json"
    map_path.write_text(json.dumps(vr_map, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    log(
        f"[vrdb] flagged {flagged:,} VR entries in search-index.json "
        f"({only:,} VR-only, {supported:,} VR-supported); wrote {map_path.name}"
    )
    return flagged


def write_vrdb_json(output_dir: Path, index: dict[str, dict]) -> Path:
    """Write vrdb.json for the game page's VR panel."""
    out_path = Path(output_dir) / "vrdb.json"
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "https://github.com/Respuit/VRDB",
        "site": "https://db.vronlinux.org/",
        "license": "MIT",
        "ratings": {str(k): v for k, v in VRDB_RATINGS.items()},
        "games": index,
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    log(f"[vrdb] wrote {out_path} ({len(index):,} games)")
    return out_path
