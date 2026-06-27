"""Tests for the multi-signal delisted detection in game_images._fetch_steam_header.

Detection model: an app is flagged delisted only when both signals fire --
appdetails returns success: false AND the store page redirects to the
storefront homepage (no app page). When the run-wide canary is down, no app
gets flagged, so a temporary Steam outage cannot poison every probe.
"""
from unittest.mock import patch

from scripts.pipeline.game_images import (
    _STATUS_DELISTED,
    _STATUS_LIVE,
    _STATUS_UNKNOWN,
    _fetch_steam_header,
)


def _appdetails_response(app_id: str, success: bool, header: str | None = None):
    """Helper to shape the appdetails JSON the way Steam does."""
    if success:
        return {app_id: {"success": True, "data": {"header_image": header or ""}}}
    return {app_id: {"success": False}}


def test_live_app_returns_live_status_and_url(tmp_path):
    payload = _appdetails_response("220", success=True, header="https://example/220.jpg")
    with patch("scripts.pipeline.game_images.urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = __import__("json").dumps(payload).encode()
        url, status = _fetch_steam_header("220", store_up=True)
    assert status == _STATUS_LIVE
    assert url == "https://example/220.jpg"


def test_delisted_requires_both_signals(tmp_path):
    """appdetails false + store page 302 -> delisted."""
    payload = _appdetails_response("1889410", success=False)
    with patch("scripts.pipeline.game_images.urllib.request.urlopen") as mock_open, \
         patch("scripts.pipeline.game_images._probe_store_page", return_value=False):
        mock_open.return_value.__enter__.return_value.read.return_value = __import__("json").dumps(payload).encode()
        url, status = _fetch_steam_header("1889410", store_up=True)
    assert status == _STATUS_DELISTED
    assert url is None


def test_appdetails_false_with_live_store_page_is_unknown(tmp_path):
    """If the store page still responds 200, it is not delisted -- region lock
    or restricted release, mark unknown so next run can re-evaluate.
    """
    payload = _appdetails_response("12345", success=False)
    with patch("scripts.pipeline.game_images.urllib.request.urlopen") as mock_open, \
         patch("scripts.pipeline.game_images._probe_store_page", return_value=True):
        mock_open.return_value.__enter__.return_value.read.return_value = __import__("json").dumps(payload).encode()
        url, status = _fetch_steam_header("12345", store_up=True)
    assert status == _STATUS_UNKNOWN


def test_canary_down_never_flags_delisted(tmp_path):
    """Steam-wide outage: even with appdetails false + 302 we refuse to flag."""
    payload = _appdetails_response("1889410", success=False)
    with patch("scripts.pipeline.game_images.urllib.request.urlopen") as mock_open, \
         patch("scripts.pipeline.game_images._probe_store_page") as probe:
        mock_open.return_value.__enter__.return_value.read.return_value = __import__("json").dumps(payload).encode()
        url, status = _fetch_steam_header("1889410", store_up=False)
    # Store page must NOT be probed once we know the canary is down
    probe.assert_not_called()
    assert status == _STATUS_UNKNOWN


def test_transport_error_returns_unknown(tmp_path):
    """A urlopen exception is treated as transient, not delisted."""
    with patch("scripts.pipeline.game_images.urllib.request.urlopen", side_effect=ConnectionError("boom")):
        url, status = _fetch_steam_header("220", store_up=True)
    assert status == _STATUS_UNKNOWN
    assert url is None


def test_store_page_probe_uncertain_is_unknown(tmp_path):
    """When the store probe itself errors out (returns None), do not flag."""
    payload = _appdetails_response("12345", success=False)
    with patch("scripts.pipeline.game_images.urllib.request.urlopen") as mock_open, \
         patch("scripts.pipeline.game_images._probe_store_page", return_value=None):
        mock_open.return_value.__enter__.return_value.read.return_value = __import__("json").dumps(payload).encode()
        url, status = _fetch_steam_header("12345", store_up=True)
    assert status == _STATUS_UNKNOWN
