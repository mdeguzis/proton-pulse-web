"""Tests for the Steam app-id redirect validator.

Covers the response classification, the substring-prefix regression case
(app_id=26 wrongly reported "valid" for /app/2670/), the cache TTL
lifecycle, and the search-index -> redirects.json output pipeline.
"""

import json
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError

import scripts.pipeline.validate_app_ids as validate_module
from scripts.pipeline.validate_app_ids import (
    _follow_redirects,
    _is_stale,
    _load_cache,
    _save_cache,
    validate_steam_app_ids,
)


def _make_response(final_url: str) -> MagicMock:
    resp = MagicMock()
    resp.url = final_url
    resp.close = MagicMock()
    return resp


class TestFollowRedirects:
    def test_valid_when_final_url_matches_original_app_id(self):
        with patch("urllib.request.urlopen", return_value=_make_response(
            "https://store.steampowered.com/app/730/Counter-Strike_2/"
        )):
            result = _follow_redirects("730")
        assert result == {"status": "valid"}

    def test_replaced_when_final_url_is_a_different_app_id(self):
        with patch("urllib.request.urlopen", return_value=_make_response(
            "https://store.steampowered.com/app/22670/"
        )):
            result = _follow_redirects("26670")
        assert result["status"] == "replaced"
        assert result["replaced_by"] == "22670"
        assert result["final_url"] == "https://store.steampowered.com/app/22670/"

    def test_dead_when_redirected_to_homepage_without_any_app_path(self):
        with patch("urllib.request.urlopen", return_value=_make_response(
            "https://store.steampowered.com/"
        )):
            result = _follow_redirects("9999999")
        assert result["status"] == "dead"
        assert result["final_url"] == "https://store.steampowered.com/"

    def test_prefix_id_is_not_a_false_positive_valid(self):
        """Regression: app_id=26 must NOT be reported valid when Steam
        redirects to /app/2670/. The old substring check would fail this."""
        with patch("urllib.request.urlopen", return_value=_make_response(
            "https://store.steampowered.com/app/2670/Some_Game/"
        )):
            result = _follow_redirects("26")
        assert result["status"] == "replaced"
        assert result["replaced_by"] == "2670"

    def test_prefix_id_is_not_a_false_positive_dead(self):
        """Another prefix scenario: 220 redirected to 22000 should not be
        misread as valid via substring match."""
        with patch("urllib.request.urlopen", return_value=_make_response(
            "https://store.steampowered.com/app/22000/"
        )):
            result = _follow_redirects("220")
        assert result["status"] == "replaced"
        assert result["replaced_by"] == "22000"

    def test_http_404_marked_dead(self):
        err = HTTPError(
            url="https://store.steampowered.com/app/9999999/",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=None,
        )
        with patch("urllib.request.urlopen", side_effect=err):
            result = _follow_redirects("9999999")
        assert result["status"] == "dead"
        assert result["http_status"] == 404

    def test_non_404_http_error_marked_error_not_dead(self):
        err = HTTPError(
            url="https://store.steampowered.com/app/730/",
            code=503,
            msg="Service Unavailable",
            hdrs=None,
            fp=None,
        )
        with patch("urllib.request.urlopen", side_effect=err):
            result = _follow_redirects("730")
        assert result["status"] == "error"
        assert result["http_status"] == 503

    def test_generic_exception_bubbles_as_error_string(self):
        with patch("urllib.request.urlopen", side_effect=TimeoutError("read timeout")):
            result = _follow_redirects("730")
        assert result["status"] == "error"
        assert "timeout" in result["error"].lower()


class TestIsStale:
    def test_missing_probed_at_is_stale(self):
        assert _is_stale({}) is True

    def test_invalid_probed_at_is_stale(self):
        assert _is_stale({"probed_at": "not-a-date"}) is True

    def test_recently_probed_is_fresh(self):
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        assert _is_stale({"probed_at": yesterday}) is False

    def test_older_than_ttl_is_stale(self):
        old = (date.today() - timedelta(days=validate_module.STALE_DAYS + 1)).isoformat()
        assert _is_stale({"probed_at": old}) is True


class TestCacheRoundTrip:
    def test_load_missing_cache_returns_empty_dict(self, tmp_path: Path):
        assert _load_cache(tmp_path) == {}

    def test_save_then_load_roundtrips_entries(self, tmp_path: Path):
        payload = {"730": {"status": "valid", "probed_at": "2026-07-07"}}
        _save_cache(tmp_path, payload)
        loaded = _load_cache(tmp_path)
        assert loaded == payload

    def test_corrupt_cache_is_treated_as_empty(self, tmp_path: Path):
        cache_path = tmp_path / "app-id-validation-cache.json"
        cache_path.write_text("{not-json", encoding="utf-8")
        assert _load_cache(tmp_path) == {}


class TestValidateSteamAppIds:
    def _write_search_index(self, tmp_path: Path, rows):
        (tmp_path / "search-index.json").write_text(
            json.dumps(rows), encoding="utf-8"
        )

    def test_no_search_index_skips_gracefully(self, tmp_path: Path):
        assert validate_steam_app_ids(str(tmp_path)) == {}
        assert not (tmp_path / "app-id-redirects.json").exists()

    def test_writes_only_problematic_entries_to_redirects_json(self, tmp_path: Path):
        # Row shape from search-index.json: [app_id, title, ..., type (col 5), ...]
        # Column 5 is the store type. "steam" rows are probed; others are skipped.
        self._write_search_index(tmp_path, [
            ["730", "Counter-Strike 2", 0, 0, 0, "steam"],
            ["26670", "Old Game", 0, 0, 0, "steam"],
            ["9999999", "Dead ID",     0, 0, 0, "steam"],
            ["gog:123", "GOG Game",    0, 0, 0, "gog"],  # non-steam, skipped
        ])

        def fake_probe(app_id):
            return {
                "730":     {"status": "valid"},
                "26670":   {"status": "replaced", "replaced_by": "22670",
                            "final_url": "https://store.steampowered.com/app/22670/"},
                "9999999": {"status": "dead",
                            "final_url": "https://store.steampowered.com/"},
            }[app_id]

        with patch("scripts.pipeline.validate_app_ids._follow_redirects", side_effect=fake_probe), \
             patch("scripts.pipeline.validate_app_ids.time.sleep"):
            redirects = validate_steam_app_ids(str(tmp_path))

        # Valid entries are omitted from the output.
        assert "730" not in redirects
        assert redirects["26670"]["status"] == "replaced"
        assert redirects["26670"]["replaced_by"] == "22670"
        assert redirects["9999999"]["status"] == "dead"

        on_disk = json.loads((tmp_path / "app-id-redirects.json").read_text())
        assert on_disk == redirects

    def test_fresh_cache_entries_are_not_reprobed(self, tmp_path: Path):
        self._write_search_index(tmp_path, [
            ["730", "CS2", 0, 0, 0, "steam"],
        ])
        # Prime cache with a fresh valid entry.
        _save_cache(tmp_path, {
            "730": {"status": "valid", "probed_at": date.today().isoformat()},
        })

        with patch("scripts.pipeline.validate_app_ids._follow_redirects") as probe, \
             patch("scripts.pipeline.validate_app_ids.time.sleep"):
            validate_steam_app_ids(str(tmp_path))

        probe.assert_not_called()

    def test_stale_cache_entries_are_reprobed(self, tmp_path: Path):
        self._write_search_index(tmp_path, [
            ["730", "CS2", 0, 0, 0, "steam"],
        ])
        old = (date.today() - timedelta(days=validate_module.STALE_DAYS + 5)).isoformat()
        _save_cache(tmp_path, {
            "730": {"status": "valid", "probed_at": old},
        })

        with patch(
            "scripts.pipeline.validate_app_ids._follow_redirects",
            return_value={"status": "valid"},
        ) as probe, patch("scripts.pipeline.validate_app_ids.time.sleep"):
            validate_steam_app_ids(str(tmp_path))

        probe.assert_called_once_with("730")

    def test_probe_cap_limits_a_single_run(self, tmp_path: Path):
        rows = [[str(1000 + i), f"App {i}", 0, 0, 0, "steam"]
                for i in range(validate_module.PROBE_CAP + 25)]
        self._write_search_index(tmp_path, rows)

        with patch(
            "scripts.pipeline.validate_app_ids._follow_redirects",
            return_value={"status": "valid"},
        ) as probe, patch("scripts.pipeline.validate_app_ids.time.sleep"):
            validate_steam_app_ids(str(tmp_path))

        assert probe.call_count == validate_module.PROBE_CAP
