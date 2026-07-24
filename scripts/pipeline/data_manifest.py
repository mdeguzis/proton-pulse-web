"""Generate data-manifest.json: a content-hash manifest of every per-game file
under <output>/data/ (issue #392).

The R2 deploy used to run `aws s3 sync` over ~187k small JSON files. sync
compares mtime, and the pipeline rewrites every file each run, so 50-80k
"changed" files uploaded even when ~95% were byte-identical -- 30-120 min per
deploy at R2's effective per-object throughput. This manifest restores the
content-delta property GitHub Pages gave us for free via git: hash every file
at emission time, diff against the manifest from the previous deploy (stored
in the bucket at _meta/data-manifest.json), and upload only real changes.

Keys are POSIX relative paths under data/ ("730/latest.json"); values are the
full sha256 hex digest. Full hashes, not truncated: the manifest doubles as
the integrity-verification artifact for the post-deploy sample check in
scripts/publish-cloudflare.sh, so collision resistance matters more than the
~16 MB object size.

.html files are excluded to mirror the sync's `--exclude "*.html"` -- they
never ship to R2, so hashing them would only add churn.

Consumed by scripts/pipeline/manifest_delta.py + scripts/publish-cloudflare.sh.
"""

import hashlib
import json
import time
from pathlib import Path

from .common import log

MANIFEST_NAME = "data-manifest.json"

# Mirrors the `--exclude "*.html"` on the R2 sync in publish-cloudflare.sh:
# per-game index.html files are gh-pages-only and never uploaded to R2.
EXCLUDE_SUFFIXES = (".html",)


def _sha256(path: Path) -> str:
    """Full sha256 hex digest, chunked read. Same shape as
    data_versions._hash8 but untruncated -- this manifest is an integrity
    artifact, not just a cache-buster."""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_data_manifest(output_dir) -> dict[str, str]:
    """Walk <output>/data/ and emit data-manifest.json at the output root.

    Returns the manifest dict so callers can log or verify. Must run after
    every generator that writes under data/ (latest/index/metadata/depots/
    pulse) so the hashes reflect what actually deploys. Missing data/ writes
    an empty manifest rather than failing -- pages-only runs have no data
    tree and the deploy script falls back to a full sync when the manifest
    is absent or empty.
    """
    output_dir = Path(output_dir)
    data_dir = output_dir / "data"
    manifest: dict[str, str] = {}
    started = time.time()
    if data_dir.is_dir():
        for path in data_dir.rglob("*"):
            if not path.is_file():
                continue
            if path.name.endswith(EXCLUDE_SUFFIXES):
                continue
            key = path.relative_to(data_dir).as_posix()
            try:
                manifest[key] = _sha256(path)
            except OSError as exc:
                log(f"[data-manifest] WARN: could not hash {key}: {exc}")
    else:
        log(f"[data-manifest] WARN: {data_dir} not found; writing empty manifest")
    out_path = output_dir / MANIFEST_NAME
    out_path.write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    elapsed = time.time() - started
    log(
        f"[data-manifest] wrote {len(manifest)} entries to {out_path.name} "
        f"({elapsed:.1f}s, source=data-tree-walk, excluded={EXCLUDE_SUFFIXES})"
    )
    return manifest
