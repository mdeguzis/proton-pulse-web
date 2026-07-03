"""Tests for cli.main() dispatch logic."""
import json
import sys
import pytest
from unittest.mock import patch, MagicMock
from scripts.pipeline.cli import main, process_data


# ── process_data ──────────────────────────────────────────────────────────────

def test_process_data_calls_all_three(tmp_path):
    with (
        patch("scripts.pipeline.cli.process_reports") as mock_process,
        patch("scripts.pipeline.cli.run_backfill") as mock_backfill,
        patch("scripts.pipeline.cli.finalize_output") as mock_finalize,
        patch("scripts.pipeline.cli.run_probe_backfill") as mock_probe,
    ):
        process_data("/input", "/output")
        mock_process.assert_called_once_with("/input", "/output")
        mock_backfill.assert_called_once_with("/output")
        mock_finalize.assert_called_once_with("/output")
        mock_probe.assert_called_once_with("/output")


# ── main() dispatch ───────────────────────────────────────────────────────────

def _run_main(*argv):
    with patch.object(sys, "argv", ["cli"] + list(argv)):
        main()


def test_main_backfill_no_app_ids(tmp_path):
    with patch("scripts.pipeline.cli.run_backfill") as mock:
        _run_main("backfill", str(tmp_path))
        mock.assert_called_once_with(str(tmp_path), target_app_ids=None)


def test_main_backfill_with_app_ids(tmp_path):
    with patch("scripts.pipeline.cli.run_backfill") as mock:
        _run_main("backfill", "--app-ids", "730,570", str(tmp_path))
        mock.assert_called_once_with(str(tmp_path), target_app_ids=["730", "570"])


def test_main_finalize(tmp_path):
    with patch("scripts.pipeline.cli.finalize_output") as mock:
        _run_main("finalize", str(tmp_path))
        mock.assert_called_once_with(str(tmp_path), skip_probe=False)


def test_main_finalize_skip_probe(tmp_path):
    with patch("scripts.pipeline.cli.finalize_output") as mock:
        _run_main("finalize", "--skip-probe", str(tmp_path))
        mock.assert_called_once_with(str(tmp_path), skip_probe=True)


def test_main_probe(tmp_path):
    with patch("scripts.pipeline.cli.update_protondb_probe_cache") as mock:
        _run_main("probe", str(tmp_path))
        mock.assert_called_once_with(str(tmp_path))


def test_main_probe_plan(tmp_path, capsys):
    with patch("scripts.pipeline.cli.build_probe_chunk_plan", return_value={"chunks": []}):
        _run_main("probe-plan", str(tmp_path))
    captured = capsys.readouterr()
    assert "chunks" in captured.out


def test_main_probe_backfill(tmp_path):
    with patch("scripts.pipeline.cli.run_probe_backfill") as mock:
        _run_main("probe-backfill", str(tmp_path))
        mock.assert_called_once_with(str(tmp_path))


def test_main_most_played(tmp_path):
    with (
        patch("scripts.pipeline.cli.build_most_played") as mock_mp,
        patch("scripts.pipeline.cli.build_game_images") as mock_gi,
        patch("scripts.pipeline.cli.build_deck_status") as mock_deck,
    ):
        _run_main("most-played", str(tmp_path))
        mock_mp.assert_called_once_with(str(tmp_path), limit=15)
        mock_gi.assert_called_once_with(str(tmp_path))
        mock_deck.assert_called_once_with(str(tmp_path))


def test_main_most_played_with_limit(tmp_path):
    with (
        patch("scripts.pipeline.cli.build_most_played") as mock_mp,
        patch("scripts.pipeline.cli.build_game_images"),
        patch("scripts.pipeline.cli.build_deck_status"),
    ):
        _run_main("most-played", "--limit", "50", str(tmp_path))
        mock_mp.assert_called_once_with(str(tmp_path), limit=50)


def test_main_deck_status(tmp_path):
    with patch("scripts.pipeline.cli.build_deck_status") as mock_deck:
        _run_main("deck-status", str(tmp_path))
        mock_deck.assert_called_once_with(str(tmp_path))


def test_main_reindex(tmp_path):
    with patch("scripts.pipeline.cli.reindex_apps") as mock:
        _run_main("reindex", "--app-ids", "730,570", str(tmp_path))
        mock.assert_called_once_with(str(tmp_path), ["730", "570"])


def test_main_reindex_no_ids_exits(tmp_path):
    with pytest.raises(SystemExit):
        _run_main("reindex", "--app-ids", "notanid", str(tmp_path))


def test_main_coverage_backfill(tmp_path):
    with patch("scripts.pipeline.cli.run_coverage_backfill") as mock:
        _run_main("coverage-backfill", "--issue-type", "no-titles", str(tmp_path))
        mock.assert_called_once_with(
            str(tmp_path), issue_type="no-titles", limit=0, allow_unbounded=False
        )


def test_main_coverage_backfill_with_limit(tmp_path):
    with patch("scripts.pipeline.cli.run_coverage_backfill") as mock:
        _run_main("coverage-backfill", "--issue-type", "bad-app-id", "--limit", "5", str(tmp_path))
        mock.assert_called_once_with(
            str(tmp_path), issue_type="bad-app-id", limit=5, allow_unbounded=False
        )


def test_main_steam_catalog_no_key_exits(tmp_path):
    with patch("scripts.pipeline.cli.get_steam_api_key", return_value=None):
        with pytest.raises(SystemExit):
            _run_main("steam-catalog")


def test_main_steam_catalog_success(tmp_path):
    with (
        patch("scripts.pipeline.cli.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.cli.load_steam_game_catalog", return_value={"730": "CS2"}),
    ):
        _run_main("steam-catalog")


def test_main_steam_catalog_url_error(tmp_path):
    from urllib.error import URLError
    with (
        patch("scripts.pipeline.cli.get_steam_api_key", return_value="KEY"),
        patch("scripts.pipeline.cli.load_steam_game_catalog", side_effect=URLError("timeout")),
    ):
        with pytest.raises(SystemExit):
            _run_main("steam-catalog")


def test_main_process_with_input_dir(tmp_path):
    input_dir = tmp_path / "input"
    input_dir.mkdir()
    with patch("scripts.pipeline.cli.process_reports") as mock:
        _run_main("process", str(input_dir), str(tmp_path))
        mock.assert_called_once_with(str(input_dir), str(tmp_path))


def test_main_process_with_url(tmp_path):
    with (
        patch("scripts.pipeline.cli.clone_repo") as mock_clone,
        patch("scripts.pipeline.cli.process_reports"),
    ):
        _run_main("process", "--url", "https://github.com/foo/bar", str(tmp_path))
        mock_clone.assert_called_once()


def test_main_process_no_input_exits(tmp_path):
    with pytest.raises(SystemExit):
        _run_main("process", str(tmp_path))


def test_main_seed_official_metadata_with_input(tmp_path):
    input_dir = tmp_path / "input"
    input_dir.mkdir()
    with patch("scripts.pipeline.cli.seed_official_dump_metadata") as mock:
        _run_main("seed-official-metadata", str(input_dir), str(tmp_path))
        mock.assert_called_once_with(str(input_dir), str(tmp_path))


def test_main_run_with_input_dir(tmp_path):
    input_dir = tmp_path / "input"
    input_dir.mkdir()
    with (
        patch("scripts.pipeline.cli.process_reports"),
        patch("scripts.pipeline.cli.run_backfill"),
        patch("scripts.pipeline.cli.finalize_output"),
        patch("scripts.pipeline.cli.run_probe_backfill"),
    ):
        _run_main("run", str(input_dir), str(tmp_path))


def test_main_no_command_exits():
    with pytest.raises((SystemExit, AttributeError)):
        with patch.object(sys, "argv", ["cli"]):
            main()


def test_main_debug_flag(tmp_path):
    with (
        patch("scripts.pipeline.cli.set_debug") as mock_debug,
        patch("scripts.pipeline.cli.finalize_output"),
    ):
        _run_main("--debug", "finalize", str(tmp_path))
        mock_debug.assert_called_once_with(True)


def test_main_unknown_command_prints_help_and_exits():
    """Unknown command hits the fallthrough parser.print_help() + sys.exit(1) path."""
    from unittest.mock import patch, MagicMock
    fake_args = MagicMock()
    fake_args.command = "totally-unknown-command"
    fake_args.debug = False
    with (
        patch("scripts.pipeline.cli.build_parser") as mock_parser,
        patch("scripts.pipeline.cli.set_debug"),
    ):
        p = MagicMock()
        p.parse_args.return_value = fake_args
        mock_parser.return_value = p
        with pytest.raises(SystemExit):
            main()
