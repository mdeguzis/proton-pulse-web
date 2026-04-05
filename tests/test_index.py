from pathlib import Path
import json

from scripts.pipeline.finalize import generate_coverage_report, generate_index_html, generate_app_indexes
from scripts.pipeline.catalog import (
    build_steam_app_list_url,
    fetch_steam_game_catalog,
    fetch_protondb_signal_catalog,
    get_steam_api_key,
    load_dotenv,
    load_protondb_signal_catalog,
    load_vendor_scraper_module,
    load_steam_game_catalog,
    read_cached_protondb_signal_catalog,
    read_cached_steam_game_catalog,
    write_cached_protondb_signal_catalog,
    write_cached_steam_game_catalog,
)


def test_index_html_created(tmp_path):
    keys = {("730", "2020"), ("730", "2019")}
    generate_index_html(keys, tmp_path)
    assert (tmp_path / "index.html").exists()


def test_appids_sorted_numerically(tmp_path):
    # "4000" must come after "730" numerically, not before it lexicographically
    # Search within the <summary> tags to avoid hits in the popular-titles section
    keys = {("4000", "2021"), ("570", "2022"), ("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    pos_570 = html.index("<summary>570/</summary>")
    pos_730 = html.index("<summary>730/</summary>")
    pos_4000 = html.index("<summary>4000/</summary>")
    assert pos_570 < pos_730 < pos_4000


def test_years_sorted_ascending(tmp_path):
    keys = {("730", "2022"), ("730", "2019"), ("730", "2021")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    pos_2019 = html.index("2019.json")
    pos_2021 = html.index("2021.json")
    pos_2022 = html.index("2022.json")
    assert pos_2019 < pos_2021 < pos_2022


def test_year_links_correct_href(tmp_path):
    keys = {("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert 'href="data/730/2020.json"' in html


def test_details_summary_structure(tmp_path):
    keys = {("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert "<details>" in html
    assert "<summary>730/</summary>" in html


def test_generated_timestamp_present(tmp_path):
    keys = {("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert "Generated:" in html


# ─── generate_app_indexes ─────────────────────────────────────────────────────

def test_app_index_created(tmp_path):
    keys = {("730", "2020"), ("730", "2019")}
    data_dir = tmp_path / "data"
    generate_app_indexes(keys, data_dir)
    assert (data_dir / "730" / "index.json").exists()


def test_app_index_contains_sorted_years(tmp_path):
    keys = {("730", "2022"), ("730", "2019"), ("730", "2021")}
    data_dir = tmp_path / "data"
    generate_app_indexes(keys, data_dir)
    years = json.loads((data_dir / "730" / "index.json").read_text())
    assert years == ["2019", "2021", "2022"]


def test_app_index_multiple_apps(tmp_path):
    keys = {("730", "2020"), ("570", "2021"), ("570", "2022")}
    data_dir = tmp_path / "data"
    generate_app_indexes(keys, data_dir)
    assert json.loads((data_dir / "730" / "index.json").read_text()) == ["2020"]
    assert json.loads((data_dir / "570" / "index.json").read_text()) == ["2021", "2022"]


def test_app_index_unknown_year_included(tmp_path):
    keys = {("730", "2020"), ("730", "unknown")}
    data_dir = tmp_path / "data"
    generate_app_indexes(keys, data_dir)
    years = json.loads((data_dir / "730" / "index.json").read_text())
    assert "unknown" in years
    assert "2020" in years


def test_get_steam_api_key_reads_env_value():
    assert get_steam_api_key({"STEAM_API_KEY": " test-key "}) == "test-key"


def test_get_steam_api_key_returns_none_when_no_env_or_dotenv(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    monkeypatch.setattr("scripts.pipeline.catalog.DEFAULT_ENV_PATH", env_file)
    assert get_steam_api_key({}) is None


def test_load_dotenv_parses_simple_key_values(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("STEAM_API_KEY='abc123'\nOTHER=value\n")
    monkeypatch.setattr("scripts.pipeline.catalog.DEFAULT_ENV_PATH", env_file)
    assert load_dotenv() == {"STEAM_API_KEY": "abc123", "OTHER": "value"}


def test_build_steam_app_list_url_uses_expected_query_shape():
    url = build_steam_app_list_url("secret", last_appid=730, max_results=3)
    assert url.startswith("https://api.steampowered.com/IStoreService/GetAppList/v1/?")
    assert "key=secret" in url
    assert "include_games=true" in url
    assert "include_dlc=false" in url
    assert "last_appid=730" in url
    assert "max_results=3" in url


def test_load_vendor_scraper_module_requires_submodule_path(tmp_path):
    missing = tmp_path / "vendor-missing.py"
    try:
        load_vendor_scraper_module(missing)
        assert False, "expected FileNotFoundError"
    except FileNotFoundError:
        pass


def test_fetch_steam_game_catalog_paginates_and_filters_ids():
    responses = [
        {
            "response": {
                "apps": [
                    {"appid": 10, "name": "Counter-Strike"},
                    {"appid": "bad", "name": "Broken"},
                ],
                "have_more_results": True,
                "last_appid": 10,
            }
        },
        {
            "response": {
                "apps": [
                    {"appid": 20, "name": "Team Fortress Classic"},
                ],
                "have_more_results": False,
                "last_appid": 20,
            }
        },
    ]

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    class FakeScraper:
        def __init__(self):
            self.calls = []

        def DoRequest(self, url, parameters=None, *args, **kwargs):
            self.calls.append((url, dict(parameters or {})))
            return FakeResponse(responses.pop(0))

    fake_scraper = FakeScraper()

    catalog = fetch_steam_game_catalog("secret", max_results=2, scraper_module=fake_scraper)

    assert catalog == {
        "10": "Counter-Strike",
        "20": "Team Fortress Classic",
    }
    assert len(fake_scraper.calls) == 2
    assert fake_scraper.calls[0][0] == "https://api.steampowered.com/IStoreService/GetAppList/v1/"
    assert fake_scraper.calls[0][1]["key"] == "secret"
    assert fake_scraper.calls[1][1]["last_appid"] == 10


def test_load_steam_game_catalog_uses_cache_before_fetch(tmp_path):
    cache_path = tmp_path / "steam-game-catalog.json"
    write_cached_steam_game_catalog({"10": "Counter-Strike"}, cache_path=cache_path)

    class FakeScraper:
        def DoRequest(self, url, parameters=None, *args, **kwargs):
            raise AssertionError("fetch should not be called when cache is fresh")

    catalog = load_steam_game_catalog("secret", cache_path=cache_path, scraper_module=FakeScraper())
    assert catalog == {"10": "Counter-Strike"}
    assert read_cached_steam_game_catalog(cache_path=cache_path) == {"10": "Counter-Strike"}


def test_fetch_protondb_signal_catalog_collects_ids_from_sections():
    payload = {
        "fullSteamCatalog": {
            "games": [
                {"appId": "10", "title": "Counter-Strike"},
                {"appId": "bad", "title": "Broken"},
            ]
        },
        "topHundred": {
            "games": [
                {"appId": "20", "title": "Team Fortress Classic"},
            ]
        },
    }

    def fake_fetch(_url: str):
        return payload

    catalog = fetch_protondb_signal_catalog(fetch_json_impl=fake_fetch)
    assert catalog == {
        "10": "Counter-Strike",
        "20": "Team Fortress Classic",
    }


def test_load_protondb_signal_catalog_uses_cache_before_fetch(tmp_path):
    cache_path = tmp_path / "protondb-signal-catalog.json"
    write_cached_protondb_signal_catalog({"10": "Counter-Strike"}, cache_path=cache_path)

    def fake_fetch(_url: str):
        raise AssertionError("fetch should not be called when cache is fresh")

    catalog = load_protondb_signal_catalog(fetch_json_impl=fake_fetch, cache_path=cache_path)
    assert catalog == {"10": "Counter-Strike"}
    assert read_cached_protondb_signal_catalog(cache_path=cache_path) == {"10": "Counter-Strike"}


def test_generate_coverage_report_filters_steam_catalog_with_protondb_signals(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    generate_coverage_report(
        index_keys={("730", "2024")},
        backfilled_keys=set(),
        data_output_path=data_dir,
        output_path=tmp_path,
        steam_catalog={"730": "Counter-Strike 2", "999": "Noise Game"},
        protondb_signal_catalog={"730": "Counter-Strike 2"},
    )

    html = (tmp_path / "coverage.html").read_text()
    assert "730" in html
    assert "999" not in html
