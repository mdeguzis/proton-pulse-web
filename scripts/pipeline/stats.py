"""Walk all year files under data/ and emit aggregate stats.json.

Powers the /stats.html page with single-dimension breakdowns plus a handful of
2D cross-tabs so the page can filter client-side without pulling raw report
rows. Output is a few KB regardless of dataset size.

The categorical normalizers (GPU vendor, CPU brand, OS family, Proton type)
are deliberately coarse -- a few well-known buckets plus "other" -- since the
filters on the stats page need stable values to key off.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import log


# ── Categorical normalizers ────────────────────────────────────────────────

# Some fields carry vendor-y junk ("Advanced Micro Devices, Inc. [AMD/ATI]...")
# so we collapse them down to a handful of stable tokens for filtering. Order
# matters: longer / more specific patterns first.

# Use \b word-boundary so "RTX 4080" matches at the start of a string and
# "GTX1080" (no space) still matches. Substring matching missed both.
_NVIDIA_RE = re.compile(
    r"\b(nvidia|geforce|quadro|tesla|titan|rtx|gtx)", re.IGNORECASE
)
_AMD_RE = re.compile(
    r"\b(amd|radeon|vega|navi|polaris|rdna|vangogh|gfx\d{2,}|ati\b)",
    re.IGNORECASE,
)
_INTEL_RE = re.compile(
    r"\b(intel|iris|arc(?:\s|$)|xe\s+graphics|uhd\s+graphics|hd\s+graphics)",
    re.IGNORECASE,
)


def normalize_gpu_vendor(report: dict) -> str:
    # Pulse rows carry an explicit gpu_vendor (or gpuVendor after camelCasing);
    # ProtonDB rows don't, so fall back to product-name pattern matching.
    explicit = (report.get("gpuVendor") or report.get("gpu_vendor") or "").lower().strip()
    if explicit in ("amd", "nvidia", "intel"):
        return explicit
    gpu = report.get("gpu") or ""
    if not gpu:
        return "unknown"
    if _NVIDIA_RE.search(gpu):
        return "nvidia"
    if _AMD_RE.search(gpu):
        return "amd"
    if _INTEL_RE.search(gpu):
        return "intel"
    return "other"


_CPU_AMD_RE = re.compile(r"\b(amd|ryzen|threadripper|athlon|epyc|radeon)", re.IGNORECASE)
_CPU_INTEL_RE = re.compile(
    r"\b(intel|xeon|celeron|pentium|core\s+i[3579])\b|\bi[3579]-\d",
    re.IGNORECASE,
)


def normalize_cpu_brand(report: dict) -> str:
    cpu = report.get("cpu") or ""
    if not cpu:
        return "unknown"
    if _CPU_AMD_RE.search(cpu):
        return "amd"
    if _CPU_INTEL_RE.search(cpu):
        return "intel"
    return "other"


# OS family buckets: a few major distros + Steam Deck variants + a catch-all.
# Keys here also become the tokens on the stats page filter chips, so keep them
# short and lowercased
_OS_PATTERNS = (
    ("steamos",   re.compile(r"\bsteam[\s-]?os|holoiso|holo iso|chimera", re.I)),
    ("bazzite",   re.compile(r"bazzite", re.I)),
    ("arch",      re.compile(r"\barch\b|cachyos|endeavour|manjaro|garuda", re.I)),
    ("fedora",    re.compile(r"fedora|silverblue|kinoite|nobara", re.I)),
    ("ubuntu",    re.compile(r"ubuntu|kubuntu|xubuntu|lubuntu|mint|pop[!_ ]?os|elementary", re.I)),
    ("debian",    re.compile(r"\bdebian\b|mx linux|kali", re.I)),
    ("opensuse",  re.compile(r"opensuse|suse|tumbleweed", re.I)),
    ("nixos",     re.compile(r"\bnixos\b", re.I)),
    ("gentoo",    re.compile(r"gentoo", re.I)),
)


def normalize_os_family(report: dict) -> str:
    os_raw = (report.get("os") or "").strip()
    if not os_raw:
        return "unknown"
    for label, pat in _OS_PATTERNS:
        if pat.search(os_raw):
            return label
    return "other"


# Bare version strings ProtonDB reports use: "10.0-3", "9.0-4", "8.0-5",
# "7.0-6c", "1.9.7" etc. Sometimes with optional "v" prefix or trailing
# letter suffix. The version-only form is what shows up in the raw archive.
_BARE_PROTON_VERSION = re.compile(
    r"^v?\d+(\.\d+){0,2}([\s\-_]\d+)?[a-z]?$"
)


# Steam Deck hardware fingerprints. VanGogh is the GPU codename Valve used
# for the LCD model and AMD only ships it in the Deck. The APU IDs are the
# revision strings that appear in lspci / lscpu output, surfaced as the
# user-visible cpu/gpu fields in ProtonDB reports.
_STEAM_DECK_LCD = re.compile(r"\b(amd\s+custom\s+(apu|gpu)\s+0405|vangogh)\b", re.IGNORECASE)
# OLED uses APU rev 0932 (codename "Sephiroth"). VanGogh is still the GPU
# codename so VanGogh alone can't distinguish LCD vs OLED -- the 0932 string
# is what nails the OLED specifically
_STEAM_DECK_OLED = re.compile(r"\b(amd\s+custom\s+(apu|gpu)\s+0932|sephiroth)\b", re.IGNORECASE)


def normalize_device_family(report: dict) -> str:
    """Detect Steam Deck (LCD/OLED) and similar handhelds vs generic desktop.

    Matches against both CPU and GPU strings since either field may carry the
    Deck-identifying APU/GPU revision. Conservative -- only flags devices with
    unambiguous fingerprints. Everything else is "desktop".
    """
    cpu = report.get("cpu") or ""
    gpu = report.get("gpu") or ""
    haystack = cpu + " " + gpu
    if _STEAM_DECK_OLED.search(haystack):
        return "steam-deck-oled"
    if _STEAM_DECK_LCD.search(haystack):
        return "steam-deck-lcd"
    if not cpu and not gpu:
        return "unknown"
    return "desktop"


def normalize_proton_type(report: dict) -> str:
    v = (report.get("protonVersion") or report.get("proton_version") or "").lower().strip()
    if not v:
        return "unknown"
    # GE-Proton variants: "GE-Proton9-25", "Proton-GE", "GE 9-25"
    if "ge-proton" in v or "proton-ge" in v or "ge_proton" in v \
            or v.startswith("ge-") or v.startswith("ge "):
        return "ge-proton"
    if "tkg" in v:
        return "proton-tkg"
    if "next" in v:
        return "proton-next"
    if "experimental" in v:
        return "proton-experimental"
    if "hotfix" in v:
        return "proton-hotfix"
    if "native" in v or v == "no proton" or "linux native" in v:
        return "native"
    if "steam linux runtime" in v or "steam-linux-runtime" in v or v == "slr":
        return "steam-linux-runtime"
    # Bare version numbers like "10.0-3", "9.0-4" -- the most common form in
    # ProtonDB reports. Classify as official stable Proton.
    if _BARE_PROTON_VERSION.match(v):
        return "proton-stable"
    # Anything else that mentions proton -- catch-all for branded variants
    if "proton" in v:
        return "proton-stable"
    return "other"


# Reports without explicit source were ProtonDB originally; the pipeline
# backfills source on legacy untagged records, but treat missing as protondb
# here too in case stats runs before the next merge
def normalize_source(report: dict) -> str:
    src = (report.get("source") or "protondb").lower()
    return "pulse" if src == "pulse" else "protondb"


def normalize_rating(report: dict) -> str:
    r = (report.get("rating") or "").lower().strip()
    return r if r in ("platinum", "gold", "silver", "bronze", "borked", "pending") else "unknown"


# ── Scoring helpers (duplicated from finalize.py to avoid circular import) ──

# Per-rating score on a 0..1 scale. Mirrors scoring-info.json:ratingScores
# and finalize.py:_RATING_SCORES. Kept here for the stale-borked computation
# which needs to derive per-game overall tier inline with the aggregation walk.
_RATING_SCORES = {
    "platinum": 1.0,
    "gold": 0.8,
    "silver": 0.6,
    "bronze": 0.4,
    "borked": 0.0,
}


def _score_to_tier(score_pct: float) -> str:
    if score_pct >= 80: return "platinum"
    if score_pct >= 60: return "gold"
    if score_pct >= 40: return "silver"
    if score_pct >= 20: return "bronze"
    return "borked"


# ── Walker ─────────────────────────────────────────────────────────────────

def _iter_year_files(data_output_path: Path):
    """Yield (app_id, year, [reports]) tuples for every year file on disk."""
    for app_dir in data_output_path.iterdir():
        if not app_dir.is_dir():
            continue
        app_id = app_dir.name
        for year_file in app_dir.glob("*.json"):
            stem = year_file.stem
            if stem in ("index", "latest", "votes", "metadata"):
                continue
            try:
                reports = json.loads(year_file.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(reports, list):
                continue
            yield app_id, stem, reports


# ── Aggregation ────────────────────────────────────────────────────────────

def compute_stats(data_output_path: Path) -> dict[str, Any]:
    """Walk all reports and bucket them by every dimension we care about.

    Single-dim buckets are flat counters. Cross-tabs are nested dicts so the
    stats page can pivot client-side (e.g. "ratings where gpuVendor=nvidia").
    """
    total = 0
    by_source: Counter = Counter()
    by_rating: Counter = Counter()
    by_gpu: Counter = Counter()
    by_cpu: Counter = Counter()
    by_os: Counter = Counter()
    by_proton: Counter = Counter()
    by_device: Counter = Counter()
    by_year: Counter = Counter()
    by_year_source: dict[str, Counter] = defaultdict(Counter)

    # 2D cross-tabs: rating broken down by each hardware dimension
    # shape: { dimension_value: Counter(rating -> count) }
    by_rating_x_gpu: dict[str, Counter] = defaultdict(Counter)
    by_rating_x_cpu: dict[str, Counter] = defaultdict(Counter)
    by_rating_x_os: dict[str, Counter] = defaultdict(Counter)
    by_rating_x_source: dict[str, Counter] = defaultdict(Counter)
    by_rating_x_device: dict[str, Counter] = defaultdict(Counter)
    # Year x rating: enables the "ratings shift over time" chart (% borked dropping, etc.)
    # shape: { "2025": Counter(rating -> count), ... }
    by_year_rating: dict[str, Counter] = defaultdict(Counter)

    # Per-app accumulator. Tracks newest_year so we can identify games that
    # have not been re-tested recently -- the "worth re-testing" leaderboard
    # uses this to surface borked games whose latest report is years old.
    per_game: dict[str, dict[str, Any]] = {}

    games_with_any_report: set[str] = set()
    games_with_pulse: set[str] = set()

    for app_id, year, reports in _iter_year_files(data_output_path):
        if not reports:
            continue
        games_with_any_report.add(app_id)
        # cache the first non-empty title we see for this app + accumulators for
        # newest report year (used for stale-borked detection later) and tallies
        # by rating (so we can identify the game's dominant rating without a
        # second pass through year files)
        per_game.setdefault(
            app_id,
            {
                "title": "",
                "count": 0,
                "newest_year": 0,
                "ratings": Counter(),
            },
        )
        year_int = int(year) if year.isdigit() else 0
        if year_int > per_game[app_id]["newest_year"]:
            per_game[app_id]["newest_year"] = year_int

        for r in reports:
            if not isinstance(r, dict):
                continue
            total += 1

            src = normalize_source(r)
            rating = normalize_rating(r)
            gpu = normalize_gpu_vendor(r)
            cpu = normalize_cpu_brand(r)
            os_fam = normalize_os_family(r)
            proton = normalize_proton_type(r)
            device = normalize_device_family(r)

            by_source[src] += 1
            by_rating[rating] += 1
            by_gpu[gpu] += 1
            by_cpu[cpu] += 1
            by_os[os_fam] += 1
            by_proton[proton] += 1
            by_device[device] += 1
            if year.isdigit():
                by_year[year] += 1
                by_year_source[year][src] += 1
                by_year_rating[year][rating] += 1

            by_rating_x_gpu[gpu][rating] += 1
            by_rating_x_cpu[cpu][rating] += 1
            by_rating_x_os[os_fam][rating] += 1
            by_rating_x_source[src][rating] += 1
            by_rating_x_device[device][rating] += 1

            if src == "pulse":
                games_with_pulse.add(app_id)

            # latch the first title we see; ProtonDB reports almost always have one
            if not per_game[app_id]["title"]:
                title = (r.get("title") or "").strip()
                if title:
                    per_game[app_id]["title"] = title
            per_game[app_id]["count"] += 1
            per_game[app_id]["ratings"][rating] += 1

    # Top 50 games by report volume
    top_games = sorted(
        ((app_id, info["title"], info["count"]) for app_id, info in per_game.items()),
        key=lambda t: t[2],
        reverse=True,
    )[:50]

    # Stale-borked detection. A game is "worth re-testing" if its overall
    # tier (computed the same way as the search-index summary) is "borked"
    # AND its newest report is at least 2 years old. The narrative: Proton
    # has improved a lot, so old borked verdicts may no longer hold.
    current_year = datetime.now(tz=timezone.utc).year
    stale_cutoff = current_year - 2  # newest_year <= this -> stale
    stale_borked = []
    stale_borked_count = 0
    for app_id, info in per_game.items():
        # Compute overall tier from the same scoring map used elsewhere
        score_sum = 0.0
        rated = 0
        for tier, cnt in info["ratings"].items():
            if tier in _RATING_SCORES:
                score_sum += _RATING_SCORES[tier] * cnt
                rated += cnt
        if rated == 0:
            continue
        overall_tier = _score_to_tier((score_sum / rated) * 100)
        if overall_tier != "borked":
            continue
        if info["newest_year"] == 0 or info["newest_year"] > stale_cutoff:
            continue
        stale_borked_count += 1
        stale_borked.append((app_id, info["title"], info["count"], info["newest_year"]))

    # Top 30 stale-borked by report count (highest-impact candidates to re-test)
    stale_borked.sort(key=lambda t: t[2], reverse=True)
    worth_retesting = stale_borked[:30]

    # Convert nested counters to plain dicts for JSON serialization
    def flatten_cross(cross: dict[str, Counter]) -> dict[str, dict[str, int]]:
        return {k: dict(v) for k, v in cross.items()}

    now = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "generated_at": now,
        "total_reports": total,
        "total_games": len(games_with_any_report),
        "games_with_pulse": len(games_with_pulse),
        "by_source": dict(by_source),
        "by_rating": dict(by_rating),
        "by_gpu_vendor": dict(by_gpu),
        "by_cpu_brand": dict(by_cpu),
        "by_os_family": dict(by_os),
        "by_proton_type": dict(by_proton),
        "by_device_family": dict(by_device),
        "by_year": dict(by_year),
        "by_year_source": {k: dict(v) for k, v in by_year_source.items()},
        # 2D cross-tabs for client-side filtering on the stats page
        "by_rating_x_gpu_vendor": flatten_cross(by_rating_x_gpu),
        "by_rating_x_cpu_brand": flatten_cross(by_rating_x_cpu),
        "by_rating_x_os_family": flatten_cross(by_rating_x_os),
        "by_rating_x_source": flatten_cross(by_rating_x_source),
        "by_rating_x_device_family": flatten_cross(by_rating_x_device),
        # Rating shift over time: { "2025": { "platinum": N, "gold": N, ... }, ... }
        # Powers the trend chart that shows compatibility improving year-over-year
        "by_year_rating": flatten_cross(by_year_rating),
        # Stale-borked detection: games whose overall verdict is "borked" but the
        # newest report is from 2+ years ago. Proton has improved enough that
        # those verdicts may no longer hold -- surface them so users can re-test.
        "stale_borked_count": stale_borked_count,
        "stale_borked_cutoff_year": stale_cutoff,
        # Top 30 stale-borked games by report volume
        "worth_retesting": [
            [app_id, title, count, newest_year]
            for app_id, title, count, newest_year in worth_retesting
        ],
        # Leaderboard
        "top_games": [[app_id, title, count] for app_id, title, count in top_games],
    }


def write_stats_json(data_output_path: Path, output_path: Path) -> Path:
    """Compute aggregations from the data tree and write stats.json next to it.

    Called from finalize_output after pulse merge so it counts both ProtonDB
    and Pulse rows.
    """
    stats = compute_stats(data_output_path)
    stats_file = output_path / "stats.json"
    stats_file.write_text(json.dumps(stats, indent=2) + "\n")
    log(
        f"[stats] Written: {stats_file} "
        f"({stats['total_reports']:,} reports, {stats['total_games']:,} games, "
        f"{stats['games_with_pulse']:,} with Pulse)"
    )
    return stats_file
