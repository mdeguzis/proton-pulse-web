import argparse
import os
import sys
import tempfile
from urllib.error import URLError

from .backfill import run_backfill
from .catalog import get_steam_api_key, load_steam_game_catalog
from .common import clone_repo, log, set_debug
from .finalize import finalize_output
from .process import process_reports


def process_data(input_dir, output_dir):
    process_reports(input_dir, output_dir)
    run_backfill(output_dir)
    finalize_output(output_dir)


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

    backfill_parser = subparsers.add_parser("backfill", help="Backfill missing app data from ProtonDB live detailed reports")
    add_shared_output_arg(backfill_parser)

    finalize_parser = subparsers.add_parser("finalize", help="Generate latest/index files and print final summary")
    add_shared_output_arg(finalize_parser)

    subparsers.add_parser("steam-catalog", help="Fetch and cache the Steam game catalog using STEAM_API_KEY")

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

    if command in {"process", "run"}:
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
        else:
            process_data(input_dir, output_dir)
        return

    if command == "backfill":
        run_backfill(args.output_dir)
        return

    if command == "finalize":
        finalize_output(args.output_dir)
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
