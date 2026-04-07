from pathlib import Path
import json
from http.client import HTTPResponse
from io import BytesIO
from urllib.error import HTTPError

from scripts.pipeline.finalize import build_probe_chunk_plan, generate_coverage_report, generate_index_html, generate_app_indexes
from scripts.pipeline.catalog import (
    PROTONDB_PROBE_LOG_EVERY,
    build_steam_app_list_url,
    fetch_steam_game_catalog,
    fetch_protondb_signal_catalog,
    fetch_protondb_summary,
    get_protondb_probe_cache_max_age_seconds,
    get_steam_api_key,
    get_protondb_probe_limit,
    get_protondb_probe_log_every,
    load_dotenv,
    load_protondb_signal_catalog,
    load_vendor_scraper_module,
    load_steam_game_catalog,
    probe_protondb_app_ids,
    read_protondb_probe_cache,
    read_cached_protondb_signal_catalog,
    read_cached_steam_game_catalog,
    retry_http,
    write_protondb_probe_cache,
    write_cached_protondb_signal_catalog,
    write_cached_steam_game_catalog,
)
from scripts.pipeline.metadata import update_app_metadata


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


def test_index_html_includes_dark_mode_support(tmp_path):
    keys = {("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert 'meta name="color-scheme" content="light dark"' in html
    assert "@media (prefers-color-scheme: dark)" in html


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


def test_get_protondb_probe_limit_reads_env_value():
    assert get_protondb_probe_limit({"PROTONDB_PROBE_LIMIT": "250"}) == 250
    assert get_protondb_probe_limit({"PROTONDB_PROBE_LIMIT": "bad"}) == 0


def test_get_protondb_probe_cache_max_age_seconds_reads_env_days():
    assert get_protondb_probe_cache_max_age_seconds({"PROTONDB_PROBE_CACHE_MAX_AGE_DAYS": "7"}) == 604800
    assert get_protondb_probe_cache_max_age_seconds({"PROTONDB_PROBE_CACHE_MAX_AGE_DAYS": "bad"}) == 90 * 24 * 60 * 60


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


def test_fetch_protondb_summary_retries_transient_errors():
    attempts = {"count": 0}

    def fake_fetch(_url: str):
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise HTTPError(_url, 500, "server error", hdrs=None, fp=None)
        return {"tier": "gold", "total": 10, "title": "Counter-Strike"}

    payload = fetch_protondb_summary("10", fetch_json_impl=fake_fetch)
    assert payload["title"] == "Counter-Strike"
    assert attempts["count"] == 3


def test_get_protondb_probe_log_every_defaults_and_bounds():
    assert get_protondb_probe_log_every({}) == PROTONDB_PROBE_LOG_EVERY
    assert get_protondb_probe_log_every({"PROTONDB_PROBE_LOG_EVERY": "25"}) == 25
    assert get_protondb_probe_log_every({"PROTONDB_PROBE_LOG_EVERY": "0"}) == 1
    assert get_protondb_probe_log_every({"PROTONDB_PROBE_LOG_EVERY": "bad"}) == PROTONDB_PROBE_LOG_EVERY


def test_probe_protondb_app_ids_updates_cache_and_tracked_catalog():
    existing_cache = {
        "10": {"tracked": True, "title": "Counter-Strike", "checked_at": 123},
    }

    def fake_fetch(url: str):
        if url.endswith("/20.json"):
            return {"tier": "gold", "total": 1, "title": "Team Fortress Classic"}
        if url.endswith("/30.json"):
            return {"tier": "pending", "total": 0, "title": ""}
        raise AssertionError(f"Unexpected URL: {url}")

    cache, tracked = probe_protondb_app_ids(
        ["10", "20", "30"],
        existing_cache=existing_cache,
        fetch_json_impl=fake_fetch,
        limit=10,
        log_every=1,
    )

    assert tracked == {
        "10": "Counter-Strike",
        "20": "Team Fortress Classic",
    }
    assert cache["20"]["tracked"] is True
    assert cache["30"]["tracked"] is False


def test_probe_protondb_app_ids_uses_limit():
    calls = []

    def fake_fetch(url: str):
        calls.append(url)
        return {"tier": "gold", "total": 1, "title": "Tracked"}

    cache, tracked = probe_protondb_app_ids(
        ["10", "20", "30"],
        existing_cache={},
        fetch_json_impl=fake_fetch,
        limit=2,
        log_every=10,
    )

    assert len(calls) == 2
    assert set(cache.keys()) == {"10", "20"}
    assert set(tracked.keys()) == {"10", "20"}


def test_probe_protondb_app_ids_flushes_cache_periodically(tmp_path):
    writes = []

    def fake_fetch(_url: str):
        return {"tier": "gold", "total": 1, "title": "Tracked"}

    def fake_write_cache(cache: dict[str, dict], cache_path: Path):
        writes.append((cache_path, set(cache.keys())))

    cache_path = tmp_path / "probe-cache.json"
    cache, tracked = probe_protondb_app_ids(
        ["10", "20", "30"],
        existing_cache={},
        fetch_json_impl=fake_fetch,
        limit=10,
        log_every=10,
        cache_path=cache_path,
        flush_every=2,
        write_cache_impl=fake_write_cache,
    )

    assert len(writes) == 2
    assert writes[0][0] == cache_path
    assert writes[0][1] == {"10", "20"}
    assert writes[1][1] == {"10", "20", "30"}
    assert set(cache.keys()) == {"10", "20", "30"}
    assert set(tracked.keys()) == {"10", "20", "30"}


def test_probe_protondb_app_ids_keeps_going_after_generic_failure():
    calls = []

    def fake_fetch(url: str):
        calls.append(url)
        if url.endswith("/10.json"):
            raise RuntimeError("temporary parse issue")
        return {"tier": "gold", "total": 1, "title": "Tracked"}

    cache, tracked = probe_protondb_app_ids(
        ["10", "20"],
        existing_cache={},
        fetch_json_impl=fake_fetch,
        limit=10,
        log_every=1,
    )

    assert len(calls) == 2
    assert "10" not in cache
    assert tracked == {"20": "Tracked"}


def test_protondb_probe_cache_round_trip(tmp_path):
    cache_path = tmp_path / "protondb-summary-probe-cache.json"
    payload = {
        "10": {"tracked": True, "title": "Counter-Strike", "checked_at": 2_000_000_000},
    }
    write_protondb_probe_cache(payload, cache_path=cache_path)
    loaded = read_protondb_probe_cache(cache_path=cache_path, max_age_seconds=10_000_000_000)
    assert loaded["10"]["tracked"] is True


def test_build_probe_chunk_plan_uses_remaining_uncached_count(monkeypatch):
    monkeypatch.setattr("scripts.pipeline.finalize.compute_probe_candidates", lambda _output_dir: (["10", "20", "30", "40", "50"], 1))
    monkeypatch.setattr("scripts.pipeline.finalize.get_protondb_probe_limit", lambda _env=None: 2)

    plan = build_probe_chunk_plan("/tmp/protondb-output")

    assert plan["candidate_count"] == 5
    assert plan["cached_count"] == 1
    assert plan["uncached_count"] == 4
    assert plan["chunk_count"] == 2
    assert plan["chunks"] == ["01", "02"]


def test_generate_coverage_report_includes_all_steam_game_app_ids(tmp_path):
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
    # All Steam game app IDs must appear in coverage, even without ProtonDB data
    assert "999" in html
    assert "Noise Game" in html


def test_generate_coverage_report_shows_protondb_counts(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    generate_coverage_report(
        index_keys={("730", "2024")},
        backfilled_keys=set(),
        data_output_path=data_dir,
        output_path=tmp_path,
        steam_catalog={"730": "Counter-Strike 2", "999": "Noise Game"},
        protondb_signal_catalog={"730": "Counter-Strike 2"},
        protondb_counts={"uniqueGames": 37720, "reports": 415861, "timestamp": 1775339147},
    )

    html = (tmp_path / "coverage.html").read_text()
    assert "37,720" in html
    assert "415,861" in html
    assert "ProtonDB Total" in html


def test_generate_coverage_report_shows_title_and_catalog_source_columns(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    generate_coverage_report(
        index_keys={("730", "2024")},
        backfilled_keys={("730", "2024")},
        data_output_path=data_dir,
        output_path=tmp_path,
        steam_catalog={"730": "Counter-Strike 2", "999": "Noise Game"},
        protondb_signal_catalog={"730": "Counter-Strike 2", "999": "Noise Game"},
    )

    html = (tmp_path / "coverage.html").read_text()
    assert "Title Source" in html
    assert "ProtonDB Signal" in html
    assert "Steam Catalog" in html
    assert "protondb-signal" in html or "protondb signal" in html


def test_generate_coverage_report_numeric_filter_uses_exact_app_id_match(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    generate_coverage_report(
        index_keys={("396420", "2024"), ("3396420", "2024")},
        backfilled_keys=set(),
        data_output_path=data_dir,
        output_path=tmp_path,
        steam_catalog={"396420": "Exact", "3396420": "Contains"},
        protondb_signal_catalog={"396420": "Exact", "3396420": "Contains"},
    )

    html = (tmp_path / "coverage.html").read_text()
    assert 'if(r[0]!==q)return false;' in html


def test_generate_coverage_report_uses_persisted_metadata_for_provenance(tmp_path):
    data_dir = tmp_path / "data"
    app_dir = data_dir / "730"
    app_dir.mkdir(parents=True)
    (app_dir / "2024.json").write_text(json.dumps([{"title": "Counter-Strike 2", "timestamp": 1704067200}]))
    (app_dir / "latest.json").write_text(json.dumps([{"title": "Counter-Strike 2", "timestamp": 1704067200}]))
    update_app_metadata(data_dir, "730", official_dump=True, protondb_live=True)

    generate_coverage_report(
        index_keys={("730", "2024")},
        backfilled_keys=set(),
        data_output_path=data_dir,
        output_path=tmp_path,
        steam_catalog={"730": "Counter-Strike 2"},
        protondb_signal_catalog={"730": "Counter-Strike 2"},
    )

    html = (tmp_path / "coverage.html").read_text()
    assert "Official Dump" in html
    assert "Backfilled" in html
    assert '<div class="value">1</div>' in html
    assert '"indexed-data",1,1,1,1,"official backfill protondb-signal steam-catalog",1' in html


def test_retry_http_retries_on_transient_error(monkeypatch):
    monkeypatch.setattr("scripts.pipeline.catalog.time.sleep", lambda _: None)
    call_count = 0

    @retry_http(attempts=3, base_delay_seconds=0.01)
    def flaky():
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise HTTPError("http://example.com", 500, "error", {}, None)
        return "ok"

    assert flaky() == "ok"
    assert call_count == 3


def test_retry_http_raises_404_immediately(monkeypatch):
    monkeypatch.setattr("scripts.pipeline.catalog.time.sleep", lambda _: None)
    call_count = 0

    @retry_http(attempts=5, base_delay_seconds=0.01)
    def not_found():
        nonlocal call_count
        call_count += 1
        raise HTTPError("http://example.com", 404, "not found", {}, None)

    try:
        not_found()
        assert False, "Should have raised"
    except HTTPError as exc:
        assert exc.code == 404
    assert call_count == 1


def test_retry_http_handles_429_with_retry_after(monkeypatch):
    slept_durations = []
    monkeypatch.setattr("scripts.pipeline.catalog.time.sleep", lambda d: slept_durations.append(d))
    monkeypatch.setattr("scripts.pipeline.catalog.random.uniform", lambda a, b: 0.5)
    call_count = 0

    class FakeHeaders:
        def get(self, key, default=""):
            return "2" if key == "Retry-After" else default

    @retry_http(attempts=3, base_delay_seconds=0.01)
    def rate_limited():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            exc = HTTPError("http://example.com", 429, "too many", FakeHeaders(), None)
            raise exc
        return "ok"

    assert rate_limited() == "ok"
    assert call_count == 2
    # Should have respected Retry-After=2 + jitter=0.5
    assert len(slept_durations) == 1
    assert slept_durations[0] == 2.5


def test_probe_protondb_app_ids_unlimited_when_limit_zero():
    call_count = 0

    def fake_fetch(url):
        nonlocal call_count
        call_count += 1
        raise HTTPError(url, 404, "not found", {}, None)

    candidates = [str(i) for i in range(10)]
    cache, catalog = probe_protondb_app_ids(
        candidates, fetch_json_impl=fake_fetch, limit=0, log_every=100,
    )
    # All 10 should have been probed (404 = no summary, not tracked)
    assert len(cache) == 10
    assert call_count == 10
    assert len(catalog) == 0


def test_probe_limit_default_is_zero():
    assert get_protondb_probe_limit(env={}) == 0
