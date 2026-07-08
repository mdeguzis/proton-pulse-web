"""Tests for scripts/pipeline/steam_metadata.py.

The KV parser + depot extractor are pure functions, so the tests hit
them directly with representative steamcmd output snippets. steamcmd
itself is stubbed via subprocess monkeypatch when we exercise the
runner path.
"""
from __future__ import annotations

import pytest

from scripts.pipeline import steam_metadata


# A trimmed but realistic steamcmd `+app_info_print 367520` payload.
# Shape mirrors what SteamKit / ValvePython/steam / patchforge parse:
#   depots.<depotId>.config.oslist          -> which OS the depot ships
#   depots.<depotId>.manifests.public.gid   -> current manifest id
#   depots.branches.public.timeupdated      -> app-level last-update ts
# Individual depots do not carry a per-depot timeupdated in real PICS
# app_info output; the branch-level value is what SteamDB surfaces on
# its Depot page's Last Update column. Our first seed run against
# Hollow Knight taught us this the hard way (parser returned 0 rows).
SAMPLE_APPINFO = '''\
Loading Steam API...OK
Waiting for user info...OK
AppID : 367520, change number : 12345678
"367520"
{
    "common"
    {
        "name"       "Hollow Knight"
        "type"       "game"
    }
    "depots"
    {
        "367521"
        {
            "name"     "Hollow Knight Windows"
            "config"
            {
                "oslist"   "windows"
            }
            "manifests"
            {
                "public"
                {
                    "gid"          "9876543210"
                }
            }
        }
        "367522"
        {
            "name"     "Hollow Knight macOS"
            "config"
            {
                "oslist"   "macos"
            }
            "manifests"
            {
                "public"
                {
                    "gid"          "9876543211"
                }
            }
        }
        "367523"
        {
            "name"     "Hollow Knight Linux"
            "config"
            {
                "oslist"   "linux"
            }
            "manifests"
            {
                "public"
                {
                    "gid"          "9876543212"
                }
            }
        }
        "367524"
        {
            "name"     "Shared assets"
            "manifests"
            {
                "public"
                {
                    "gid"          "9876543213"
                }
            }
        }
        "branches"
        {
            "public"
            {
                "buildid"      "12345678"
                "timeupdated"  "1710000000"
            }
        }
    }
}
'''


class TestParser:
    def test_parses_realistic_appinfo_block(self):
        parsed = steam_metadata.parse_app_info(SAMPLE_APPINFO)
        assert parsed is not None
        assert parsed["common"]["name"] == "Hollow Knight"
        assert "367521" in parsed["depots"]

    def test_returns_none_when_no_appid_header(self):
        # steamcmd sometimes prints a login banner and nothing else.
        assert steam_metadata.parse_app_info("Loading Steam API...OK\nWaiting for user info...OK\n") is None

    def test_handles_inline_comments(self):
        text = '''
"1"
{
    // this line is a comment
    "common" { "name" "Test" }
    "depots" { }
}
'''
        parsed = steam_metadata.parse_app_info(text)
        assert parsed is not None
        assert parsed["common"]["name"] == "Test"


class TestExtractDepotRows:
    def test_produces_one_row_per_supported_os(self):
        parsed = steam_metadata.parse_app_info(SAMPLE_APPINFO)
        rows = steam_metadata.extract_depot_rows(367520, parsed)
        # Three OS-bound depots -> three rows; the shared-assets depot has
        # no oslist and is skipped.
        oses = sorted(r.os for r in rows)
        assert oses == ["linux", "mac", "windows"]

    def test_normalizes_macos_alias_to_mac(self):
        parsed = steam_metadata.parse_app_info(SAMPLE_APPINFO)
        rows = steam_metadata.extract_depot_rows(367520, parsed)
        mac = next(r for r in rows if r.os == "mac")
        assert mac.depot_id == 367522

    def test_carries_manifest_id_and_last_updated(self):
        parsed = steam_metadata.parse_app_info(SAMPLE_APPINFO)
        rows = steam_metadata.extract_depot_rows(367520, parsed)
        linux = next(r for r in rows if r.os == "linux")
        assert linux.last_updated_at == 1710000000
        assert linux.manifest_id == "9876543212"
        # depot name falls back to common.name only for depots that omit
        # their own; ours all have one.
        assert linux.name == "Hollow Knight Linux"

    def test_multi_os_depot_expands_to_one_row_per_os(self):
        text = '''
"1"
{
    "common" { "name" "MultiOS" }
    "depots"
    {
        "10"
        {
            "config" { "oslist" "windows,linux" }
            "manifests" { "public" { "gid" "111" } }
        }
        "branches"
        {
            "public" { "buildid" "1" "timeupdated" "1234" }
        }
    }
}
'''
        parsed = steam_metadata.parse_app_info(text)
        rows = steam_metadata.extract_depot_rows(1, parsed)
        assert sorted(r.os for r in rows) == ["linux", "windows"]
        assert all(r.last_updated_at == 1234 for r in rows)

    def test_skips_depot_when_no_branch_timestamp_and_no_manifest_timestamp(self):
        # Neither the branch (missing) nor the per-depot manifest carry a
        # timestamp -> nothing to record. Matches the earlier zero-ts
        # skip but reframed for the new "branch-first" fallback order.
        text = '''
"1"
{
    "common" { "name" "NoTs" }
    "depots"
    {
        "10"
        {
            "config" { "oslist" "linux" }
            "manifests" { "public" { "gid" "abc" } }
        }
    }
}
'''
        parsed = steam_metadata.parse_app_info(text)
        rows = steam_metadata.extract_depot_rows(1, parsed)
        assert rows == []

    def test_per_depot_manifest_timestamp_wins_over_branch(self):
        # Rare shape: some apps carry a per-depot manifests.public
        # .timeupdated. When present, we prefer it over the branch value.
        text = '''
"1"
{
    "common" { "name" "PerDepot" }
    "depots"
    {
        "10"
        {
            "config" { "oslist" "linux" }
            "manifests" { "public" { "gid" "abc" "timeupdated" "5000" } }
        }
        "branches"
        {
            "public" { "buildid" "1" "timeupdated" "1000" }
        }
    }
}
'''
        parsed = steam_metadata.parse_app_info(text)
        rows = steam_metadata.extract_depot_rows(1, parsed)
        assert len(rows) == 1
        assert rows[0].last_updated_at == 5000

    def test_unknown_oslist_lands_in_other_bucket(self):
        text = '''
"1"
{
    "depots"
    {
        "10"
        {
            "config" { "oslist" "chromeos" }
            "manifests" { "public" { "gid" "abc" } }
        }
        "branches"
        {
            "public" { "buildid" "1" "timeupdated" "1000" }
        }
    }
}
'''
        parsed = steam_metadata.parse_app_info(text)
        rows = steam_metadata.extract_depot_rows(1, parsed)
        assert len(rows) == 1
        assert rows[0].os == "other"


class TestRunnerAvailability:
    def test_reports_missing_binary(self, monkeypatch):
        monkeypatch.setenv("STEAMCMD_BINARY", "/definitely/not/here/steamcmd")
        # Re-import to pick up the env override.
        import importlib
        importlib.reload(steam_metadata)
        assert steam_metadata.steamcmd_available() is False


class TestRunnerCommandShape:
    """Regression guards on the steamcmd command line. PR #220 added
    +app_info_request + +delay so a fresh runner actually pulls PICS
    instead of reading the empty local cache. If any of these tokens
    go missing the seed silently degrades to 'nothing to parse'."""

    def _captured_cmd(self, monkeypatch, app_id=367520):
        captured = {}
        class FakeProc:
            returncode = 0; stdout = ""; stderr = ""
        def fake_run(cmd, **kw):
            captured["cmd"] = cmd
            captured["kw"] = kw
            return FakeProc()
        monkeypatch.setattr(steam_metadata.shutil, "which", lambda name: "/fake/steamcmd")
        monkeypatch.setattr(steam_metadata.subprocess, "run", fake_run)
        steam_metadata.run_steamcmd_app_info(app_id)
        return captured

    def test_uses_anonymous_login(self, monkeypatch):
        cmd = self._captured_cmd(monkeypatch)["cmd"]
        assert cmd[cmd.index("+login") + 1] == "anonymous"

    def test_calls_app_info_request_before_print(self, monkeypatch):
        cmd = self._captured_cmd(monkeypatch)["cmd"]
        assert "+app_info_request" in cmd
        assert "+app_info_print"   in cmd
        assert cmd.index("+app_info_request") < cmd.index("+app_info_print")

    def test_carries_delay_between_request_and_print(self, monkeypatch):
        cmd = self._captured_cmd(monkeypatch)["cmd"]
        assert "+delay" in cmd
        delay = int(cmd[cmd.index("+delay") + 1])
        assert delay >= 1

    def test_refreshes_app_info_cache(self, monkeypatch):
        cmd = self._captured_cmd(monkeypatch)["cmd"]
        assert "+app_info_update" in cmd
        assert cmd[cmd.index("+app_info_update") + 1] == "1"

    def test_ends_with_quit(self, monkeypatch):
        cmd = self._captured_cmd(monkeypatch)["cmd"]
        assert cmd[-1] == "+quit"

    def test_passes_appid_to_both_request_and_print(self, monkeypatch):
        cmd = self._captured_cmd(monkeypatch, app_id=1234)["cmd"]
        assert cmd[cmd.index("+app_info_request") + 1] == "1234"
        assert cmd[cmd.index("+app_info_print")   + 1] == "1234"

    def test_timeout_kwarg_is_passed_to_subprocess(self, monkeypatch):
        kw = self._captured_cmd(monkeypatch)["kw"]
        assert "timeout" in kw
        assert kw["timeout"] > 0


class TestNoManifestDiagnostics:
    """Failed seed runs must land a useful reason in fetch_status.error
    AND log enough context that we do not need to re-run the workflow
    to debug the shape of what PICS returned."""

    def _run(self, monkeypatch, fake_stdout):
        monkeypatch.setattr(steam_metadata, "run_steamcmd_app_info", lambda app_id, **kw: fake_stdout)
        status_calls, log_calls = [], []
        monkeypatch.setattr(steam_metadata, "upsert_fetch_status",
            lambda app_id, status, depot_count, error=None, raw_pics=None: status_calls.append((app_id, status, depot_count, error, raw_pics)))
        monkeypatch.setattr(steam_metadata, "upsert_depot_rows", lambda rows: 0)
        monkeypatch.setattr(steam_metadata, "log", lambda msg: log_calls.append(msg))
        status, n = steam_metadata.fetch_and_store(367520)
        return status, n, status_calls, log_calls

    def test_no_appinfo_block_logs_tail_and_reason(self, monkeypatch):
        status, n, calls, logs = self._run(monkeypatch, "Loading Steam API...OK\n(no appinfo followed)\n")
        assert (status, n) == ("no_public_manifest", 0)
        assert calls[0][3] and "appinfo" in calls[0][3].lower()
        # tail must be logged so a workflow log reader sees the stdout end
        assert any("tail=" in m for m in logs)

    def test_parsed_but_zero_rows_dumps_first_depot_shape(self, monkeypatch):
        # Parse succeeds (appinfo block + digit-keyed depot present) but
        # extract_depot_rows returns []. The dump MUST include the depot
        # key list AND a JSON shape sample so a future PICS field-name
        # mismatch is self-diagnosing.
        text = '''
"367520"
{
    "common" { "name" "Sample" }
    "depots"
    {
        "10"
        {
            "MysteryField" "PICS may nest differently than we assume"
        }
    }
}
'''
        status, n, calls, logs = self._run(monkeypatch, text)
        assert (status, n) == ("no_public_manifest", 0)
        assert calls[0][3] and "no OS-bound depot rows" in calls[0][3]
        joined = " ".join(logs)
        assert "sample_depot=10" in joined
        assert "MysteryField"  in joined


class TestFetchAndStoreOffline:
    def test_no_manifest_status_when_parse_yields_no_rows(self, monkeypatch):
        """fetch_and_store should mark the app as no_public_manifest when
        steamcmd returned something but parse produced zero rows -- and
        must NOT hit Supabase for depot upsert in that case."""
        monkeypatch.setattr(steam_metadata, "run_steamcmd_app_info", lambda app_id, **kw: "no appinfo here")
        upserts = []
        status_calls = []
        monkeypatch.setattr(steam_metadata, "upsert_depot_rows", lambda rows: upserts.append(list(rows)) or 0)
        monkeypatch.setattr(steam_metadata, "upsert_fetch_status", lambda app_id, status, depot_count, error=None, raw_pics=None: status_calls.append((app_id, status, depot_count, error)))
        status, n = steam_metadata.fetch_and_store(1)
        assert status == "no_public_manifest"
        assert n == 0
        assert upserts == []
        # Error column now carries a short reason string so a workflow log
        # reader can tell 'no appinfo block' apart from 'parsed but no
        # OS-bound depots'.
        assert len(status_calls) == 1
        app_id, name, count, reason = status_calls[0]
        assert (app_id, name, count) == (1, "no_public_manifest", 0)
        assert reason and ("appinfo" in reason.lower() or "depot" in reason.lower())

    def test_error_status_when_steamcmd_raises(self, monkeypatch):
        def boom(*a, **kw):
            raise RuntimeError("steamcmd missing")
        monkeypatch.setattr(steam_metadata, "run_steamcmd_app_info", boom)
        status_calls = []
        monkeypatch.setattr(steam_metadata, "upsert_fetch_status", lambda app_id, status, depot_count, error=None, raw_pics=None: status_calls.append((app_id, status, error)))
        status, n = steam_metadata.fetch_and_store(1)
        assert status == "error"
        assert n == 0
        assert status_calls[0][0] == 1
        assert status_calls[0][1] == "error"
        assert "steamcmd missing" in status_calls[0][2]

    def test_ok_run_persists_raw_pics_on_fetch_status(self, monkeypatch):
        """#237: on a successful fetch, upsert_fetch_status must receive the
        full parsed depots dict so downstream stages can emit depots.json
        without a second PICS round-trip."""
        monkeypatch.setattr(steam_metadata, "run_steamcmd_app_info", lambda app_id, **kw: "ignored -- parse is mocked below")
        parsed_fixture = {
            "depots": {
                "10": {
                    "config": {"oslist": "linux"},
                    "manifests": {"public": {"gid": "1", "timeupdated": "1700000000"}},
                },
                "branches": {"public": {"buildid": "12", "timeupdated": "1700000000"}},
            },
        }
        monkeypatch.setattr(steam_metadata, "parse_app_info", lambda raw: parsed_fixture)
        # Return one row so extract_depot_rows short-circuits us into the ok path.
        monkeypatch.setattr(steam_metadata, "extract_depot_rows",
                            lambda app_id, parsed: [steam_metadata.DepotRow(
                                app_id=app_id, depot_id=10, os="linux",
                                name="linux", manifest_id="1", last_updated_at=1700000000)])
        monkeypatch.setattr(steam_metadata, "upsert_depot_rows", lambda rows: 1)
        status_calls = []
        monkeypatch.setattr(steam_metadata, "upsert_fetch_status",
                            lambda app_id, status, depot_count, error=None, raw_pics=None:
                                status_calls.append({"status": status, "raw_pics": raw_pics}))
        status, n = steam_metadata.fetch_and_store(367520)
        assert status == "ok" and n == 1
        assert len(status_calls) == 1
        # raw_pics is passed as the parsed depots dict verbatim.
        assert status_calls[0]["raw_pics"] == parsed_fixture["depots"]
        assert status_calls[0]["raw_pics"]["branches"]["public"]["buildid"] == "12"


class TestManifestHistoryWriter:
    """Phase 2 (#226) tests: the same rows that go into steam_depot_updates
    must also be fed into steam_depot_manifest_history so per-OS First
    seen / Last update stop being duplicative branch-level values.

    Contract we lock down:
      * upsert_manifest_history_rows drops depot rows without a manifest_id
        (history is keyed on manifest_id; a row without it cannot carry
        change history).
      * The POST target uses the correct on_conflict PK.
      * fetch_and_store calls the history writer AFTER upsert_depot_rows.
      * A failing history write does NOT flip the outcome to 'error'; the
        primary depot_updates write is durable and history is a strict
        enhancement (per the module comment).
    """

    def _mkrow(self, os_key, manifest_id, depot_id=100, ts=1710000000):
        return steam_metadata.DepotRow(
            app_id=1, depot_id=depot_id, os=os_key,
            name=None, manifest_id=manifest_id, last_updated_at=ts,
        )

    def test_skips_rows_without_manifest_id(self, monkeypatch):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["body"] = req.data
            class _R:
                def read(self): return b""
            return _R()
        monkeypatch.setattr(steam_metadata.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "srv")

        rows = [
            self._mkrow("linux",  None),                # dropped: no manifest_id
            self._mkrow("windows", "abc"),
            self._mkrow("mac",     ""),                 # dropped: empty manifest_id
        ]
        n = steam_metadata.upsert_manifest_history_rows(rows)
        assert n == 1
        import json as _j
        body = _j.loads(captured["body"])
        assert len(body) == 1
        assert body[0]["os"] == "windows"
        assert body[0]["manifest_id"] == "abc"

    def test_upsert_url_uses_composite_pk_on_conflict(self, monkeypatch):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            class _R:
                def read(self): return b""
            return _R()
        monkeypatch.setattr(steam_metadata.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "srv")

        steam_metadata.upsert_manifest_history_rows([self._mkrow("linux", "abc")])
        # Composite PK matches the migration; anything else and Postgres
        # rejects the upsert.
        assert "steam_depot_manifest_history" in captured["url"]
        assert "on_conflict=app_id,depot_id,os,manifest_id" in captured["url"]

    def test_returns_zero_and_skips_post_when_all_rows_lack_manifest_id(self, monkeypatch):
        calls = []
        def fake_urlopen(req, timeout=None):
            calls.append(req.full_url)
            class _R:
                def read(self): return b""
            return _R()
        monkeypatch.setattr(steam_metadata.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "srv")

        n = steam_metadata.upsert_manifest_history_rows([self._mkrow("linux", None)])
        assert n == 0
        assert calls == []  # no network call when payload is empty

    def test_fetch_and_store_calls_history_writer_after_depot_upsert(self, monkeypatch):
        # Verifies the sequencing: depot_updates first (the durable write),
        # history second (the enhancement).
        rows = [self._mkrow("linux", "abc", depot_id=42)]

        order = []
        parsed = {"depots": {"42": {"config": {"oslist": "linux"},
                                    "manifests": {"public": {"gid": "abc"}}},
                              "branches": {"public": {"timeupdated": "1710000000"}}}}
        monkeypatch.setattr(steam_metadata, "run_steamcmd_app_info", lambda app_id, **kw: "dummy")
        monkeypatch.setattr(steam_metadata, "parse_app_info", lambda text: parsed)
        monkeypatch.setattr(steam_metadata, "extract_depot_rows", lambda app_id, p: rows)
        monkeypatch.setattr(steam_metadata, "upsert_depot_rows",
            lambda r: order.append("depot") or len(list(r)))
        monkeypatch.setattr(steam_metadata, "upsert_manifest_history_rows",
            lambda r: order.append("history") or len(list(r)))
        monkeypatch.setattr(steam_metadata, "upsert_fetch_status",
            lambda app_id, status, count, error=None, raw_pics=None: order.append(f"status={status}"))
        monkeypatch.setattr(steam_metadata, "log", lambda msg: None)

        status, n = steam_metadata.fetch_and_store(1)
        assert status == "ok"
        # depot write happens before history; final status flip last
        assert order == ["depot", "history", "status=ok"]

    def test_history_write_failure_does_not_flip_status_to_error(self, monkeypatch):
        # Enhancement layer must never mask the durable primary write.
        rows = [self._mkrow("linux", "abc")]
        parsed = {"depots": {}}
        monkeypatch.setattr(steam_metadata, "run_steamcmd_app_info", lambda app_id, **kw: "dummy")
        monkeypatch.setattr(steam_metadata, "parse_app_info", lambda text: parsed)
        monkeypatch.setattr(steam_metadata, "extract_depot_rows", lambda app_id, p: rows)
        monkeypatch.setattr(steam_metadata, "upsert_depot_rows", lambda r: len(list(r)))
        def boom(_):
            raise RuntimeError("history table down")
        monkeypatch.setattr(steam_metadata, "upsert_manifest_history_rows", boom)
        status_calls = []
        monkeypatch.setattr(steam_metadata, "upsert_fetch_status",
            lambda app_id, status, count, error=None, raw_pics=None: status_calls.append((status, error)))
        logs = []
        monkeypatch.setattr(steam_metadata, "log", lambda msg: logs.append(msg))

        status, n = steam_metadata.fetch_and_store(1)
        assert status == "ok"
        assert status_calls[-1][0] == "ok"
        # But the failure must be logged so we can diagnose
        assert any("history upsert failed" in m for m in logs)
