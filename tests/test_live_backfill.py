import json

import scripts.pipeline.backfill as backfill_module
from scripts.pipeline.backfill import (
    backfill_missing_apps,
    compute_live_report_hash,
    load_backfill_app_ids,
    run_backfill,
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


def test_backfill_missing_apps_writes_year_files_for_manifest_app(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    expected_hash = compute_live_report_hash(2561580, counts_payload["reports"], counts_payload["timestamp"], "all")
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

    written_keys = backfill_missing_apps(data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest)

    assert fetched_urls == [
        "https://www.protondb.com/data/counts.json",
        expected_url,
    ]
    assert written_keys == {("2561580", "2025")}
    reports = json.loads((data_dir / "2561580" / "2025.json").read_text())
    assert reports[0]["protonVersion"] == "10.0-3"
    assert reports[0]["rating"] == "platinum"
    assert reports[0]["notes"] == "Runs great."


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

    written_keys = backfill_missing_apps(data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest)

    assert written_keys == set()
    assert fetched_urls == []


def test_backfilled_keys_flow_into_app_index_and_main_index(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    manifest = tmp_path / "live_backfill_app_ids.json"
    manifest.write_text(json.dumps(["2561580"]))

    counts_payload = {"reports": 415099, "timestamp": 1775051127}
    expected_hash = compute_live_report_hash(2561580, counts_payload["reports"], counts_payload["timestamp"], "all")
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

    written_keys = backfill_missing_apps(data_dir, fetch_json_impl=fake_fetch, manifest_path=manifest)
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
    expected_hash = compute_live_report_hash(2561580, counts_payload["reports"], counts_payload["timestamp"], "all")
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
        lambda data_output_path, fetch_json_impl=backfill_module.fetch_json, manifest_path=backfill_module.BACKFILL_MANIFEST_PATH: backfill_missing_apps(
            data_output_path,
            fetch_json_impl=fake_fetch,
            manifest_path=manifest,
        ),
    )

    run_backfill(tmp_path)
    finalize_output(tmp_path)

    assert json.loads((data_dir / "2561580" / "index.json").read_text()) == ["2025"]
    html = (tmp_path / "index.html").read_text()
    assert "<summary>730/</summary>" in html
    assert "<summary>2561580/</summary>" in html
    assert 'href="data/2561580/2025.json"' in html
    assert 'href="data/2561580/latest.json"' in html
