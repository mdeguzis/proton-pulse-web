"""Diff two data-manifest.json files and stage only the changed files (#392).

Called by scripts/publish-cloudflare.sh between "download the previous
manifest from R2" and "aws s3 sync the staged delta". Pure local compute:
the git-like content compare that `aws s3 sync` (mtime-based) cannot do.

Exit codes:
  0 -- delta staged, summary line printed
  2 -- usage / IO error (deploy should fail loudly)
  3 -- bootstrap: old manifest missing or unparsable -> caller falls back
       to a full sync. Never crash the deploy over a bad previous manifest;
       a full sync is always a safe recovery.

Summary line (machine-readable, parsed by the shell script for logging):
  total=187432 added=812 changed=1937 deleted=44 skipped_identical=184639

The --sample-out file drives the post-deploy integrity check: one
"<key>\t<sha256>" line per sampled object -- every added/changed key
(capped) plus a deterministic sample of unchanged keys, so the verify step
covers both "did the upload land intact" and "did the untouched objects
stay intact". Hash inline so the shell verify loop never re-parses the
~16 MB manifest.
"""

import argparse
import json
import os
import random
import shutil
import sys
from pathlib import Path

# Verify-sample sizing: enough GETs to catch systematic corruption, few
# enough that the post-deploy check stays under ~2 min of sequential GETs.
SAMPLE_CHANGED_CAP = 100
SAMPLE_UNCHANGED_COUNT = 100

BOOTSTRAP_EXIT = 3


def diff_manifests(old: dict, new: dict) -> tuple[list, list, list]:
    """Partition new-vs-old into (added, changed, deleted) key lists.

    Keys in both with identical hashes are the skipped set -- the whole
    point of the delta sync. Deleted keys are reported for logging only;
    the deploy never removes R2 objects (matches the historical sync,
    which ran without --delete).
    """
    added = sorted(k for k in new if k not in old)
    changed = sorted(k for k in new if k in old and old[k] != new[k])
    deleted = sorted(k for k in old if k not in new)
    return added, changed, deleted


def stage_delta(data_dir, stage_dir, keys) -> int:
    """Recreate <stage_dir>/<key> for every key, preserving relative paths.

    Hardlink when possible (same filesystem: near-instant, no extra disk),
    copy as fallback. Returns the number of files staged. Missing source
    files raise -- a key in the new manifest with no file on disk means the
    manifest and tree are out of sync, which must fail the deploy."""
    data_dir = Path(data_dir)
    stage_dir = Path(stage_dir)
    staged = 0
    for key in keys:
        src = data_dir / key
        dst = stage_dir / key
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
        staged += 1
    return staged


def build_verify_sample(added, changed, unchanged) -> list:
    """Keys for the post-deploy GET+sha256 check: all uploads (capped) plus
    a deterministic random sample of unchanged keys. Seeded from the key
    set itself so two runs over the same data pick the same sample --
    reproducible when debugging a verify failure."""
    uploads = (added + changed)[: SAMPLE_CHANGED_CAP]
    rng = random.Random(len(unchanged))
    extra = rng.sample(unchanged, min(SAMPLE_UNCHANGED_COUNT, len(unchanged)))
    return uploads + sorted(extra)


def _load_manifest(path: Path) -> dict | None:
    """None means bootstrap (missing/corrupt) -- full sync fallback."""
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-manifest", required=True, help="previous manifest pulled from R2 (may not exist)")
    parser.add_argument("--new-manifest", required=True, help="manifest emitted by this pipeline run")
    parser.add_argument("--data-dir", required=True, help="pipeline output data/ tree")
    parser.add_argument("--stage-dir", required=True, help="where to stage the delta for aws s3 sync")
    parser.add_argument("--sample-out", required=True, help="file to write the verify-sample key list")
    args = parser.parse_args(argv)

    new = _load_manifest(Path(args.new_manifest))
    if new is None:
        print(f"ERROR: new manifest missing or invalid: {args.new_manifest}", file=sys.stderr)
        return 2

    old = _load_manifest(Path(args.old_manifest))
    if old is None:
        print("bootstrap: no usable previous manifest -- caller should full-sync", file=sys.stderr)
        return BOOTSTRAP_EXIT

    added, changed, deleted = diff_manifests(old, new)
    unchanged = sorted(k for k in new if k in old and old[k] == new[k])

    stage_delta(args.data_dir, args.stage_dir, added + changed)

    sample = build_verify_sample(added, changed, unchanged)
    sample_path = Path(args.sample_out)
    sample_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{k}\t{new[k]}" for k in sample]
    sample_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")

    print(
        f"total={len(new)} added={len(added)} changed={len(changed)} "
        f"deleted={len(deleted)} skipped_identical={len(unchanged)}"
    )
    if deleted:
        preview = ", ".join(deleted[:5])
        print(f"deleted keys (logged only, never removed from R2): {preview}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
