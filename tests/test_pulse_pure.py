import json
from pathlib import Path
from unittest.mock import patch

from scripts.pipeline.pulse import (
    _year_from_created_at,
    _ts_from_created_at,
    normalize_pulse_row,
    _bucket_by_app_year,
    merge_pulse_into_data_dir,
)


# ── _year_from_created_at ─────────────────────────────────────────────────────

def test_year_from_iso_utc():
    assert _year_from_created_at("2025-10-12T14:23:00.123456+00:00") == "2025"

def test_year_from_iso_z():
    assert _year_from_created_at("2024-01-15T08:00:00Z") == "2024"

def test_year_from_empty():
    assert _year_from_created_at("") == "unknown"

def test_year_from_invalid():
    assert _year_from_created_at("not-a-date") == "unknown"

def test_year_from_none():
    assert _year_from_created_at(None) == "unknown"


# ── _ts_from_created_at ───────────────────────────────────────────────────────

def test_ts_from_valid():
    ts = _ts_from_created_at("2025-10-12T14:23:00+00:00")
    assert isinstance(ts, int)
    assert ts > 0

def test_ts_from_z_suffix():
    ts = _ts_from_created_at("2024-06-01T00:00:00Z")
    assert ts > 0

def test_ts_from_empty():
    assert _ts_from_created_at("") == 0

def test_ts_from_invalid():
    assert _ts_from_created_at("garbage") == 0

def test_ts_from_none():
    assert _ts_from_created_at(None) == 0


# ── normalize_pulse_row ───────────────────────────────────────────────────────

def _make_row(**kwargs):
    base = {
        "id": 42,
        "app_id": 730,
        "title": "Counter-Strike 2",
        "cpu": "Intel i7",
        "gpu": "RTX 3080",
        "gpu_driver": "535",
        "gpu_vendor": "nvidia",
        "ram": "16GB",
        "vram_mb": 8192,
        "os": "Arch Linux",
        "kernel": "6.5",
        "proton_version": "9.0-4",
        "rating": "gold",
        "duration": "severalHours",
        "duration_minutes": 300,
        "notes": "Works great",
        "launch_options": "-novid",
        "form_responses": {"requiresFramegen": "no"},
        "config_key": "key123",
        "game_owned": True,
        "created_at": "2025-06-01T12:00:00Z",
        "source": "user",
    }
    base.update(kwargs)
    return base

def test_normalize_maps_app_id():
    r = normalize_pulse_row(_make_row())
    assert r["appId"] == "730"

def test_normalize_maps_title():
    r = normalize_pulse_row(_make_row(title="CS2"))
    assert r["title"] == "CS2"

def test_normalize_maps_gpu():
    r = normalize_pulse_row(_make_row(gpu="RTX 3080"))
    assert r["gpu"] == "RTX 3080"

def test_normalize_maps_vram_mb():
    r = normalize_pulse_row(_make_row(vram_mb=8192))
    assert r["vramMb"] == 8192

def test_normalize_sets_source_pulse():
    r = normalize_pulse_row(_make_row())
    assert r["source"] == "pulse"

def test_normalize_preserves_submission_source():
    r = normalize_pulse_row(_make_row(source="web-linux"))
    assert r["submissionSource"] == "web-linux"

def test_normalize_sets_pulse_id():
    r = normalize_pulse_row(_make_row(id=99))
    assert r["pulseId"] == 99

def test_normalize_maps_timestamp():
    r = normalize_pulse_row(_make_row(created_at="2025-06-01T12:00:00Z"))
    assert r["timestamp"] > 0

def test_normalize_empty_fields_default_empty_string():
    row = _make_row(cpu=None, notes=None)
    r = normalize_pulse_row(row)
    assert r["cpu"] == ""
    assert r["notes"] == ""

def test_normalize_form_responses_preserved():
    r = normalize_pulse_row(_make_row(form_responses={"requiresFramegen": "yes"}))
    assert r["formResponses"]["requiresFramegen"] == "yes"

def test_normalize_app_type_steam_default():
    r = normalize_pulse_row(_make_row())
    assert r["appType"] == "steam"

def test_normalize_app_type_gog():
    r = normalize_pulse_row(_make_row(app_type="gog"))
    assert r["appType"] == "gog"

def test_normalize_app_type_epic():
    r = normalize_pulse_row(_make_row(app_type="epic"))
    assert r["appType"] == "epic"


# ── _bucket_by_app_year ───────────────────────────────────────────────────────

def test_bucket_by_app_year_basic():
    rows = [
        {"app_id": 730, "created_at": "2025-01-01T00:00:00Z"},
        {"app_id": 730, "created_at": "2024-01-01T00:00:00Z"},
        {"app_id": 570, "created_at": "2025-06-01T00:00:00Z"},
    ]
    buckets = _bucket_by_app_year(rows)
    assert ("730", "2025") in buckets
    assert ("730", "2024") in buckets
    assert ("570", "2025") in buckets

def test_bucket_skips_non_numeric_app_ids():
    rows = [{"app_id": "not-an-id", "created_at": "2025-01-01T00:00:00Z"}]
    buckets = _bucket_by_app_year(rows)
    assert len(buckets) == 0

def test_bucket_includes_gog_app_ids():
    rows = [{"app_id": "gog:1234567890", "created_at": "2025-01-01T00:00:00Z"}]
    buckets = _bucket_by_app_year(rows)
    assert ("gog:1234567890", "2025") in buckets

def test_bucket_includes_epic_app_ids():
    rows = [{"app_id": "epic:somegame", "created_at": "2025-01-01T00:00:00Z"}]
    buckets = _bucket_by_app_year(rows)
    assert ("epic:somegame", "2025") in buckets

def test_bucket_by_app_year_unknown_date():
    rows = [{"app_id": 730, "created_at": "bad-date"}]
    buckets = _bucket_by_app_year(rows)
    assert ("730", "unknown") in buckets


# ── merge_pulse_into_data_dir ─────────────────────────────────────────────────

def _make_pulse_rows():
    return [
        {
            "id": 1,
            "app_id": 730,
            "title": "CS2",
            "cpu": "Intel i7",
            "gpu": "RTX 3080",
            "gpu_driver": "",
            "gpu_vendor": "nvidia",
            "ram": "16GB",
            "vram_mb": 8192,
            "os": "Arch",
            "kernel": "6.5",
            "proton_version": "9.0-4",
            "rating": "gold",
            "duration": "severalHours",
            "duration_minutes": 300,
            "notes": "",
            "launch_options": "",
            "form_responses": None,
            "config_key": None,
            "game_owned": True,
            "created_at": "2025-06-01T12:00:00Z",
            "source": "user",
        }
    ]

def test_merge_creates_year_file(tmp_path):
    with patch("scripts.pipeline.pulse.fetch_pulse_rows", return_value=_make_pulse_rows()):
        apps, reports = merge_pulse_into_data_dir(tmp_path)
    assert apps == 1
    assert reports == 1
    assert (tmp_path / "730" / "2025.json").exists()

def test_merge_empty_returns_zero(tmp_path):
    with patch("scripts.pipeline.pulse.fetch_pulse_rows", return_value=[]):
        apps, reports = merge_pulse_into_data_dir(tmp_path)
    assert apps == 0
    assert reports == 0

def test_merge_deduplicates_pulse_id(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    year_file = app_dir / "2025.json"
    existing = [{"source": "pulse", "pulseId": 1, "rating": "bronze"}]
    year_file.write_text(json.dumps(existing))

    with patch("scripts.pipeline.pulse.fetch_pulse_rows", return_value=_make_pulse_rows()):
        merge_pulse_into_data_dir(tmp_path)

    written = json.loads(year_file.read_text())
    pulse_records = [r for r in written if r.get("pulseId") == 1]
    assert len(pulse_records) == 1

def test_merge_backfills_protondb_source(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    year_file = app_dir / "2025.json"
    existing = [{"rating": "gold", "timestamp": 1000000}]  # no source field
    year_file.write_text(json.dumps(existing))

    with patch("scripts.pipeline.pulse.fetch_pulse_rows", return_value=_make_pulse_rows()):
        merge_pulse_into_data_dir(tmp_path)

    written = json.loads(year_file.read_text())
    protondb_records = [r for r in written if r.get("timestamp") == 1000000]
    assert protondb_records[0]["source"] == "protondb"

def test_merge_handles_corrupt_year_file(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2025.json").write_text("not valid json {{{")

    with patch("scripts.pipeline.pulse.fetch_pulse_rows", return_value=_make_pulse_rows()):
        apps, reports = merge_pulse_into_data_dir(tmp_path)
    assert reports == 1

def test_merge_gog_creates_underscore_dir(tmp_path):
    rows = [{
        "id": 10,
        "app_id": "gog:1234567890",
        "title": "Witcher 3",
        "cpu": "i7", "gpu": "RX 580", "gpu_driver": "", "gpu_vendor": "amd",
        "ram": "16GB", "vram_mb": None, "os": "Arch Linux", "kernel": "6.1",
        "proton_version": "GE-Proton9-1", "rating": "gold", "duration": "severalHours",
        "duration_minutes": None, "notes": "", "launch_options": "", "form_responses": None,
        "config_key": None, "game_owned": True, "created_at": "2025-06-01T12:00:00Z",
        "source": "user", "app_type": "gog",
    }]
    with patch("scripts.pipeline.pulse.fetch_pulse_rows", return_value=rows):
        apps, reports = merge_pulse_into_data_dir(tmp_path)
    assert apps == 1
    assert reports == 1
    assert (tmp_path / "gog_1234567890" / "2025.json").exists()
    assert not (tmp_path / "gog:1234567890").exists()
