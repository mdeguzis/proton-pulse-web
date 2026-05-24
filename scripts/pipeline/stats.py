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
    by_year: Counter = Counter()
    by_year_source: dict[str, Counter] = defaultdict(Counter)

    # 2D cross-tabs: rating broken down by each hardware dimension
    # shape: { dimension_value: Counter(rating -> count) }
    by_rating_x_gpu: dict[str, Counter] = defaultdict(Counter)
    by_rating_x_cpu: dict[str, Counter] = defaultdict(Counter)
    by_rating_x_os: dict[str, Counter] = defaultdict(Counter)
    by_rating_x_source: dict[str, Counter] = defaultdict(Counter)

    # Per-app counts for the "top games" leaderboard
    per_game: dict[str, dict[str, Any]] = {}

    games_with_any_report: set[str] = set()
    games_with_pulse: set[str] = set()

    for app_id, year, reports in _iter_year_files(data_output_path):
        if not reports:
            continue
        games_with_any_report.add(app_id)
        # cache the first non-empty title we see for this app
        per_game.setdefault(app_id, {"title": "", "count": 0})

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

            by_source[src] += 1
            by_rating[rating] += 1
            by_gpu[gpu] += 1
            by_cpu[cpu] += 1
            by_os[os_fam] += 1
            by_proton[proton] += 1
            if year.isdigit():
                by_year[year] += 1
                by_year_source[year][src] += 1

            by_rating_x_gpu[gpu][rating] += 1
            by_rating_x_cpu[cpu][rating] += 1
            by_rating_x_os[os_fam][rating] += 1
            by_rating_x_source[src][rating] += 1

            if src == "pulse":
                games_with_pulse.add(app_id)

            # latch the first title we see; ProtonDB reports almost always have one
            if not per_game[app_id]["title"]:
                title = (r.get("title") or "").strip()
                if title:
                    per_game[app_id]["title"] = title
            per_game[app_id]["count"] += 1

    # Top 50 games by report volume
    top_games = sorted(
        ((app_id, info["title"], info["count"]) for app_id, info in per_game.items()),
        key=lambda t: t[2],
        reverse=True,
    )[:50]

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
        "by_year": dict(by_year),
        "by_year_source": {k: dict(v) for k, v in by_year_source.items()},
        # 2D cross-tabs for client-side filtering on the stats page
        "by_rating_x_gpu_vendor": flatten_cross(by_rating_x_gpu),
        "by_rating_x_cpu_brand": flatten_cross(by_rating_x_cpu),
        "by_rating_x_os_family": flatten_cross(by_rating_x_os),
        "by_rating_x_source": flatten_cross(by_rating_x_source),
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
