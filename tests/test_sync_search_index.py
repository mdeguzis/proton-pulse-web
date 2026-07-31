"""Tests for scripts/pipeline/sync_search_index.py (#434 followup).

Covers row coercion, batching, HTTP call wrapping, and the top-level
sync driver's happy path + fall-back paths (missing file, missing
service key, malformed JSON, HTTP failure). All network calls are
mocked; the tests never hit Supabase.
"""

import io
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from scripts.pipeline.sync_search_index import (
    COLUMNS,
    DEFAULT_BATCH,
    DEFAULT_URL,
    VALID_SOURCES,
    _batched,
    _delete_stale,
    _post_batch,
    _row_to_dict,
    sync_search_index,
)


# ---- constants + module surface ------------------------------------------


def test_valid_sources_matches_search_index_source_set():
    # The four sources the pipeline emits into search-index.json col 5.
    # If a new source lands (e.g. 'itch'), sync must add it here or the
    # rows silently drop out of the API-backed search.
    assert VALID_SOURCES == frozenset({"steam", "gog", "epic", "pgwiki"})


def test_columns_covers_search_index_shape():
    # Row coercion emits exactly this column set into the search_index
    # table. Keep in lockstep with the migration.
    assert "app_id" in COLUMNS
    assert "title" in COLUMNS
    assert "source" in COLUMNS
    assert "delisted" in COLUMNS
    assert "replaced_by" in COLUMNS


# ---- _row_to_dict --------------------------------------------------------


def test_row_to_dict_maps_full_shape():
    row = [
        "220", "Half-Life 2", "gold", 5, 2, "steam",
        2004, None, False, "", None, "game",
    ]
    out = _row_to_dict(row)
    assert out["app_id"] == "220"
    assert out["title"] == "Half-Life 2"
    assert out["tier"] == "gold"
    assert out["source"] == "steam"
    assert out["protondb_count"] == 5
    assert out["pulse_count"] == 2
    assert out["release_year"] == 2004
    assert out["delisted"] is False
    assert out["adult"] is False
    assert out["replaced_by"] is None
    assert out["steam_type"] == "game"


def test_row_to_dict_maps_delisted_pgwiki_row():
    # The Solo Leveling: Arise shape after the cross-check.
    row = [
        "pw_v5qtvk77", "Solo Leveling: Arise", "pending", 0, 0, "pgwiki",
        2024, True, False, "", "steam:2373990", None,
    ]
    out = _row_to_dict(row)
    assert out["source"] == "pgwiki"
    assert out["delisted"] is True
    assert out["replaced_by"] == "steam:2373990"


def test_row_to_dict_rejects_non_list_and_short_rows():
    assert _row_to_dict(None) is None
    assert _row_to_dict("not-a-row") is None
    assert _row_to_dict(["220"]) is None  # too short (< 6 cols)
    assert _row_to_dict(["220", "Half-Life 2", "gold", 5, 2]) is None


def test_row_to_dict_rejects_missing_required_fields():
    assert _row_to_dict(["", "Half-Life 2", "gold", 0, 0, "steam"]) is None
    assert _row_to_dict(["220", "", "gold", 0, 0, "steam"]) is None
    assert _row_to_dict(["220", "Half-Life 2", "gold", 0, 0, ""]) is None
    assert _row_to_dict(["220", "Half-Life 2", "gold", 0, 0, "unknown"]) is None


def test_row_to_dict_defaults_and_coercions():
    # Missing tier + garbage counts default sensibly.
    out = _row_to_dict(["220", "Half-Life 2", None, "bogus", None, "STEAM"])
    assert out["tier"] == "pending"  # None -> "pending" default
    assert out["protondb_count"] == 0
    assert out["pulse_count"] == 0
    assert out["source"] == "steam"  # lowercased


def test_row_to_dict_year_bounds():
    # Only sensible years pass through; nonsense (0, 3000) drops to None.
    assert _row_to_dict(["220", "T", "gold", 0, 0, "steam", 2004])["release_year"] == 2004
    assert _row_to_dict(["220", "T", "gold", 0, 0, "steam", 0])["release_year"] is None
    assert _row_to_dict(["220", "T", "gold", 0, 0, "steam", 3000])["release_year"] is None
    assert _row_to_dict(["220", "T", "gold", 0, 0, "steam", "not-a-year"])["release_year"] is None
    assert _row_to_dict(["220", "T", "gold", 0, 0, "steam", None])["release_year"] is None


def test_row_to_dict_truncates_absurd_titles():
    # A pathological 10k-char title still coerces without blowing the row.
    row = ["220", "X" * 10_000, "gold", 0, 0, "steam"]
    out = _row_to_dict(row)
    assert len(out["title"]) == 500


# ---- _batched ------------------------------------------------------------


def test_batched_chunks_evenly():
    assert list(_batched(list(range(10)), 3)) == [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]


def test_batched_empty_input_yields_nothing():
    assert list(_batched([], 5)) == []


def test_batched_size_larger_than_input():
    assert list(_batched([1, 2], 100)) == [[1, 2]]


# ---- _post_batch (HTTP mocked) -------------------------------------------


def _fake_response(status=200):
    resp = MagicMock()
    resp.status = status
    resp.reason = "OK"
    resp.headers = {}
    resp.__enter__ = lambda self: self
    resp.__exit__ = lambda self, *a: None
    return resp


def test_post_batch_happy_path():
    batch = [{"app_id": "220", "title": "Half-Life 2", "source": "steam"}]
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen", return_value=_fake_response(201)) as m:
        _post_batch("https://sb.example", "svc_key", batch)
    assert m.call_count == 1
    req = m.call_args[0][0]
    assert req.method == "POST"
    assert "search_index" in req.full_url
    assert "on_conflict=app_id" in req.full_url
    assert req.headers["Prefer"].startswith("resolution=merge-duplicates")


def test_post_batch_raises_on_4xx():
    from urllib.error import HTTPError
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen", return_value=_fake_response(400)):
        with pytest.raises(HTTPError):
            _post_batch("https://sb.example", "svc_key", [{"app_id": "220"}])


# ---- _delete_stale -------------------------------------------------------


def test_delete_stale_no_diff():
    # Everything in DB is also in live_ids -> no DELETE fired.
    list_resp = MagicMock()
    list_resp.__enter__ = lambda self: self
    list_resp.__exit__ = lambda self, *a: None
    list_resp.read.return_value = json.dumps([{"app_id": "220"}, {"app_id": "440"}]).encode()

    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [list_resp]
        deleted = _delete_stale("https://sb.example", "svc_key", {"220", "440"})
    assert deleted == 0
    assert m.call_count == 1  # only the initial list call


def test_delete_stale_batches_the_diff():
    # DB has 220 + 440 + 999; live has 220 + 440 -> delete 999.
    list_resp = MagicMock()
    list_resp.__enter__ = lambda self: self
    list_resp.__exit__ = lambda self, *a: None
    list_resp.read.return_value = json.dumps(
        [{"app_id": "220"}, {"app_id": "440"}, {"app_id": "999"}]
    ).encode()
    del_resp = _fake_response(204)

    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [list_resp, del_resp]
        deleted = _delete_stale("https://sb.example", "svc_key", {"220", "440"})
    assert deleted == 1
    delete_call = m.call_args_list[1]
    assert "in.(" in delete_call[0][0].full_url
    assert "999" in delete_call[0][0].full_url


# ---- sync_search_index (end-to-end with mocks) ---------------------------


def test_sync_missing_file_returns_early(tmp_path, caplog):
    # No search-index.json in tmp -> log + return, no HTTP calls.
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        sync_search_index(tmp_path)
    m.assert_not_called()


def test_sync_missing_service_key_skips(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    (tmp_path / "search-index.json").write_text(json.dumps([
        ["220", "Half-Life 2", "gold", 5, 2, "steam"],
    ]))
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        sync_search_index(tmp_path)
    m.assert_not_called()


def test_sync_malformed_json_returns_early(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc_key")
    (tmp_path / "search-index.json").write_text("{not valid json")
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        sync_search_index(tmp_path)
    m.assert_not_called()


def test_sync_non_list_root_returns_early(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc_key")
    (tmp_path / "search-index.json").write_text(json.dumps({"not": "a list"}))
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        sync_search_index(tmp_path)
    m.assert_not_called()


def test_sync_happy_path_upserts_and_deletes_stale(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc_key")
    monkeypatch.setenv("SEARCH_INDEX_SYNC_BATCH", "50")
    (tmp_path / "search-index.json").write_text(json.dumps([
        ["220", "Half-Life 2", "gold", 5, 2, "steam"],
        ["10",  "Counter-Strike", "gold", 3, 0, "steam"],
        ["bogus-row"],           # dropped
        None,                    # dropped
    ]))

    upsert_resp = _fake_response(201)
    list_resp = MagicMock()
    list_resp.__enter__ = lambda self: self
    list_resp.__exit__ = lambda self, *a: None
    # DB has one extra stale row that the pipeline dropped.
    list_resp.read.return_value = json.dumps(
        [{"app_id": "220"}, {"app_id": "10"}, {"app_id": "stale-1"}]
    ).encode()
    delete_resp = _fake_response(204)

    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [upsert_resp, list_resp, delete_resp]
        sync_search_index(tmp_path)

    # Three network calls: one upsert POST, one list GET, one DELETE.
    assert m.call_count == 3
    upsert_call = m.call_args_list[0]
    assert upsert_call[0][0].method == "POST"
    delete_call = m.call_args_list[2]
    assert delete_call[0][0].method == "DELETE"
    assert "stale-1" in delete_call[0][0].full_url


def test_sync_upsert_failure_halts_before_delete(tmp_path, monkeypatch):
    from urllib.error import HTTPError
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc_key")
    (tmp_path / "search-index.json").write_text(json.dumps([
        ["220", "Half-Life 2", "gold", 5, 2, "steam"],
    ]))

    def raiser(*args, **kwargs):
        raise HTTPError("url", 500, "server error", {}, io.BytesIO(b"kaboom"))

    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen", side_effect=raiser) as m:
        sync_search_index(tmp_path)  # must NOT re-raise
    # Only the failed upsert attempt; no list/delete calls follow.
    assert m.call_count == 1


def test_sync_stale_delete_failure_is_non_fatal(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc_key")
    (tmp_path / "search-index.json").write_text(json.dumps([
        ["220", "Half-Life 2", "gold", 5, 2, "steam"],
    ]))
    upsert_resp = _fake_response(201)

    def fail_list_get(*args, **kwargs):
        raise Exception("connection reset")

    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        # First call (upsert) succeeds; second call (list for diff-delete) throws.
        m.side_effect = [upsert_resp, Exception("connection reset")]
        sync_search_index(tmp_path)  # must NOT raise
