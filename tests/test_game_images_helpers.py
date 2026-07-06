"""Tests for the network helpers in scripts/pipeline/game_images.py."""

import json
from unittest.mock import patch, MagicMock

from scripts.pipeline import game_images as gi


def _resp(payload=None, status=200):
    """urlopen() context-manager stub: read() returns JSON, .status is set."""
    cm = MagicMock()
    inner = cm.__enter__.return_value
    if payload is not None:
        inner.read.return_value = json.dumps(payload).encode("utf-8")
    inner.status = status
    cm.__exit__.return_value = False
    return cm


def test_standard_header_url():
    assert gi._standard_header_url("730").endswith("/apps/730/header.jpg")


# --- _fetch_admin_overrides ------------------------------------------------

def test_fetch_admin_overrides_skips_without_env():
    with patch.object(gi, "SUPABASE_URL", ""), patch.object(gi, "SUPABASE_ANON_KEY", ""):
        assert gi._fetch_admin_overrides() == {}


def test_fetch_admin_overrides_parses_valid_rows_only():
    rows = [
        {"app_id": "730", "image_url": "https://img/730.jpg", "source": "sgdb", "updated_at": "t"},
        {"app_id": "", "image_url": "https://skip"},   # no app_id -> skipped
        {"app_id": "570", "image_url": None},            # no image -> skipped
    ]
    with patch.object(gi, "SUPABASE_URL", "https://sb"), \
         patch.object(gi, "SUPABASE_ANON_KEY", "anon"), \
         patch("urllib.request.urlopen", return_value=_resp(rows)):
        out = gi._fetch_admin_overrides()
    assert set(out) == {"730"}
    assert out["730"] == {"image_url": "https://img/730.jpg", "source": "sgdb", "updated_at": "t"}


def test_fetch_admin_overrides_empty_on_transport_error():
    with patch.object(gi, "SUPABASE_URL", "https://sb"), \
         patch.object(gi, "SUPABASE_ANON_KEY", "anon"), \
         patch("urllib.request.urlopen", side_effect=Exception("boom")):
        assert gi._fetch_admin_overrides() == {}


def test_fetch_admin_overrides_empty_on_non_list_shape():
    with patch.object(gi, "SUPABASE_URL", "https://sb"), \
         patch.object(gi, "SUPABASE_ANON_KEY", "anon"), \
         patch("urllib.request.urlopen", return_value=_resp({"error": "nope"})):
        assert gi._fetch_admin_overrides() == {}


# --- _fetch_sgdb_header ----------------------------------------------------

def test_fetch_sgdb_header_none_without_key():
    with patch.object(gi, "SGDB_API_KEY", ""):
        assert gi._fetch_sgdb_header("730") is None


def test_fetch_sgdb_header_prefers_png():
    lookup = {"success": True, "data": {"id": 42}}
    grids = {"success": True, "data": [
        {"mime": "image/jpeg", "url": "https://j.jpg"},
        {"mime": "image/png", "url": "https://p.png"},
    ]}
    with patch.object(gi, "SGDB_API_KEY", "k"), \
         patch("urllib.request.urlopen", side_effect=[_resp(lookup), _resp(grids)]):
        assert gi._fetch_sgdb_header("730") == "https://p.png"


def test_fetch_sgdb_header_falls_back_to_first_when_no_png():
    lookup = {"success": True, "data": {"id": 42}}
    grids = {"success": True, "data": [{"mime": "image/jpeg", "url": "https://j.jpg"}]}
    with patch.object(gi, "SGDB_API_KEY", "k"), \
         patch("urllib.request.urlopen", side_effect=[_resp(lookup), _resp(grids)]):
        assert gi._fetch_sgdb_header("730") == "https://j.jpg"


def test_fetch_sgdb_header_none_on_lookup_failure():
    with patch.object(gi, "SGDB_API_KEY", "k"), \
         patch("urllib.request.urlopen", return_value=_resp({"success": False})):
        assert gi._fetch_sgdb_header("730") is None


def test_fetch_sgdb_header_none_when_no_grids():
    lookup = {"success": True, "data": {"id": 42}}
    grids = {"success": True, "data": []}
    with patch.object(gi, "SGDB_API_KEY", "k"), \
         patch("urllib.request.urlopen", side_effect=[_resp(lookup), _resp(grids)]):
        assert gi._fetch_sgdb_header("730") is None


# --- _url_is_ok ------------------------------------------------------------

def test_url_is_ok_true_on_200():
    with patch("urllib.request.urlopen", return_value=_resp(status=200)):
        assert gi._url_is_ok("https://x") is True


def test_url_is_ok_false_on_non_200():
    with patch("urllib.request.urlopen", return_value=_resp(status=404)):
        assert gi._url_is_ok("https://x") is False


def test_url_is_ok_false_on_error():
    with patch("urllib.request.urlopen", side_effect=Exception("boom")):
        assert gi._url_is_ok("https://x") is False


# --- _extract_replaced_by (Steam appid replacement detection) --------------

def test_extract_replaced_by_returns_new_appid_on_redirect():
    """5488 (Devil May Cry 4) -> 45700: the store follows redirects and lands on
    /app/45700/Devil_May_Cry_4/, which encodes the new appid."""
    resp = MagicMock()
    resp.__enter__.return_value.geturl.return_value = (
        "https://store.steampowered.com/app/45700/Devil_May_Cry_4/"
    )
    resp.__exit__.return_value = False
    with patch("urllib.request.urlopen", return_value=resp):
        assert gi._extract_replaced_by("5488") == "45700"


def test_extract_replaced_by_returns_none_when_same_appid():
    """Live store pages resolve back to the same /app/N/ URL."""
    resp = MagicMock()
    resp.__enter__.return_value.geturl.return_value = (
        "https://store.steampowered.com/app/730/Counter_Strike_2/"
    )
    resp.__exit__.return_value = False
    with patch("urllib.request.urlopen", return_value=resp):
        assert gi._extract_replaced_by("730") is None


def test_extract_replaced_by_returns_none_when_redirected_to_homepage():
    """Delisted-without-replacement lands on the store homepage."""
    resp = MagicMock()
    resp.__enter__.return_value.geturl.return_value = "https://store.steampowered.com/"
    resp.__exit__.return_value = False
    with patch("urllib.request.urlopen", return_value=resp):
        assert gi._extract_replaced_by("999999") is None


def test_extract_replaced_by_returns_none_on_transport_error():
    with patch("urllib.request.urlopen", side_effect=Exception("boom")):
        assert gi._extract_replaced_by("5488") is None
