"""Parse ProtonDB report archives and split into per-app year files"""

import json
import tarfile
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import ijson  # pylint: disable=import-error

from .common import app_id_to_dir, log
from .metadata import update_app_metadata
from .state import pipeline_state_path, write_pipeline_state

TARBALL_CACHE_FILENAME = "processed-tarballs.json"
DEFAULT_TARBALL_CACHE_PATH = (
    Path(__file__).resolve().parents[2] / ".cache" / TARBALL_CACHE_FILENAME
)


def parse_and_split(file_handle, data_output_path, source_label="?"):
    """
    Stream-parse a report array and write output as:
        data/{app_id_to_dir(appId)}/{year}.json
    Each year file is a JSON array of all reports for that app in that year.
    Appends to existing year files so multiple source archives merge correctly.
    Deduplicates by timestamp to guard against the same archive appearing both
    as a loose .json and inside a .tar.gz in the same reports/ folder.
    """
    count = 0
    skipped = 0
    buffer: dict[tuple, list] = defaultdict(list)
    parser = ijson.items(file_handle, "item")

    for report in parser:
        app_id = str(report.get("appId", "")).strip()
        if not app_id or not app_id.isdigit():
            skipped += 1
            continue

        ts = report.get("timestamp")
        try:
            year = (
                str(datetime.fromtimestamp(int(ts), tz=timezone.utc).year)
                if ts
                else "unknown"
            )
        except (ValueError, OSError):
            year = "unknown"

        # Tag every parsed report with its origin. ProtonDB feeds this writer;
        # Pulse Reports come from Supabase and get their own source="pulse" tag
        # in app.js at render time. Don't overwrite an existing source field --
        # future archives may already carry one (e.g. partner imports).
        report.setdefault("source", "protondb")

        buffer[(str(app_id), year)].append(report)
        count += 1

        if count % 10000 == 0:
            log(f"  [parse] {source_label}: {count:,} reports buffered...", debug=True)

    log(
        f"  [parse] {source_label}: flushing {len(buffer)} app/year buckets to disk...",
        debug=True,
    )
    flush_start = time.time()

    for (app_id, year), new_reports in buffer.items():
        # Non-Steam IDs use ':' canonically (e.g. 'gog:123'). Convert to a
        # filesystem-safe dir name ('gog_123') so process and finalize agree.
        app_dir = data_output_path / app_id_to_dir(app_id)
        app_dir.mkdir(exist_ok=True)
        year_file = app_dir / f"{year}.json"

        existing = []
        if year_file.exists():
            try:
                existing = json.loads(year_file.read_text())
            except (json.JSONDecodeError, OSError):
                existing = []

        # Backfill source on legacy reports written before the field existed.
        # These came from ProtonDB archives originally, so the default is safe
        for report in existing:
            report.setdefault("source", "protondb")

        seen_timestamps = {r.get("timestamp") for r in existing}
        added = 0
        for report in new_reports:
            ts = report.get("timestamp")
            if ts not in seen_timestamps:
                existing.append(report)
                seen_timestamps.add(ts)
                added += 1

        if added < len(new_reports):
            dupes = len(new_reports) - added
            log(
                f"  [dedup] appId={app_id} year={year}: skipped {dupes} duplicate(s)",
                debug=True,
            )

        year_file.write_text(json.dumps(existing, indent=2))
        update_app_metadata(data_output_path, app_id, official_dump=True)

    flush_elapsed = time.time() - flush_start
    log(f"  [parse] {source_label}: flush done in {flush_elapsed:.1f}s", debug=True)

    if skipped:
        log(
            f"  [parse] {source_label}: skipped {skipped} records missing appId",
            debug=True,
        )

    return count, set(buffer.keys())


def _tarball_key(file_path: Path) -> str:
    return f"{file_path.name}:{file_path.stat().st_size}"


def _read_tarball_cache() -> set[str]:
    if not DEFAULT_TARBALL_CACHE_PATH.exists():
        return set()
    try:
        return set(json.loads(DEFAULT_TARBALL_CACHE_PATH.read_text()))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return set()


def _write_tarball_cache(processed: set[str]) -> None:
    DEFAULT_TARBALL_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    DEFAULT_TARBALL_CACHE_PATH.write_text(
        json.dumps(sorted(processed), indent=2) + "\n"
    )


def _iter_app_ids_from_stream(file_handle):
    parser = ijson.items(file_handle, "item")
    for report in parser:
        app_id = str(report.get("appId", "")).strip()
        if app_id and app_id.isdigit():
            yield app_id


def seed_official_dump_metadata(input_dir, output_dir):
    """Mark app metadata as official_dump=True using the upstream dump archive."""
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    data_output_path.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        raise SystemExit(f"!! ERROR: Input directory does not exist: {input_path}")

    official_app_ids: set[str] = set()
    json_files = sorted(input_path.glob("*.json"))
    tar_files = sorted(input_path.glob("*.tar.gz"))

    log(
        f"[official-metadata] Scanning {len(json_files):,} JSON file(s) and "
        f"{len(tar_files):,} tarball(s) for official app IDs"
    )

    for json_file in json_files:
        with json_file.open("rb") as handle:
            official_app_ids.update(_iter_app_ids_from_stream(handle))

    for tar_file in tar_files:
        with tarfile.open(tar_file, "r:gz") as tar:
            members = [m for m in tar.getmembers() if m.isfile() and m.name.endswith(".json")]
            for member in members:
                extracted = tar.extractfile(member)
                if extracted is None:
                    continue
                official_app_ids.update(_iter_app_ids_from_stream(extracted))

    updated = 0
    for app_id in sorted(official_app_ids):
        metadata = update_app_metadata(data_output_path, app_id, official_dump=True)
        if metadata.get("official_dump"):
            updated += 1

    log(
        f"[official-metadata] Marked {updated:,} app(s) as official dump provenance"
    )


def process_reports(input_dir, output_dir):
    """Walk input_dir for JSON/tarball report files, parse and split into per-app year buckets"""
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    data_output_path = output_path / "data"
    data_output_path.mkdir(parents=True, exist_ok=True)

    log(f"[init] Input dir : {input_path.resolve()}")
    log(f"[init] Output dir: {data_output_path.resolve()}")

    if not input_path.exists():
        raise SystemExit(f"!! ERROR: Input directory does not exist: {input_path}")

    all_files = list(input_path.iterdir())
    log(f"[init] Files found in input dir: {len(all_files)}", debug=True)
    for file_path in sorted(all_files)[:20]:
        size = file_path.stat().st_size if file_path.is_file() else 0
        log(f"  {file_path.name}  ({size:,} bytes)", debug=True)
    if len(all_files) > 20:
        log(f"  ... and {len(all_files) - 20} more", debug=True)

    tarball_cache = _read_tarball_cache()
    if tarball_cache:
        log(f"[cache] Loaded {len(tarball_cache)} previously processed tarball(s)")

    parsed_count = 0
    index_keys: set[tuple] = set()

    json_files = sorted(input_path.glob("*.json"))
    log(f"\n[json] Found {len(json_files)} raw JSON file(s)")
    for index, json_file in enumerate(json_files, start=1):
        size = json_file.stat().st_size
        log(
            f"[json] Processing {index}/{len(json_files)}: {json_file.name} ({size:,} bytes)"
        )
        t0 = time.time()
        with json_file.open("rb") as handle:
            count, src_keys = parse_and_split(
                handle, data_output_path, source_label=json_file.name
            )
        parsed_count += count
        index_keys.update(src_keys)
        log(f"[json] Done: {count:,} reports in {time.time() - t0:.1f}s")

    tar_files = sorted(input_path.glob("*.tar.gz"))
    log(f"\n[tar] Found {len(tar_files)} tarball(s)")
    skipped_count = 0
    for index, tar_file in enumerate(tar_files, start=1):
        key = _tarball_key(tar_file)
        if key in tarball_cache:
            skipped_count += 1
            log(f"[tar] Skipping {index}/{len(tar_files)}: {tar_file.name} (cached)")
            continue

        size = tar_file.stat().st_size
        log(
            f"[tar] Processing {index}/{len(tar_files)}: {tar_file.name} ({size:,} bytes)"
        )
        t0 = time.time()
        try:
            with tarfile.open(tar_file, "r:gz") as tar:
                members = [m for m in tar.getmembers() if m.name.endswith(".json")]
                log(
                    f"[tar]   Streaming {len(members)} JSON member(s) from archive",
                    debug=True,
                )
                for member in members:
                    log(f"[tar]   -> {member.name} ({member.size:,} bytes)", debug=True)
                    extracted = tar.extractfile(member)
                    if extracted:
                        count, src_keys = parse_and_split(
                            extracted, data_output_path, source_label=member.name
                        )
                        log(f"[tar]      {count:,} reports parsed")
                        parsed_count += count
                        index_keys.update(src_keys)
            tarball_cache.add(key)
        except (tarfile.TarError, OSError) as exc:
            log(f"!! Failed to process {tar_file.name}: {exc}")
        log(f"[tar] Done: {time.time() - t0:.1f}s")

    if skipped_count:
        log(
            f"[cache] Skipped {skipped_count}/{len(tar_files)} already-processed tarball(s)"
        )

    _write_tarball_cache(tarball_cache)
    log(f"[cache] Saved tarball cache: {DEFAULT_TARBALL_CACHE_PATH}")

    if parsed_count == 0 and not tarball_cache:
        log(f"!! ERROR: No reports were parsed from {input_dir}.")
        log(f"!! Found {len(json_files)} JSONs and {len(tar_files)} tarballs.")
        raise SystemExit(1)

    write_pipeline_state(output_path, parsed_count, index_keys)
    log(f"[state] Wrote pipeline state: {pipeline_state_path(output_path)}")
    log("Done processing official reports.")
