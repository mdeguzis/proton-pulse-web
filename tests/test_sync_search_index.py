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
    _list_existing,
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


# ---- _list_existing + _delete_stale -------------------------------------


def _json_response(payload):
    resp = MagicMock()
    resp.__enter__ = lambda self: self
    resp.__exit__ = lambda self, *a: None
    resp.read.return_value = json.dumps(payload).encode()
    return resp


@pytest.fixture
def no_floor(monkeypatch):
    # Most delete tests use a handful of rows; the real floor is 10k.
    monkeypatch.setattr("scripts.pipeline.sync_search_index.MIN_LIVE_ROWS", 0)


def test_list_existing_pages_past_the_postgrest_row_cap(monkeypatch):
    # #578: PostgREST returns at most max_rows per request. A full page means
    # there may be more, so the listing must continue from the last app_id.
    monkeypatch.setattr("scripts.pipeline.sync_search_index.LIST_PAGE_SIZE", 2)
    pages = [
        _json_response([{"app_id": "1", "source": "steam"}, {"app_id": "2", "source": "steam"}]),
        _json_response([{"app_id": "gog:3", "source": "gog"}, {"app_id": "pw_a", "source": "pgwiki"}]),
        _json_response([{"app_id": "pw_b", "source": "pgwiki"}]),
    ]
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen", side_effect=pages) as m:
        out = _list_existing("https://sb.example", "svc_key")
    assert out == {"1": "steam", "2": "steam", "gog:3": "gog", "pw_a": "pgwiki", "pw_b": "pgwiki"}
    urls = [c[0][0].full_url for c in m.call_args_list]
    assert "app_id=gt." not in urls[0]
    assert "order=app_id.asc" in urls[0]
    assert urls[1].endswith("app_id=gt.2")
    # The cursor is URL-quoted, so a gog: id cannot break the query string.
    assert urls[2].endswith("app_id=gt.pw_a")


def test_list_existing_quotes_the_cursor(monkeypatch):
    monkeypatch.setattr("scripts.pipeline.sync_search_index.LIST_PAGE_SIZE", 1)
    pages = [_json_response([{"app_id": "gog:3", "source": "gog"}]), _json_response([])]
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen", side_effect=pages) as m:
        _list_existing("https://sb.example", "svc_key")
    assert m.call_args_list[1][0][0].full_url.endswith("app_id=gt.gog%3A3")


def test_list_existing_raises_on_a_non_list_body():
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen",
               return_value=_json_response({"message": "nope"})):
        with pytest.raises(ValueError):
            _list_existing("https://sb.example", "svc_key")


def test_delete_stale_no_diff(no_floor):
    # Everything in DB is also live -> no DELETE fired.
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [_json_response([{"app_id": "220", "source": "steam"}, {"app_id": "440", "source": "steam"}])]
        deleted = _delete_stale("https://sb.example", "svc_key", {"220": "steam", "440": "steam"})
    assert deleted == 0
    assert m.call_count == 1  # only the listing


def test_delete_stale_batches_the_diff(no_floor):
    # DB has 220 + 440 + 999; live has 220 + 440 -> delete 999.
    listing = _json_response([
        {"app_id": "220", "source": "steam"}, {"app_id": "440", "source": "steam"},
        {"app_id": "999", "source": "steam"},
    ])
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [listing, _fake_response(204)]
        deleted = _delete_stale("https://sb.example", "svc_key", {"220": "steam", "440": "steam"})
    assert deleted == 1
    delete_req = m.call_args_list[1][0][0]
    assert delete_req.method == "DELETE"
    assert 'in.("999")' in delete_req.full_url


def test_delete_stale_sees_rows_beyond_the_first_page(no_floor, monkeypatch):
    # The #578 regression: the stale row sits on page 2. The old single
    # request never saw it.
    monkeypatch.setattr("scripts.pipeline.sync_search_index.LIST_PAGE_SIZE", 2)
    pages = [
        _json_response([{"app_id": "1", "source": "steam"}, {"app_id": "2", "source": "steam"}]),
        _json_response([{"app_id": "43129", "source": "steam"}]),
    ]
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = pages + [_fake_response(204)]
        deleted = _delete_stale("https://sb.example", "svc_key", {"1": "steam", "2": "steam"})
    assert deleted == 1
    assert "43129" in m.call_args_list[2][0][0].full_url


def test_delete_stale_refuses_below_the_live_floor(monkeypatch):
    # A broken run that produced a tiny index must not empty the search API.
    monkeypatch.setattr("scripts.pipeline.sync_search_index.MIN_LIVE_ROWS", 3)
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        deleted = _delete_stale("https://sb.example", "svc_key", {"1": "steam", "2": "steam"})
    assert deleted == 0
    m.assert_not_called()


def test_delete_stale_keeps_a_source_that_vanished(no_floor, monkeypatch, capsys):
    # #497 shape: PCGW stops answering, the catalog comes back empty, and
    # every pgwiki row disappears from the live index at once. Those rows are
    # kept; ordinary stale rows from other sources are still deleted.
    monkeypatch.setattr("scripts.pipeline.sync_search_index.MIN_SOURCE_ROWS", 2)
    listing = _json_response([
        {"app_id": "1", "source": "steam"}, {"app_id": "629", "source": "steam"},
        {"app_id": "pw_a", "source": "pgwiki"}, {"app_id": "pw_b", "source": "pgwiki"},
    ])
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [listing, _fake_response(204)]
        deleted = _delete_stale("https://sb.example", "svc_key", {"1": "steam"})
    assert deleted == 1
    url = m.call_args_list[1][0][0].full_url
    assert "629" in url and "pw_" not in url
    assert "source 'pgwiki' has 2 rows" in capsys.readouterr().err


def test_delete_stale_still_prunes_a_source_that_only_shrank(no_floor, monkeypatch):
    # One pgwiki row left live means the source is up; its other rows are
    # genuinely stale.
    monkeypatch.setattr("scripts.pipeline.sync_search_index.MIN_SOURCE_ROWS", 2)
    listing = _json_response([
        {"app_id": "pw_a", "source": "pgwiki"}, {"app_id": "pw_b", "source": "pgwiki"},
        {"app_id": "pw_c", "source": "pgwiki"},
    ])
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [listing, _fake_response(204)]
        deleted = _delete_stale("https://sb.example", "svc_key", {"pw_a": "pgwiki"})
    assert deleted == 2


def test_delete_stale_raises_on_a_failed_delete(no_floor):
    from urllib.error import HTTPError
    listing = _json_response([{"app_id": "1", "source": "steam"}, {"app_id": "2", "source": "steam"}])
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [listing, _fake_response(500)]
        with pytest.raises(HTTPError):
            _delete_stale("https://sb.example", "svc_key", {"1": "steam"})


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


def test_sync_happy_path_upserts_and_deletes_stale(tmp_path, monkeypatch, no_floor):
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
    list_resp.read.return_value = json.dumps([
        {"app_id": "220", "source": "steam"}, {"app_id": "10", "source": "steam"},
        {"app_id": "stale-1", "source": "steam"},
    ]).encode()
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


def test_sync_stale_delete_failure_is_non_fatal(tmp_path, monkeypatch, no_floor, capsys):
    from urllib.error import URLError
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc_key")
    (tmp_path / "search-index.json").write_text(json.dumps([
        ["220", "Half-Life 2", "gold", 5, 2, "steam"],
    ]))
    upsert_resp = _fake_response(201)

    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        # First call (upsert) succeeds; second call (list for diff-delete) throws.
        m.side_effect = [upsert_resp, URLError("connection reset")]
        sync_search_index(tmp_path)  # must NOT raise
    assert "ERROR: stale delete failed (URLError" in capsys.readouterr().err


def test_sync_logs_a_zero_delete(tmp_path, monkeypatch, no_floor, capsys):
    # #578 hid for months partly because a 0-row delete printed nothing.
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc_key")
    (tmp_path / "search-index.json").write_text(json.dumps([
        ["220", "Half-Life 2", "gold", 5, 2, "steam"],
    ]))
    listing = _json_response([{"app_id": "220", "source": "steam"}])
    with patch("scripts.pipeline.sync_search_index.urllib.request.urlopen") as m:
        m.side_effect = [_fake_response(201), listing]
        sync_search_index(tmp_path)
    assert "deleted 0 stale rows" in capsys.readouterr().err


# ── VR column (#246) ─────────────────────────────────────────────────────────

def test_row_to_dict_maps_the_vr_column():
    # Col 16 sits past anti-cheat (12-13) and PCGamingWiki (14-15).
    row = ["620980", "Beat Saber", "gold", 1, 0, "steam", 2019, None, False, "",
           None, "game", None, None, None, None, "only"]
    assert _row_to_dict(row)["vr"] == "only"


def test_row_to_dict_vr_is_null_on_a_short_row():
    # Most rows never reach col 16 -- an enricher only pads the ones it flags.
    row = ["730", "CS2", "gold", 5, 1, "steam"]
    assert _row_to_dict(row)["vr"] is None


def test_row_to_dict_drops_a_vr_value_the_db_would_reject():
    # search_index_vr_chk allows only 'supported' / 'only'. Coercing here keeps
    # one hand-edited row from failing the whole batch upsert.
    row = ["1", "T", "gold", 0, 0, "steam", None, None, False, "",
           None, None, None, None, None, None, "bogus"]
    assert _row_to_dict(row)["vr"] is None


def test_row_to_dict_normalizes_vr_case_and_whitespace():
    row = ["1", "T", "gold", 0, 0, "steam", None, None, False, "",
           None, None, None, None, None, None, "  ONLY  "]
    assert _row_to_dict(row)["vr"] == "only"


def test_vr_is_in_the_synced_column_list():
    from scripts.pipeline.sync_search_index import COLUMNS
    assert "vr" in COLUMNS
