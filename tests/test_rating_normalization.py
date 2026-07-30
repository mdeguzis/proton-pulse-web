"""#427: rating case normalization at ingest.

ProtonDB archives emit Capitalized ratings ("Borked", "Gold", "Platinum")
while Supabase submissions are lowercase. Every downstream consumer keyed
against lowercase tier tables and silently defaulted to a neutral 0.5
fallback for Capitalized values, so any game with mostly CDN reports
rendered silver on the game page. Client-side lookups were fixed in the
same PR; this suite guards the ingest side so the year files on disk
carry one canonical case regardless of source.
"""

import io
import json
from pathlib import Path

import pytest

from scripts.pipeline.common import normalize_rating
from scripts.pipeline.finalize import backfill_lowercase_ratings
from scripts.pipeline.process import parse_and_split
from scripts.pipeline.pulse import normalize_pulse_row
import scripts.pipeline.process as _proc_module

# ijson is mocked via conftest.py; feed synthetic reports through the same
# hook the existing tests use (see test_process_parse.py).
_ijson_mock = _proc_module.ijson


def _set_reports(reports):
    _ijson_mock.items.return_value = iter(reports)


# ── normalize_rating (shared helper) ─────────────────────────────────────────

def test_normalize_rating_lowercases():
    assert normalize_rating("Borked") == "borked"
    assert normalize_rating("PLATINUM") == "platinum"
    assert normalize_rating("gold") == "gold"


def test_normalize_rating_strips_whitespace():
    assert normalize_rating("  Silver  ") == "silver"
    assert normalize_rating("\tBorked\n") == "borked"


def test_normalize_rating_returns_empty_for_non_strings():
    assert normalize_rating(None) == ""
    assert normalize_rating(0) == ""
    assert normalize_rating(False) == ""
    assert normalize_rating([]) == ""


def test_normalize_rating_returns_empty_for_falsy_string():
    # Blank strings still return '' (falsy) so callers can gate on truthiness.
    assert normalize_rating("") == ""
    assert normalize_rating("   ") == ""


# ── process.parse_and_split writes lowercase ratings ─────────────────────────

def test_process_parse_lowercases_new_reports(tmp_path: Path):
    """A fresh year file gets lowercase ratings even if the archive was Capitalized."""
    _set_reports([
        {"appId": "730", "timestamp": 1_700_000_000, "rating": "Borked"},
        {"appId": "730", "timestamp": 1_700_000_100, "rating": "GOLD"},
        {"appId": "730", "timestamp": 1_700_000_200, "rating": "  Platinum  "},
    ])

    count, _ = parse_and_split(io.BytesIO(b""), tmp_path, source_label="test")

    assert count == 3
    year_file = tmp_path / "730" / "2023.json"
    assert year_file.exists()
    written = json.loads(year_file.read_text())
    assert [r["rating"] for r in written] == ["borked", "gold", "platinum"]


def test_process_parse_heals_existing_capitalized(tmp_path: Path):
    """Merging into an existing year file lowercases legacy Capitalized rows too."""
    (tmp_path / "730").mkdir()
    # Pre-existing (legacy) year file with capitalized ratings.
    legacy = [
        {"appId": "730", "timestamp": 1_600_000_000, "rating": "Borked", "source": "protondb"},
    ]
    (tmp_path / "730" / "2020.json").write_text(json.dumps(legacy))

    # Fresh archive covering the same year for the same app forces the merge
    # branch to iterate + rewrite existing when a new report arrives.
    _set_reports([{"appId": "730", "timestamp": 1_600_100_000, "rating": "gold"}])
    parse_and_split(io.BytesIO(b""), tmp_path, source_label="test")

    written = json.loads((tmp_path / "730" / "2020.json").read_text())
    # Legacy Borked lowercased in place, new gold appended lowercase.
    assert sorted(r["rating"] for r in written) == ["borked", "gold"]


# ── pulse.normalize_pulse_row lowercases too ─────────────────────────────────

def test_pulse_normalize_row_lowercases_rating():
    row = {
        "id": 1,
        "app_id": 730,
        "title": "CS2",
        "rating": "Borked",  # would only happen via a partner import / bug,
        # since Supabase submissions are lowercase -- but the helper still
        # defends against it.
        "created_at": "2025-01-01T00:00:00Z",
    }
    out = normalize_pulse_row(row)
    assert out["rating"] == "borked"


def test_pulse_normalize_row_handles_lowercase_input():
    row = {
        "id": 2, "app_id": 730, "title": "CS2",
        "rating": "gold", "created_at": "2025-01-01T00:00:00Z",
    }
    assert normalize_pulse_row(row)["rating"] == "gold"


def test_pulse_normalize_row_handles_missing_rating():
    row = {
        "id": 3, "app_id": 730, "title": "CS2",
        "created_at": "2025-01-01T00:00:00Z",
    }
    assert normalize_pulse_row(row)["rating"] == ""


# ── backfill_lowercase_ratings (finalize.py one-shot heal) ───────────────────

def _seed_year(tmp_path: Path, app_id: str, year: str, reports):
    app_dir = tmp_path / app_id
    app_dir.mkdir(exist_ok=True)
    (app_dir / f"{year}.json").write_text(json.dumps(reports))


def test_backfill_lowercases_capitalized_year_files(tmp_path: Path):
    _seed_year(tmp_path, "203140", "2019", [
        {"appId": "203140", "timestamp": 1_565_411_282, "rating": "Borked"},
        {"appId": "203140", "timestamp": 1_565_423_531, "rating": "Gold"},
    ])
    scanned, rewritten, lowercased = backfill_lowercase_ratings(tmp_path)
    assert scanned == 1
    assert rewritten == 1
    assert lowercased == 2
    written = json.loads((tmp_path / "203140" / "2019.json").read_text())
    assert [r["rating"] for r in written] == ["borked", "gold"]


def test_backfill_skips_already_lowercase_files(tmp_path: Path):
    # A file whose ratings are already lowercase must NOT be rewritten --
    # rewriting would churn R2 content hashes on the next delta sync for
    # ~44k already-normalized files. Idempotent second pass.
    _seed_year(tmp_path, "730", "2024", [
        {"appId": "730", "timestamp": 1_704_067_200, "rating": "gold"},
        {"appId": "730", "timestamp": 1_704_067_300, "rating": "platinum"},
    ])
    mtime_before = (tmp_path / "730" / "2024.json").stat().st_mtime
    scanned, rewritten, lowercased = backfill_lowercase_ratings(tmp_path)
    assert scanned == 1
    assert rewritten == 0
    assert lowercased == 0
    # File not touched -> mtime unchanged.
    assert (tmp_path / "730" / "2024.json").stat().st_mtime == mtime_before


def test_backfill_ignores_special_files(tmp_path: Path):
    # latest.json / index.json / votes.json / metadata.json aren't year buckets;
    # generate_latest_files owns latest.json from the winning year file after
    # this pass. Backfill must skip them or it'd double-scan latest.json.
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text(json.dumps([{"rating": "Borked"}]))
    (app_dir / "index.json").write_text(json.dumps({}))
    (app_dir / "votes.json").write_text(json.dumps([]))
    (app_dir / "metadata.json").write_text(json.dumps({}))
    (app_dir / "2024.json").write_text(json.dumps([{"rating": "gold"}]))
    scanned, rewritten, lowercased = backfill_lowercase_ratings(tmp_path)
    assert scanned == 1  # only 2024.json
    assert rewritten == 0
    assert lowercased == 0
    # latest.json left alone with its Capitalized rating (generate_latest_files
    # will overwrite it on the next step from the normalized year file).
    assert json.loads((app_dir / "latest.json").read_text())[0]["rating"] == "Borked"


def test_backfill_handles_mixed_case_within_one_file(tmp_path: Path):
    _seed_year(tmp_path, "440", "2023", [
        {"appId": "440", "timestamp": 1, "rating": "Borked"},
        {"appId": "440", "timestamp": 2, "rating": "gold"},        # already ok
        {"appId": "440", "timestamp": 3, "rating": "PLATINUM"},
        {"appId": "440", "timestamp": 4, "rating": "  Silver  "},  # whitespace
    ])
    scanned, rewritten, lowercased = backfill_lowercase_ratings(tmp_path)
    assert scanned == 1
    assert rewritten == 1
    assert lowercased == 3  # 3 changed (Borked, PLATINUM, "  Silver  "); gold unchanged
    written = json.loads((tmp_path / "440" / "2023.json").read_text())
    assert [r["rating"] for r in written] == ["borked", "gold", "platinum", "silver"]


def test_backfill_survives_malformed_files(tmp_path: Path):
    good_dir = tmp_path / "730"
    good_dir.mkdir()
    (good_dir / "2024.json").write_text(json.dumps([{"rating": "Borked"}]))
    bad_dir = tmp_path / "999"
    bad_dir.mkdir()
    (bad_dir / "2024.json").write_text("{ not json")
    scanned, rewritten, lowercased = backfill_lowercase_ratings(tmp_path)
    # Both files were counted as "scanned attempts", one succeeded, one skipped.
    assert scanned == 2
    assert rewritten == 1
    assert lowercased == 1
    # Good file was heal'd; bad file left as-is.
    assert json.loads((good_dir / "2024.json").read_text())[0]["rating"] == "borked"
    assert (bad_dir / "2024.json").read_text() == "{ not json"
