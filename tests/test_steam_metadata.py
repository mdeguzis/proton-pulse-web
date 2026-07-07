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
# Real output is much larger; we keep only the fields the parser cares
# about so the test text stays readable.
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
                    "timeupdated"  "1700000000"
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
                    "timeupdated"  "1690000000"
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
                    "timeupdated"  "1710000000"
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
                    "timeupdated"  "1500000000"
                }
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
            "manifests" { "public" { "timeupdated" "1234" } }
        }
    }
}
'''
        parsed = steam_metadata.parse_app_info(text)
        rows = steam_metadata.extract_depot_rows(1, parsed)
        assert sorted(r.os for r in rows) == ["linux", "windows"]
        assert all(r.last_updated_at == 1234 for r in rows)

    def test_skips_depot_with_missing_or_zero_timestamp(self):
        text = '''
"1"
{
    "common" { "name" "NoTs" }
    "depots"
    {
        "10"
        {
            "config" { "oslist" "linux" }
            "manifests" { "public" { "timeupdated" "0" } }
        }
        "11"
        {
            "config" { "oslist" "linux" }
        }
    }
}
'''
        parsed = steam_metadata.parse_app_info(text)
        rows = steam_metadata.extract_depot_rows(1, parsed)
        assert rows == []

    def test_unknown_oslist_lands_in_other_bucket(self):
        text = '''
"1"
{
    "depots"
    {
        "10"
        {
            "config" { "oslist" "chromeos" }
            "manifests" { "public" { "timeupdated" "1000" } }
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


class TestFetchAndStoreOffline:
    def test_no_manifest_status_when_parse_yields_no_rows(self, monkeypatch):
        """fetch_and_store should mark the app as no_public_manifest when
        steamcmd returned something but parse produced zero rows -- and
        must NOT hit Supabase for depot upsert in that case."""
        monkeypatch.setattr(steam_metadata, "run_steamcmd_app_info", lambda app_id, **kw: "no appinfo here")
        upserts = []
        status_calls = []
        monkeypatch.setattr(steam_metadata, "upsert_depot_rows", lambda rows: upserts.append(list(rows)) or 0)
        monkeypatch.setattr(steam_metadata, "upsert_fetch_status", lambda app_id, status, depot_count, error=None: status_calls.append((app_id, status, depot_count, error)))
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
        monkeypatch.setattr(steam_metadata, "upsert_fetch_status", lambda app_id, status, depot_count, error=None: status_calls.append((app_id, status, error)))
        status, n = steam_metadata.fetch_and_store(1)
        assert status == "error"
        assert n == 0
        assert status_calls[0][0] == 1
        assert status_calls[0][1] == "error"
        assert "steamcmd missing" in status_calls[0][2]
