"""Generate data-versions.json: a small manifest mapping each pipeline-emitted
data file to a short content hash. Frontend reads the manifest once per page
load (without browser cache) and appends `?v=<hash>` to every data fetch, so a
new pipeline run invalidates only the files whose contents actually changed.

The manifest itself is intentionally not cache-busted -- the frontend always
fetches it with cache: 'no-store'. The trade-off is one tiny network round-trip
per page load in exchange for accurate, file-grained invalidation of every
other data file we serve.

See issue #119.
"""

import hashlib
import json
from pathlib import Path

from .common import log

# The set of data files that benefit from cache-busting -- everything the
# frontend fetches from the gh-pages root. Adding a new emitted data file
# means adding it here so it gets a hash entry.
DATA_FILES = [
    "search-index.json",
    "search-index-steam-extended.json",
    "recent-reports.json",
    "most_played.json",
    "game-images.json",
    "nonsteam-images.json",
    "stats.json",
    "proton-versions.json",
    "release-years-cache.json",
    "game-images-cache.json",
    "steam-catalog.json",
    "gog-catalog.json",
    "epic-catalog.json",
    "scoring-info.json",
    "version.json",
]


def _hash8(path: Path) -> str:
    """Short content hash for a file. Matches the 8-hex-char shape that
    scripts/cache_bust.py emits for JS/CSS so the format reads the same.
    """
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()[:8]


def write_data_versions_json(output_dir) -> dict[str, str]:
    """Emit data-versions.json next to the data files. Returns the manifest
    so callers can log or verify. Missing files are skipped silently -- not
    every pipeline run emits every file (e.g. catalog caches are optional).
    """
    output_dir = Path(output_dir)
    manifest: dict[str, str] = {}
    for name in DATA_FILES:
        path = output_dir / name
        if not path.exists():
            continue
        try:
            manifest[name] = _hash8(path)
        except OSError as exc:
            log(f"[data-versions] WARN: could not hash {name}: {exc}")
    out_path = output_dir / "data-versions.json"
    out_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
    log(f"[data-versions] wrote {len(manifest)} entries to {out_path.name}")
    return manifest
