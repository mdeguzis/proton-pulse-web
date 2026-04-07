import json

import pytest

import scripts.pipeline.backfill as backfill_module
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
from scripts.pipeline.state import write_pipeline_state


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
    assert any(msg == "[backfill] Title unresolved for 2561580: source=steam-store-unsuccessful" for msg in logs)


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
            raise backfill_module.error.HTTPError(url, 404, "not found", hdrs=None, fp=None)
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


def test_run_coverage_backfill_no_titles_does_not_crash_when_targets_already_exist(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    app_dir = data_dir / "2561580"
    app_dir.mkdir(parents=True)
    (app_dir / "latest.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    write_pipeline_state(tmp_path, parsed_count=0, index_keys=set())

    calls = []

    def fake_run_backfill(output_dir, target_app_ids=None, force=False):
        calls.append((output_dir, target_app_ids, force))

    monkeypatch.setattr(backfill_module, "run_backfill", fake_run_backfill)

    run_coverage_backfill(tmp_path, issue_type="no-titles", limit=1)

    assert calls == [(tmp_path, ["2561580"], True)]


def test_run_coverage_backfill_requires_positive_limit_by_default(tmp_path):
    data_dir = tmp_path / "data"
    app_dir = data_dir / "2561580"
    app_dir.mkdir(parents=True)
    (app_dir / "latest.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    write_pipeline_state(tmp_path, parsed_count=0, index_keys=set())

    with pytest.raises(ValueError, match="Coverage backfill requires --limit > 0 by default"):
        run_coverage_backfill(tmp_path, issue_type="no-titles", limit=0)


def test_run_coverage_backfill_can_explicitly_allow_unbounded(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    app_dir = data_dir / "2561580"
    app_dir.mkdir(parents=True)
    (app_dir / "latest.json").write_text(json.dumps([{"title": "", "timestamp": 1763251200}]))
    write_pipeline_state(tmp_path, parsed_count=0, index_keys=set())

    calls = []

    def fake_run_backfill(output_dir, target_app_ids=None, force=False):
        calls.append((output_dir, target_app_ids, force))

    monkeypatch.setattr(backfill_module, "run_backfill", fake_run_backfill)

    run_coverage_backfill(tmp_path, issue_type="no-titles", limit=0, allow_unbounded=True)

    assert calls == [(tmp_path, ["2561580"], True)]
