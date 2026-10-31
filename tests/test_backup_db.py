"""Tests for the encrypted full database backup (#580): scripts/backup_db.py
dumps, scripts/restore_db.py loads. The Management API is replaced by a fake
query function; nothing here touches Supabase."""

import hashlib
import io
import json
import re
import urllib.error
from pathlib import Path

import pytest

from scripts import backup_db, restore_db
from scripts.backup_db import (
    AUTH_TABLES,
    dump_table,
    list_tables,
    make_query,
    qualified,
    table_info,
    write_backup,
)
from scripts.restore_db import (
    RestoreError,
    insert_sql,
    load_manifest,
    ordered_tables,
    restore,
)


# ---- fake Management API ---------------------------------------------------

class FakeDb:
    """Answers the handful of query shapes backup_db sends."""

    def __init__(self, tables):
        # tables: {"public.x": {"columns": [...], "pk": [...], "generated": [...], "rows": [...]}}
        self.tables = tables
        self.sql = []

    def __call__(self, sql):
        self.sql.append(sql)
        if "information_schema.tables" in sql:
            return [{"name": n} for n in sorted(self.tables) if n.startswith("public.")]
        m = re.search(r"n\.nspname = '([^']+)' and c\.relname = '([^']+)'", sql)
        if m:
            t = self.tables[f"{m[1]}.{m[2]}"]
            return [{"col": c, "pk": c in t.get("pk", []), "generated": c in t.get("generated", [])}
                    for c in t["columns"]]
        m = re.search(r'from "([^"]+)"\."([^"]+)" order by .* limit (\d+) offset (\d+)', sql)
        if m:
            rows = self.tables[f"{m[1]}.{m[2]}"]["rows"]
            limit, offset = int(m[3]), int(m[4])
            return [{"rows": rows[offset:offset + limit]}]
        raise AssertionError(f"unexpected sql: {sql[:120]}")


def _db():
    return FakeDb({
        "public.report_votes": {"columns": ["voter_id", "app_id", "vote"], "pk": ["voter_id", "app_id"],
                                "rows": [{"voter_id": "a", "app_id": "1", "vote": 1},
                                         {"voter_id": "b", "app_id": "1", "vote": -1}]},
        "public.search_index": {"columns": ["app_id"], "pk": ["app_id"], "rows": [{"app_id": "1"}]},
        "public.user_systems": {"columns": ["user_id", "cpu"], "rows": [{"user_id": "u", "cpu": "x"}]},
        "auth.users": {"columns": ["id", "email", "confirmed_at"], "pk": ["id"], "generated": ["confirmed_at"],
                       "rows": [{"id": "u", "email": "e@example.com", "confirmed_at": None}]},
        "auth.identities": {"columns": ["id", "user_id"], "pk": ["id"], "rows": []},
    })


# ---- backup_db ---------------------------------------------------------------

def test_qualified_quotes_both_parts():
    assert qualified("public.report_votes") == '"public"."report_votes"'
    assert qualified('public.we"ird') == '"public"."we""ird"'


def test_list_tables_skips_search_index_and_appends_auth():
    names = list_tables(_db())
    assert "public.search_index" not in names
    assert names[-2:] == list(AUTH_TABLES)
    assert "public.report_votes" in names


def test_list_tables_refuses_an_empty_listing():
    with pytest.raises(RuntimeError, match="no public tables"):
        list_tables(lambda sql: [])


def test_table_info_reports_pk_and_generated_columns():
    info = table_info(_db(), "auth.users")
    assert info == {"columns": ["id", "email", "confirmed_at"], "primary_key": ["id"],
                    "generated": ["confirmed_at"]}


def test_table_info_raises_for_a_missing_table():
    with pytest.raises(RuntimeError, match="no columns"):
        table_info(lambda sql: [], "public.gone")


def test_dump_table_pages_until_a_short_page():
    db = _db()
    rows = dump_table(db, "public.report_votes", table_info(db, "public.report_votes"), page_size=1)
    assert [r["voter_id"] for r in rows] == ["a", "b"]
    selects = [s for s in db.sql if "json_agg" in s]
    assert len(selects) == 3  # 1, 1, then an empty page
    assert 'order by "voter_id", "app_id"' in selects[0]


def test_dump_table_orders_by_every_column_without_a_pk():
    db = _db()
    dump_table(db, "public.user_systems", table_info(db, "public.user_systems"))
    assert 'order by "user_id", "cpu"' in [s for s in db.sql if "json_agg" in s][0]


def test_write_backup_writes_tables_and_a_hashed_manifest(tmp_path):
    manifest = write_backup(_db(), tmp_path, "ref123")
    assert manifest["project_ref"] == "ref123"
    assert manifest["excluded"] == ["public.search_index"]
    votes = tmp_path / "tables" / "public.report_votes.json"
    assert json.loads(votes.read_text())[0]["voter_id"] == "a"
    meta = manifest["tables"]["public.report_votes"]
    assert meta["rows"] == 2
    assert meta["sha256"] == hashlib.sha256(votes.read_bytes()).hexdigest()
    assert json.loads((tmp_path / "manifest.json").read_text()) == manifest


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http_error(code, body=b""):
    return urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(body))


def test_make_query_posts_the_sql_with_the_token():
    seen = []

    def opener(req, timeout=None):
        seen.append(req)
        return _Resp(b'[{"n": 1}]')

    assert make_query("tok", "ref", opener)("select 1") == [{"n": 1}]
    assert seen[0].full_url.endswith("/projects/ref/database/query")
    assert seen[0].headers["Authorization"] == "Bearer tok"
    assert json.loads(seen[0].data) == {"query": "select 1"}


def test_make_query_raises_with_the_postgres_message_on_4xx():
    def opener(req, timeout=None):
        raise _http_error(400, b'{"message":"relation does not exist"}')

    with pytest.raises(RuntimeError, match="relation does not exist"):
        make_query("tok", "ref", opener)("select 1")


def test_make_query_retries_transport_errors_and_5xx(monkeypatch):
    monkeypatch.setattr(backup_db.time, "sleep", lambda s: None)
    answers = [urllib.error.URLError("reset"), _http_error(502)]

    def opener(req, timeout=None):
        if answers:
            raise answers.pop(0)
        return _Resp(b"[]")

    assert make_query("tok", "ref", opener)("select 1") == []


def test_make_query_gives_up_after_the_last_retry(monkeypatch):
    monkeypatch.setattr(backup_db.time, "sleep", lambda s: None)

    def opener(req, timeout=None):
        raise urllib.error.URLError("down")

    with pytest.raises(urllib.error.URLError):
        make_query("tok", "ref", opener)("select 1")

    def opener5xx(req, timeout=None):
        raise _http_error(503)

    with pytest.raises(urllib.error.HTTPError):
        make_query("tok", "ref", opener5xx)("select 1")


def test_make_query_raises_on_a_non_list_answer():
    with pytest.raises(RuntimeError, match="query failed"):
        make_query("tok", "ref", lambda req, timeout=None: _Resp(b'{"message": "no"}'))("select 1")


def test_backup_main_needs_a_token(monkeypatch, tmp_path):
    monkeypatch.delenv("SUPABASE_TOKEN", raising=False)
    assert backup_db.main(["--out", str(tmp_path)]) == 2


def test_backup_main_writes_a_backup(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPABASE_TOKEN", "tok")
    monkeypatch.setattr(backup_db, "make_query", lambda token, ref: _db())
    assert backup_db.main(["--out", str(tmp_path / "out")]) == 0
    assert (tmp_path / "out" / "manifest.json").exists()


# ---- restore_db --------------------------------------------------------------

@pytest.fixture
def dump(tmp_path):
    write_backup(_db(), tmp_path / "dump", "ref")
    return tmp_path / "dump"


def test_load_manifest_accepts_an_intact_dump(dump):
    assert "public.report_votes" in load_manifest(dump)["tables"]


def test_load_manifest_rejects_an_altered_table(dump):
    (dump / "tables" / "public.report_votes.json").write_text("[]")
    with pytest.raises(RestoreError, match="sha256"):
        load_manifest(dump)


def test_load_manifest_rejects_an_unknown_format(dump):
    m = json.loads((dump / "manifest.json").read_text())
    m["format"] = 2
    (dump / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(RestoreError, match="format"):
        load_manifest(dump)


def test_ordered_tables_puts_auth_first(dump):
    names = ordered_tables(load_manifest(dump))
    assert names[:2] == ["auth.identities", "auth.users"]


def test_insert_sql_skips_generated_columns_and_disables_triggers():
    sql = insert_sql("auth.users", {"columns": ["id", "email", "confirmed_at"], "generated": ["confirmed_at"]},
                     [{"id": "u", "email": "e"}])
    assert "set local session_replication_role = replica;" in sql
    assert 'insert into "auth"."users" ("id", "email") overriding system value' in sql
    assert "confirmed_at" not in sql.split("json_populate_recordset")[0]
    tag = re.search(r"\$(pp[0-9a-f]+)\$", sql)[1]
    assert sql.count(f"${tag}$") == 2
    assert sql.startswith("begin;") and sql.endswith("commit;")


class RestoreDb:
    def __init__(self, counts=None):
        self.sql = []
        self.counts = counts or {}

    def __call__(self, sql):
        self.sql.append(sql)
        m = re.search(r'select count\(\*\) as n from "([^"]+)"\."([^"]+)"', sql)
        if m:
            return [{"n": self.counts.get(f"{m[1]}.{m[2]}", 0)}]
        return []


def test_restore_loads_in_batches_resets_sequences_and_checks_counts(dump):
    manifest = load_manifest(dump)
    db = RestoreDb({n: t["rows"] for n, t in manifest["tables"].items()})
    assert restore(db, dump, batch_rows=1) == {}
    inserts = [s for s in db.sql if s.startswith("begin;")]
    assert len(inserts) == 4  # 2 votes + 1 user + 1 user_systems; empty identities sends none
    assert inserts[0].count('"auth"."users"') == 2
    assert any("setval" in s for s in db.sql)


def test_restore_reports_count_mismatches(dump):
    db = RestoreDb({"public.report_votes": 1})
    mismatched = restore(db, dump)
    assert mismatched["public.report_votes"] == (2, 1)


def test_restore_main_refuses_prod_without_the_flag(monkeypatch, dump):
    monkeypatch.setenv("SUPABASE_TOKEN", "tok")
    assert restore_db.main(["--project-ref", backup_db.DEFAULT_PROJECT_REF, "--dir", str(dump)]) == 2


def test_restore_main_needs_identity_with_backup(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPABASE_TOKEN", "tok")
    assert restore_db.main(["--project-ref", "scratch", "--backup", str(tmp_path / "x.age")]) == 2


def test_restore_main_needs_a_token(monkeypatch, dump):
    monkeypatch.delenv("SUPABASE_TOKEN", raising=False)
    assert restore_db.main(["--project-ref", "scratch", "--dir", str(dump)]) == 2


def test_restore_main_exit_code_follows_the_count_check(monkeypatch, dump):
    monkeypatch.setenv("SUPABASE_TOKEN", "tok")
    manifest = load_manifest(dump)
    good = RestoreDb({n: t["rows"] for n, t in manifest["tables"].items()})
    monkeypatch.setattr(restore_db, "make_query", lambda token, ref: good)
    assert restore_db.main(["--project-ref", "scratch", "--dir", str(dump)]) == 0
    monkeypatch.setattr(restore_db, "make_query", lambda token, ref: RestoreDb())
    assert restore_db.main(["--project-ref", "scratch", "--dir", str(dump)]) == 1


def test_decrypt_unpacks_an_age_file(monkeypatch, tmp_path, dump):
    # Stand in for `age -d`: the "encrypted" file is a plain tarball here.
    import tarfile
    src = tmp_path / "plain.tar.gz"
    with tarfile.open(src, "w:gz") as tar:
        tar.add(dump, arcname=".")

    def fake_run(cmd, check):
        assert cmd[:4] == ["age", "-d", "-i", "key"]
        Path(cmd[5]).write_bytes(src.read_bytes())

    monkeypatch.setattr(restore_db.subprocess, "run", fake_run)
    work = tmp_path / "work"
    work.mkdir()
    out = restore_db.decrypt(Path("x.age"), Path("key"), work)
    assert load_manifest(out)["tables"]["public.report_votes"]["rows"] == 2
    assert not (work / "db.tar.gz").exists()
