from email.message import Message
import json

import pytest

import scripts.pipeline.backfill as backfill_module
import scripts.pipeline.catalog as catalog_module
import scripts.pipeline.finalize as finalize_module
from scripts.pipeline.backfill import (
    backfill_missing_apps,
    build_live_report_candidate_urls,
    compute_live_report_hash,
    compute_live_report_hash_legacy,
    load_backfill_app_ids,
    load_backfill_targets,
    resolve_backfill_title,
    run_backfill,
    run_coverage_backfill,
)
from scripts.pipeline.finalize import (
    finalize_output,
    generate_app_indexes,
    generate_index_html,
)
from scripts.pipeline.metadata import read_app_metadata, update_app_metadata
from scripts.pipeline.process import seed_official_dump_metadata
from scripts.pipeline.state import write_pipeline_state


def build_http_error(
    url: str,
    code: int,
    message: str,
    headers: dict[str, str] | None = None,
) -> backfill_module.error.HTTPError:
    header_message = Message()
    for key, value in (headers or {}).items():
        header_message[key] = value
    return backfill_module.error.HTTPError(url, code, message, header_message, None)


def test_load_backfill_app_ids_returns_sorted_unique_ids(tmp_path):
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps([2561580, "730", "2561580"]))

    assert load_backfill_app_ids(manifest) == ["730", "2561580"]


def test_load_backfill_targets_supports_manifest_overrides(tmp_path):
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps([
        {"appId": 2561580, "reportUrl": "https://example.com/primary.json"},
        {"appId": "2561580", "reportUrls": ["https://example.com/secondary.json"]},
        "730",
    ]))

    targets = load_backfill_targets(manifest)

    assert [target.app_id for target in targets] == ["730", "2561580"]
    assert targets[1].report_urls == (
        "https://example.com/primary.json",
        "https://example.com/secondary.json",
    )


def test_compute_live_report_hash_matches_current_protondb_bundle():
    assert compute_live_report_hash(2561580, 415099, 1775051127, "any") == 2043109714


def test_build_live_report_candidate_urls_prefers_overrides_and_includes_fallbacks():
    urls = build_live_report_candidate_urls(
        "2561580",
        415099,
        1775051127,
        explicit_urls=("https://example.com/override.json",),
    )

    assert urls == [
        "https://example.com/override.json",
        f"https://www.protondb.com/data/reports/all-devices/app/{compute_live_report_hash(2561580, 415099, 1775051127, 'any')}.json",
        f"https://www.protondb.com/data/reports/all-devices/app/{compute_live_report_hash_legacy(2561580, 415099, 1775051127, 'all')}.json",
    ]


def test_backfill_missing_apps_writes_year_files_for_manifest_app(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    expected_hash = compute_live_report_hash(2561580, counts_payload["reports"], counts_payload["timestamp"], "any")
    expected_url = f"https://www.protondb.com/data/reports/all-devices/app/{expected_hash}.json"

    live_payload = {
        "reports": [
            {
                "timestamp": 1763251200,
                "responses": {
                    "verdict": "yes",
                    "triedOob": "yes",
                    "protonVersion": "10.0-3",
                    "notes": {"concludingNotes": "Runs great."},
                },
                "device": {
                    "inferred": {
                        "steam": {
                            "gpu": "AMD Radeon RX 9070 XT",
                            "gpuDriver": "Mesa 25.2.6",
                            "os": "NixOS 25.11",
                            "kernel": "6.17.7",
                            "ram": "64 GB",
                            "cpu": "Ryzen",
                        }
                    }
                },
                "contributor": {"steam": {"playtimeLinux": 1200}},
            }
        ]
    }

    fetched_urls = []

    def fake_fetch(url: str):
        fetched_urls.append(url)
        if url == "https://www.protondb.com/data/counts.json":
            return counts_payload
        if url == expected_url:
            return live_payload
        raise AssertionError(f"Unexpected URL fetched: {url}")

    written_keys, no_data_ids = backfill_missing_apps(
        data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest
    )

    assert fetched_urls == [
        "https://www.protondb.com/data/counts.json",
        expected_url,
    ]
    assert written_keys == {("2561580", "2025")}
    assert no_data_ids == set()
    reports = json.loads((data_dir / "2561580" / "2025.json").read_text())
    assert reports[0]["protonVersion"] == "10.0-3"
    assert reports[0]["rating"] == "platinum"
    assert reports[0]["notes"] == "Runs great."


def test_resolve_backfill_title_prefers_provided_catalog_title():
    title, source = resolve_backfill_title("2561580", preferred_title="Example Title")
    assert title == "Example Title"
    assert source == "provided-catalog"


def test_backfill_missing_apps_logs_unresolved_title_source(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    expected_hash = compute_live_report_hash(2561580, counts_payload["reports"], counts_payload["timestamp"], "any")
    expected_url = f"https://www.protondb.com/data/reports/all-devices/app/{expected_hash}.json"
    live_payload = {
        "reports": [
            {
                "timestamp": 1763251200,
                "responses": {"verdict": "yes", "protonVersion": "10.0-3"},
                "device": {"inferred": {"steam": {}}},
                "contributor": {"steam": {"playtimeLinux": 1200}},
            }
        ]
    }

    logs = []

    def fake_fetch(url: str):
        if url == "https://www.protondb.com/data/counts.json":
            return counts_payload
        if url == expected_url:
            return live_payload
        raise AssertionError(f"Unexpected URL fetched: {url}")

    monkeypatch.setattr(backfill_module, "fetch_steam_title_with_source", lambda app_id: ("", "steam-store-unsuccessful"))
    monkeypatch.setattr(backfill_module, "log", lambda msg, debug=False: logs.append(msg))

    written_keys, no_data_ids = backfill_missing_apps(
        data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest
    )

    assert written_keys == {("2561580", "2025")}
    assert no_data_ids == set()
    assert read_app_metadata(data_dir, "2561580") == {
        "official_dump": False,
        "protondb_live": True,
    }
    assert any(msg == "[backfill] Title unresolved for 2561580: source=steam-store-unsuccessful" for msg in logs)


def test_find_no_protondb_data_app_ids_falls_back_to_protondb_presence_catalogs(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    write_pipeline_state(tmp_path, 0, index_keys=set(), backfilled_keys=set(), no_data_app_ids=set())

    monkeypatch.setattr(
        backfill_module,
        "load_protondb_signal_catalog",
        lambda: {"2358720": "Black Myth: Wukong", "730": "Counter-Strike 2"},
    )
    monkeypatch.setattr(
        backfill_module,
        "read_protondb_probe_cache",
        lambda: {"3065920": {"title": "Black Myth: Heaven", "tracked": True}},
    )

    app_dir = data_dir / "730"
    app_dir.mkdir()

    app_ids = backfill_module._find_no_protondb_data_app_ids(data_dir)

    assert app_ids == ["2358720", "3065920"]


def test_backfill_probe_discoveries_logs_summary_with_reason_buckets(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    logs = []
    counts_payload = {"reports": 415099, "timestamp": 1775051127}

    def fake_fetch(url: str):
        if url == "https://www.protondb.com/data/counts.json":
            return counts_payload
        raise build_http_error(url, 404, "not found")

    monkeypatch.setattr(backfill_module, "log", lambda msg, debug=False: logs.append(msg))

    written_keys = backfill_module.backfill_probe_discoveries(
        data_dir,
        {"2561580": "Example Title"},
        fetch_json_impl=fake_fetch,
    )

    assert written_keys == set()
    assert any(
        msg == "[probe-backfill] Summary: attempted 1 app(s), succeeded 0, missed 1; year buckets written 0; miss reasons: 1 no live detailed payload"
        for msg in logs
    )
def test_backfill_missing_apps_falls_back_to_legacy_candidate_url(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    current_url = (
        "https://www.protondb.com/data/reports/all-devices/app/"
        f"{compute_live_report_hash(2561580, counts_payload['reports'], counts_payload['timestamp'], 'any')}.json"
    )
    legacy_url = (
        "https://www.protondb.com/data/reports/all-devices/app/"
        f"{compute_live_report_hash_legacy(2561580, counts_payload['reports'], counts_payload['timestamp'], 'all')}.json"
    )
    live_payload = {
        "reports": [
            {
                "timestamp": 1763251200,
                "responses": {"verdict": "yes", "triedOob": "yes", "protonVersion": "10.0-3"},
                "device": {"inferred": {"steam": {}}},
                "contributor": {"steam": {"playtimeLinux": 1200}},
            }
        ]
    }

    fetched_urls = []

    def fake_fetch(url: str):
        fetched_urls.append(url)
        if url == "https://www.protondb.com/data/counts.json":
            return counts_payload
        if url == current_url:
            raise build_http_error(url, 404, "not found")
        if url == legacy_url:
            return live_payload
        raise AssertionError(f"Unexpected URL fetched: {url}")

    written_keys, no_data_ids = backfill_missing_apps(
        data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest
    )

    assert written_keys == {("2561580", "2025")}
    assert no_data_ids == set()
    assert fetched_urls == [
        "https://www.protondb.com/data/counts.json",
        current_url,
        legacy_url,
    ]


def test_backfill_missing_apps_uses_manifest_report_url_override_first(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    override_url = "https://example.com/protondb-override.json"
    manifest.write_text(json.dumps([
        {"appId": "2561580", "reportUrl": override_url},
    ]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    live_payload = {
        "reports": [
            {
                "timestamp": 1763251200,
                "responses": {"verdict": "yes", "triedOob": "yes", "protonVersion": "10.0-3"},
                "device": {"inferred": {"steam": {}}},
                "contributor": {"steam": {"playtimeLinux": 1200}},
            }
        ]
    }

    fetched_urls = []

    def fake_fetch(url: str):
        fetched_urls.append(url)
        if url == "https://www.protondb.com/data/counts.json":
            return counts_payload
        if url == override_url:
            return live_payload
        raise AssertionError(f"Unexpected URL fetched: {url}")

    written_keys, no_data_ids = backfill_missing_apps(
        data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest
    )

    assert written_keys == {("2561580", "2025")}
    assert no_data_ids == set()
    assert fetched_urls == [
        "https://www.protondb.com/data/counts.json",
        override_url,
    ]


def test_backfill_missing_apps_skips_existing_app_directory(tmp_path):
    data_dir = tmp_path / "data"
    existing_app_dir = data_dir / "2561580"
    existing_app_dir.mkdir(parents=True)
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    fetched_urls = []

    def fake_fetch(url: str):
        fetched_urls.append(url)
        return {}

    written_keys, no_data_ids = backfill_missing_apps(
        data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest
    )

    assert written_keys == set()
    assert no_data_ids == set()
    assert fetched_urls == []


def test_backfill_missing_apps_logs_summary_with_reason_buckets(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    logs = []

    def fake_fetch(url: str):
        if url == "https://www.protondb.com/data/counts.json":
            return counts_payload
        raise build_http_error(url, 404, "not found")

    monkeypatch.setattr(backfill_module, "log", lambda msg, debug=False: logs.append(msg))

    written_keys, no_data_ids = backfill_missing_apps(
        data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest
    )

    assert written_keys == set()
    assert no_data_ids == {"2561580"}
    assert any(
        msg == "[backfill] Summary: attempted 1 app(s), succeeded 0, missed 1; year buckets written 0; miss reasons: 1 no live detailed payload"
        for msg in logs
    )


def test_backfilled_keys_flow_into_app_index_and_main_index(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    expected_hash = compute_live_report_hash(2561580, counts_payload["reports"], counts_payload["timestamp"], "any")
    expected_url = f"https://www.protondb.com/data/reports/all-devices/app/{expected_hash}.json"

    live_payload = {
        "reports": [
            {
                "timestamp": 1763251200,
                "responses": {"verdict": "yes", "triedOob": "yes", "protonVersion": "10.0-3"},
                "device": {"inferred": {"steam": {}}},
                "contributor": {"steam": {"playtimeLinux": 1200}},
            }
        ]
    }

    def fake_fetch(url: str):
        if url == "https://www.protondb.com/data/counts.json":
            return counts_payload
        if url == expected_url:
            return live_payload
        raise AssertionError(f"Unexpected URL fetched: {url}")

    written_keys, _no_data_ids = backfill_missing_apps(
        data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest
    )
    generate_app_indexes(written_keys, data_dir)
    generate_index_html(written_keys, tmp_path)

    assert json.loads((data_dir / "2561580" / "index.json").read_text()) == ["2025"]
    html = (tmp_path / "index.html").read_text()
    assert "<summary>2561580/</summary>" in html
    assert 'href="data/2561580/2025.json"' in html


def test_run_backfill_and_finalize_include_backfilled_apps_in_indexes(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    write_pipeline_state(tmp_path, parsed_count=1, index_keys={("730", "2024")})
    (data_dir / "730").mkdir()
    (data_dir / "730" / "2024.json").write_text(json.dumps([{"appId": "730", "timestamp": 1704067200}]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    expected_hash = compute_live_report_hash(2561580, counts_payload["reports"], counts_payload["timestamp"], "any")
    expected_url = f"https://www.protondb.com/data/reports/all-devices/app/{expected_hash}.json"

    live_payload = {
        "reports": [
            {
                "timestamp": 1763251200,
                "responses": {"verdict": "yes", "triedOob": "yes", "protonVersion": "10.0-3"},
                "device": {"inferred": {"steam": {}}},
                "contributor": {"steam": {"playtimeLinux": 1200}},
            }
        ]
    }

    def fake_fetch(url: str):
        if url == "https://www.protondb.com/data/counts.json":
            return counts_payload
        if url == expected_url:
            return live_payload
        raise AssertionError(f"Unexpected URL fetched: {url}")

    monkeypatch.setattr(backfill_module, "BACKFILL_MANIFEST_PATH", manifest)
    monkeypatch.setattr(
        backfill_module,
        "backfill_missing_apps",
        lambda data_output_path, fetch_json_impl=backfill_module.fetch_json, manifest_path=backfill_module.BACKFILL_MANIFEST_PATH, target_app_ids=None, force=False: backfill_missing_apps(
            data_output_path,
            fetch_json_impl=fake_fetch,
            manifest_path=manifest,
        ),
    )
    monkeypatch.setattr(finalize_module, "fetch_json", lambda url: counts_payload)
    monkeypatch.setattr(finalize_module, "load_protondb_signal_catalog", lambda **kw: {})
    monkeypatch.setattr(finalize_module, "get_steam_api_key", lambda env: None)

    run_backfill(tmp_path)
    finalize_output(tmp_path)

    assert json.loads((data_dir / "2561580" / "index.json").read_text()) == ["2025"]
    html = (tmp_path / "index.html").read_text()
    assert "<summary>730/</summary>" in html
    assert "<summary>2561580/</summary>" in html
    assert 'href="data/2561580/2025.json"' in html
    assert 'href="data/2561580/latest.json"' in html
    assert read_app_metadata(data_dir, "2561580")["protondb_live"] is True


def test_update_app_metadata_preserves_multiple_provenance_flags(tmp_path):
    data_dir = tmp_path / "data"
    update_app_metadata(data_dir, "730", official_dump=True)
    update_app_metadata(data_dir, "730", protondb_live=True)

    assert read_app_metadata(data_dir, "730") == {
        "official_dump": True,
        "protondb_live": True,
    }


def test_seed_official_dump_metadata_repairs_existing_live_metadata(tmp_path):
    reports_dir = tmp_path / "reports"
    reports_dir.mkdir()
    (reports_dir / "sample.json").write_text(
        json.dumps([
            {"appId": "730", "timestamp": 1704067200},
            {"appId": "570", "timestamp": 1704067201},
        ])
    )

    data_dir = tmp_path / "out" / "data"
    data_dir.mkdir(parents=True)
    update_app_metadata(data_dir, "730", protondb_live=True)

    seed_official_dump_metadata(reports_dir, tmp_path / "out")

    assert read_app_metadata(data_dir, "730") == {
        "official_dump": True,
        "protondb_live": True,
    }
    assert read_app_metadata(data_dir, "570") == {
        "official_dump": True,
        "protondb_live": False,
    }


def test_finalize_output_bootstraps_missing_metadata_from_existing_data(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    official_dir = data_dir / "730"
    official_dir.mkdir(parents=True)
    (official_dir / "2024.json").write_text(json.dumps([{"appId": "730", "timestamp": 1704067200, "foo": "bar"}]))
    live_dir = data_dir / "2561580"
    live_dir.mkdir(parents=True)
    (live_dir / "2025.json").write_text(json.dumps([{
        "appId": "2561580",
        "duration": "allTheTime",
        "protonVersion": "10.0-3",
        "rating": "gold",
        "timestamp": 1763251200,
        "title": "Live Game",
    }]))
    write_pipeline_state(tmp_path, parsed_count=2, index_keys={("730", "2024"), ("2561580", "2025")})

    monkeypatch.setattr(finalize_module, "fetch_json", lambda url: {"uniqueGames": 2, "reports": 2})
    monkeypatch.setattr(finalize_module, "load_protondb_signal_catalog", lambda **kw: {})
    monkeypatch.setattr(finalize_module, "get_steam_api_key", lambda env: None)

    finalize_output(tmp_path, skip_probe=True)

    assert read_app_metadata(data_dir, "730") == {
        "official_dump": True,
        "protondb_live": False,
    }
    assert read_app_metadata(data_dir, "2561580") == {
        "official_dump": False,
        "protondb_live": True,
    }


def _mock_empty_catalogs(monkeypatch):
    """Mock catalog functions to return empty so _find_no_title_app_ids only finds on-disk apps."""
    monkeypatch.setattr(catalog_module, "load_protondb_signal_catalog", lambda **kw: {})
    monkeypatch.setattr(catalog_module, "read_protondb_probe_cache", lambda **kw: {})
    monkeypatch.setattr(catalog_module, "get_steam_api_key", lambda *a, **kw: None)
    monkeypatch.setattr(backfill_module, "load_protondb_signal_catalog", lambda **kw: {})
    monkeypatch.setattr(backfill_module, "read_protondb_probe_cache", lambda **kw: {})
    monkeypatch.setattr(backfill_module, "get_steam_api_key", lambda *a, **kw: None)
    monkeypatch.setattr(backfill_module, "load_steam_game_catalog", lambda *a, **kw: {})


def test_run_coverage_backfill_no_titles_patches_existing_reports(tmp_path, monkeypatch):
    _mock_empty_catalogs(monkeypatch)
    data_dir = tmp_path / "data"
    app_dir = data_dir / "2561580"
    app_dir.mkdir(parents=True)
    (app_dir / "2024.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    (app_dir / "latest.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    write_pipeline_state(tmp_path, parsed_count=0, index_keys={("2561580", "2024")})

    monkeypatch.setattr(
        backfill_module, "fetch_steam_title_with_source",
        lambda app_id: ("Horizon Zero Dawn™ Remastered", "steam-store"),
    )

    run_coverage_backfill(str(tmp_path), issue_type="no-titles", limit=1)

    patched = json.loads((app_dir / "2024.json").read_text())
    assert patched[0]["title"] == "Horizon Zero Dawn™ Remastered"


def test_run_coverage_backfill_logs_candidate_and_selected_app_ids(tmp_path, monkeypatch):
    _mock_empty_catalogs(monkeypatch)
    data_dir = tmp_path / "data"
    for app_id in ("2561580", "730", "570"):
        app_dir = data_dir / app_id
        app_dir.mkdir(parents=True)
        (app_dir / "latest.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    write_pipeline_state(tmp_path, parsed_count=0, index_keys=set())

    logs = []

    monkeypatch.setattr(backfill_module, "log", lambda msg, debug=False: logs.append(msg))
    monkeypatch.setattr(
        backfill_module, "fetch_steam_title_with_source",
        lambda app_id: ("", "steam-store-error"),
    )

    run_coverage_backfill(str(tmp_path), issue_type="no-titles", limit=2)

    assert any(msg == "[coverage-backfill] Candidate app IDs (1-3/3): 570,730,2561580" for msg in logs)
    assert any(msg == "[coverage-backfill] Selected app IDs (1-2/2): 570,730" for msg in logs)


def test_run_coverage_backfill_allows_unbounded_by_default(tmp_path, monkeypatch):
    _mock_empty_catalogs(monkeypatch)
    data_dir = tmp_path / "data"
    app_dir = data_dir / "2561580"
    app_dir.mkdir(parents=True)
    (app_dir / "2024.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    (app_dir / "latest.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    write_pipeline_state(tmp_path, parsed_count=0, index_keys={("2561580", "2024")})

    monkeypatch.setattr(
        backfill_module, "fetch_steam_title_with_source",
        lambda app_id: ("Test Game", "steam-store"),
    )

    run_coverage_backfill(tmp_path, issue_type="no-titles", limit=0)

    reports = json.loads((app_dir / "2024.json").read_text())
    assert reports[0]["title"] == "Test Game"


def test_run_coverage_backfill_can_explicitly_allow_unbounded(tmp_path, monkeypatch):
    _mock_empty_catalogs(monkeypatch)
    data_dir = tmp_path / "data"
    app_dir = data_dir / "2561580"
    app_dir.mkdir(parents=True)
    (app_dir / "2024.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    (app_dir / "latest.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    write_pipeline_state(tmp_path, parsed_count=0, index_keys={("2561580", "2024")})

    monkeypatch.setattr(
        backfill_module, "fetch_steam_title_with_source",
        lambda app_id: ("Test Game", "steam-store"),
    )

    run_coverage_backfill(str(tmp_path), issue_type="no-titles", limit=0, allow_unbounded=True)

    patched = json.loads((app_dir / "2024.json").read_text())
    assert patched[0]["title"] == "Test Game"


def test_run_probe_backfill_includes_signal_catalog_apps_not_in_probe_cache(tmp_path, monkeypatch):
    """Signal-catalog apps excluded from the probe should still be backfilled.

    The probe deliberately skips apps already in the ProtonDB signal catalog, so
    those apps never land in the probe cache.  Without the merge in
    run_probe_backfill they would never be auto-backfilled during a normal pipeline
    run even though ProtonDB clearly has data for them.
    """
    from scripts.pipeline.backfill import run_probe_backfill

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    write_pipeline_state(tmp_path, parsed_count=0, index_keys=set(), backfilled_keys=set())

    # Probe cache is empty — simulates the situation where the app was excluded
    # from probe candidates because it was already in the signal catalog.
    monkeypatch.setattr(backfill_module, "read_protondb_probe_cache", lambda: {})

    # Signal catalog contains the app that was never probed.
    monkeypatch.setattr(
        backfill_module,
        "load_protondb_signal_catalog",
        lambda: {"976730": "Halo: The Master Chief Collection"},
    )

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    live_payload = {
        "reports": [
            {
                "timestamp": 1763251200,
                "responses": {"verdict": "yes", "triedOob": "yes", "protonVersion": "10.0-3"},
                "device": {"inferred": {"steam": {}}},
                "contributor": {"steam": {"playtimeLinux": 600}},
            }
        ]
    }

    def fake_fetch(url: str):
        if "counts" in url:
            return counts_payload
        return live_payload

    monkeypatch.setattr(backfill_module, "fetch_json", fake_fetch)
    monkeypatch.setattr(
        backfill_module,
        "resolve_backfill_title",
        lambda app_id, preferred_title="": ("Halo: The Master Chief Collection", "protondb-signal"),
    )
    monkeypatch.setattr(backfill_module, "flush_steam_title_cache", lambda: None)

    run_probe_backfill(str(tmp_path))

    assert (data_dir / "976730").is_dir(), "Expected data directory for 976730 to be created"
    year_files = [f for f in (data_dir / "976730").iterdir() if f.suffix == ".json" and f.stem not in ("index", "latest", "votes", "metadata")]
    assert year_files, "Expected at least one year file written for 976730"
