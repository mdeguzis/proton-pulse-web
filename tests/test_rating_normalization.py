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
