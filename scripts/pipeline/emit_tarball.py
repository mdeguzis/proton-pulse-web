"""Emit an uncompressed tarball of /tmp/protondb-output/data/ plus a manifest
that lets a Cloudflare Worker seek into it via HTTP Range requests (#392 slice 1).

Why a manifest: the Worker cannot afford to read the whole tarball on every
request, but R2 supports byte-range GETs natively. The manifest maps every
logical file path to `{ offset, length, sha256 }` in the tarball so a
single Range fetch returns exactly the bytes for one file.

Why uncompressed: keeps the byte-offset math trivial. Compression can land
in a follow-up slice if bandwidth turns out to matter -- R2 read costs at
our scale (~150 MB total) are dominated by requests, not bytes.

Behind `EMIT_TARBALL=true` env var. Default off, so the existing per-object
sync still runs and this slice does not disrupt production while we
validate. Slice 2 wires a Worker on data.proton-pulse.com; slice 3 flips
the pipeline to stop the per-object sync once the Worker is verified.

Output (under `<output_dir>/tarballs/`):
    data-<timestamp>.tar     -- uncompressed tar, all files under data/
    data-manifest.json       -- { generated_at, tar_key, file_count,
                                  total_bytes, files: { path: {offset,
                                  length, sha256} } }
    latest.json              -- pointer { tar_key, manifest_key,
                                  generated_at } (small; the Worker
                                  reads this first to find the current
                                  tar + manifest)

Empty data/ produces empty artifacts and a warning log; never fails.

Related: #379 (aws sync retry, the current mitigation), #381 (backup
tarballs, same tar-as-transport pattern applied to a different problem).
"""
from __future__ import annotations

import hashlib
import json
import os as _os
import tarfile
import time
from pathlib import Path

from .common import log

# Feature flag. Default off. When set, the pipeline emits the tarball
# alongside the per-object output; publish-cloudflare.sh reads this
# same env to decide whether to upload it.
EMIT_TARBALL = _os.environ.get("EMIT_TARBALL", "").lower() in ("1", "true", "yes")

# Fixed tar block size. Every entry in a POSIX tar starts on a 512-byte
# boundary, and file data is followed by NUL padding to the next 512-byte
# boundary. The manifest records the raw data offset (past the header)
# and the raw byte length, so the Worker's Range fetch returns exactly
# the file bytes with no padding to strip.
_TAR_BLOCK = 512

_TARBALLS_DIR = "tarballs"
_MANIFEST_FILENAME = "data-manifest.json"
_POINTER_FILENAME = "latest.json"


def _hash_file(path: Path) -> str:
    """Streaming SHA-256 of a file. Kept simple; the pipeline writes files
    one at a time so the working set is tiny.
    """
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _iso_utc(now: float | None = None) -> str:
    """Return the UTC time as a compact filename-safe ISO string."""
    return time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime(now))


def emit_data_tarball(output_dir: Path) -> dict | None:
    """Package `<output_dir>/data/` into a tarball + manifest under
    `<output_dir>/tarballs/`. Returns the manifest dict on success or None
    when EMIT_TARBALL is off or the data tree is missing.

    The tarball is a plain POSIX tar (no compression). Every regular file
    under `data/` is included; symlinks and directories are dropped from
    the manifest (they carry no bytes worth serving).
    """
    if not EMIT_TARBALL:
        return None
    output_dir = Path(output_dir)
    data_dir = output_dir / "data"
    if not data_dir.is_dir():
        log("[emit-tarball] no data/ directory; skipping")
        return None

    tarballs_dir = output_dir / _TARBALLS_DIR
    tarballs_dir.mkdir(parents=True, exist_ok=True)

    timestamp = time.time()
    tar_name = f"data-{_iso_utc(timestamp)}.tar"
    tar_path = tarballs_dir / tar_name

    files: dict[str, dict] = {}
    total_bytes = 0

    log(f"[emit-tarball] writing {tar_path.name} + manifest ...")
    started = time.time()

    # Walk `data/` in a stable order so the same input produces the same
    # tarball layout. Sorted-relative walk avoids OS-dependent ordering.
    entries: list[tuple[Path, str]] = []
    for path in sorted(data_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(data_dir).as_posix()
        entries.append((path, rel))

    with tarfile.open(tar_path, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for path, rel in entries:
            info = tar.gettarinfo(str(path), arcname=rel)
            # Force reproducible metadata so the same input tarballs
            # byte-identically across runs -- makes downstream CDN caching
            # + verification easier.
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            info.mode = 0o644
            # tarfile emits the header (~512 bytes) immediately, then the
            # data block. `tar.fileobj.tell()` after addfile's header write
            # would report the data-start offset, but tarfile does not
            # expose it cleanly. Instead compute the data offset ahead of
            # time from the current position, then write the entry.
            header_offset = tar.fileobj.tell()
            data_offset = header_offset + _TAR_BLOCK  # header is exactly one block
            with path.open("rb") as fh:
                tar.addfile(info, fh)
            length = info.size
            files[rel] = {
                "offset": data_offset,
                "length": length,
                "sha256": _hash_file(path),
            }
            total_bytes += length

    tar_size = tar_path.stat().st_size
    manifest = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp)),
        "tar_key": tar_name,
        "tar_size": tar_size,
        "file_count": len(files),
        "total_bytes": total_bytes,
        "files": files,
    }

    (tarballs_dir / _MANIFEST_FILENAME).write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )

    # Small pointer object -- the Worker reads this first (cached in KV)
    # to discover the current tar + manifest keys. Separating the pointer
    # from the manifest means the Worker can invalidate a flip without
    # re-downloading the manifest.
    pointer = {
        "generated_at": manifest["generated_at"],
        "tar_key": tar_name,
        "manifest_key": _MANIFEST_FILENAME,
    }
    (tarballs_dir / _POINTER_FILENAME).write_text(
        json.dumps(pointer, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )

    elapsed = time.time() - started
    log(
        f"[emit-tarball] done in {elapsed:.1f}s: "
        f"{len(files)} files, {tar_size} bytes packed, {total_bytes} bytes raw"
    )
    return manifest
