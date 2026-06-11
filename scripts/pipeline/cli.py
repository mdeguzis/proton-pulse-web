import argparse
import json
import os
import sys
import tempfile
from urllib.error import URLError

from .backfill import run_backfill, run_coverage_backfill, run_probe_backfill
from .catalog import get_steam_api_key, load_steam_game_catalog
from .common import clone_repo, log, set_debug
from .finalize import build_probe_chunk_plan, finalize_output, reindex_apps, update_protondb_probe_cache
from .game_images import build_game_images
from .most_played import build_most_played
from .process import process_reports, seed_official_dump_metadata


def _parse_app_ids(raw: str | None) -> list[str] | None:
    """Turn a comma-separated string of app IDs into a clean list, or None."""
    if not raw or not raw.strip():
        return None
    ids = [s.strip() for s in raw.split(",") if s.strip().isdigit()]
    return ids or None


def process_data(input_dir, output_dir):
    process_reports(input_dir, output_dir)
    run_backfill(output_dir)
    finalize_output(output_dir)
    run_probe_backfill(output_dir)


def build_parser():
    parser = argparse.ArgumentParser(
        description="Split ProtonDB reports into data/{appId}/{year}.json buckets"
    )
    subparsers = parser.add_subparsers(dest="command")

    def add_shared_output_arg(command_parser):
        command_parser.add_argument(
            "output_dir",
            help="Output directory root (split files go under <output_dir>/data/)",
        )

    process_parser = subparsers.add_parser("process", help="Process official ProtonDB dump into year-bucket files")
    process_parser.add_argument("input_dir", nargs="?", help="Local directory containing JSON/tar.gz report files")
    process_parser.add_argument("--url", help="Git repo URL to clone as data source (e.g. https://github.com/bdefore/protondb-data)")
    process_parser.add_argument("--subfolder", default="reports", help="Subfolder within the cloned repo to use as input (default: reports)")
    add_shared_output_arg(process_parser)

    seed_official_parser = subparsers.add_parser(
        "seed-official-metadata",
        help="Seed official_dump metadata from the official ProtonDB dump without rewriting report buckets",
    )
    seed_official_parser.add_argument("input_dir", nargs="?", help="Local directory containing JSON/tar.gz report files")
    seed_official_parser.add_argument("--url", help="Git repo URL to clone as data source (e.g. https://github.com/bdefore/protondb-data)")
    seed_official_parser.add_argument("--subfolder", default="reports", help="Subfolder within the cloned repo to use as input (default: reports)")
    add_shared_output_arg(seed_official_parser)

    backfill_parser = subparsers.add_parser("backfill", help="Backfill missing app data from ProtonDB live detailed reports")
    backfill_parser.add_argument(
        "--app-ids",
        help="Comma-separated app IDs to backfill (skips manifest, only processes these)",
    )
    add_shared_output_arg(backfill_parser)

    finalize_parser = subparsers.add_parser("finalize", help="Generate latest/index files and print final summary")
    finalize_parser.add_argument(
        "--skip-probe",
        action="store_true",
        help="Use cached ProtonDB probe results without performing another active probe pass",
    )
    add_shared_output_arg(finalize_parser)

    probe_parser = subparsers.add_parser("probe", help="Probe ProtonDB summaries and update the probe cache")
    add_shared_output_arg(probe_parser)

    probe_plan_parser = subparsers.add_parser("probe-plan", help="Calculate the dynamic probe chunk plan")
    add_shared_output_arg(probe_plan_parser)

    probe_backfill_parser = subparsers.add_parser("probe-backfill", help="Backfill data for apps discovered by the ProtonDB probe")
    add_shared_output_arg(probe_backfill_parser)

    coverage_backfill_parser = subparsers.add_parser(
        "coverage-backfill",
        help="Backfill apps matching a coverage issue type",
    )
    coverage_backfill_parser.add_argument(
        "--issue-type",
        required=True,
        choices=["no-titles", "bad-app-id", "no-protondb-data"],
        help="Coverage issue type to backfill",
    )
    coverage_backfill_parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max apps to backfill (0 means no limit)",
    )
    coverage_backfill_parser.add_argument(
        "--allow-unbounded",
        action="store_true",
        help="Deprecated no-op kept for compatibility; unbounded runs are allowed by default",
    )
    add_shared_output_arg(coverage_backfill_parser)

    reindex_parser = subparsers.add_parser("reindex", help="Rebuild index.json for specific app IDs only")
    reindex_parser.add_argument(
        "--app-ids",
        required=True,
        help="Comma-separated app IDs to reindex",
    )
    add_shared_output_arg(reindex_parser)

    subparsers.add_parser("steam-catalog", help="Fetch and cache the Steam game catalog using STEAM_API_KEY")

    most_played_parser = subparsers.add_parser(
        "most-played",
        help="Build most_played.json (Steam's most-played games we have a tier for)",
    )
    most_played_parser.add_argument(
        "--limit", type=int, default=15, help="Max games to include (default: 15)"
    )
    add_shared_output_arg(most_played_parser)

    run_parser = subparsers.add_parser("run", help="Run process, backfill, and finalize in sequence")
    run_parser.add_argument("input_dir", nargs="?", help="Local directory containing JSON/tar.gz report files")
    run_parser.add_argument("--url", help="Git repo URL to clone as data source (e.g. https://github.com/bdefore/protondb-data)")
    run_parser.add_argument("--subfolder", default="reports", help="Subfolder within the cloned repo to use as input (default: reports)")
    add_shared_output_arg(run_parser)

    parser.add_argument("--debug", action="store_true", help="Enable verbose debug logging")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    set_debug(args.debug)
    command = args.command or "run"

    if command in {"process", "run", "seed-official-metadata"}:
        output_dir = args.output_dir
        if getattr(args, "url", None):
            tmp_dir = tempfile.mkdtemp(prefix="protondb-clone-")
            clone_repo(args.url, tmp_dir)
            input_dir = os.path.join(tmp_dir, args.subfolder)
            log(f"[init] Using cloned subfolder: {input_dir}", debug=True)
        elif getattr(args, "input_dir", None):
            input_dir = args.input_dir
        else:
            log("!! ERROR: provide input_dir or --url")
            parser.print_help()
            sys.exit(1)

        if command == "process":
            process_reports(input_dir, output_dir)
        elif command == "seed-official-metadata":
            seed_official_dump_metadata(input_dir, output_dir)
        else:
            process_data(input_dir, output_dir)
        return

    if command == "backfill":
        target_ids = _parse_app_ids(getattr(args, "app_ids", None))
        run_backfill(args.output_dir, target_app_ids=target_ids)
        return

    if command == "finalize":
        finalize_output(args.output_dir, skip_probe=getattr(args, "skip_probe", False))
        return

    if command == "probe":
        update_protondb_probe_cache(args.output_dir)
        return

    if command == "most-played":
        build_most_played(args.output_dir, limit=getattr(args, "limit", 15))
        build_game_images(args.output_dir)
        return

    if command == "probe-plan":
        print(json.dumps(build_probe_chunk_plan(args.output_dir)))
        return

    if command == "probe-backfill":
        run_probe_backfill(args.output_dir)
        return

    if command == "reindex":
        target_ids = _parse_app_ids(getattr(args, "app_ids", None))
        if not target_ids:
            log("!! ERROR: --app-ids is required for reindex")
            sys.exit(1)
        reindex_apps(args.output_dir, target_ids)
        return

    if command == "coverage-backfill":
        run_coverage_backfill(
            args.output_dir,
            issue_type=args.issue_type,
            limit=getattr(args, "limit", 0),
            allow_unbounded=getattr(args, "allow_unbounded", False),
        )
        return

    if command == "steam-catalog":
        steam_api_key = get_steam_api_key(os.environ)
        if not steam_api_key:
            log("!! ERROR: STEAM_API_KEY not found in environment or .env")
            raise SystemExit(1)
        try:
            catalog = load_steam_game_catalog(steam_api_key)
        except URLError as exc:
            log(f"!! ERROR: Failed to reach Steam app list endpoint: {exc}")
            log("!! Check network/DNS connectivity and confirm the Steam API host is reachable.")
            raise SystemExit(1) from exc
        log(f"[steam-catalog] Ready with {len(catalog):,} app IDs")
        return

    parser.print_help()
    sys.exit(1)
