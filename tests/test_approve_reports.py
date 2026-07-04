"""Tests for scripts/pipeline/approve_reports.py (auto-approval hashing)."""

import hashlib
import json
from unittest.mock import patch, MagicMock

from scripts.pipeline import approve_reports as ar


def _resp(payload):
    """A urlopen() context-manager stub whose read() returns JSON bytes."""
    cm = MagicMock()
    cm.__enter__.return_value.read.return_value = json.dumps(payload).encode("utf-8")
    cm.__exit__.return_value = False
    return cm


def test_compute_approval_hash_is_pipe_joined_md5():
    report = {
        "app_id": "730", "client_id": "abc", "rating": "platinum",
        "notes": "runs great", "os": "SteamOS", "gpu": "Custom APU",
        "created_at": "2026-01-01T00:00:00Z",
    }
    raw = "730|abc|platinum|runs great|SteamOS|Custom APU|2026-01-01T00:00:00Z"
    assert ar.compute_approval_hash(report) == hashlib.md5(raw.encode("utf-8")).hexdigest()


def test_compute_approval_hash_defaults_missing_fields_to_empty():
    # Missing fields become '' so the hash is stable and never KeyErrors.
    h = ar.compute_approval_hash({"app_id": "730"})
    raw = "|".join(["730"] + [""] * 6)  # app_id then 6 empty fields
    assert h == hashlib.md5(raw.encode("utf-8")).hexdigest()


def test_fetch_pending_reports_returns_only_hash_mismatches():
    reports = [
        {"id": 1, "app_id": "730", "client_id": "a", "rating": "gold",
         "notes": "", "os": "", "gpu": "", "created_at": "2026-01-01"},
        {"id": 2, "app_id": "570", "client_id": "b", "rating": "silver",
         "notes": "", "os": "", "gpu": "", "created_at": "2026-01-02"},
    ]
    # Report 1 already has a matching approval hash; report 2 has none.
    approvals = [{"report_id": 1, "approval_hash": ar.compute_approval_hash(reports[0])}]

    with patch("urllib.request.urlopen", side_effect=[_resp(reports), _resp(approvals)]):
        pending = ar.fetch_pending_reports()

    ids = [r["id"] for r, _ in pending]
    assert ids == [2]
    assert pending[0][1] == ar.compute_approval_hash(reports[1])


def test_fetch_pending_reports_flags_stale_hash():
    reports = [{"id": 1, "app_id": "730", "client_id": "a", "rating": "gold",
                "notes": "edited", "os": "", "gpu": "", "created_at": "2026-01-01"}]
    approvals = [{"report_id": 1, "approval_hash": "STALE_DOES_NOT_MATCH"}]

    with patch("urllib.request.urlopen", side_effect=[_resp(reports), _resp(approvals)]):
        pending = ar.fetch_pending_reports()

    assert [r["id"] for r, _ in pending] == [1]


def test_approve_reports_noop_on_empty(capsys):
    with patch("urllib.request.urlopen") as m:
        ar.approve_reports([])
    m.assert_not_called()
    assert "No pending reports" in capsys.readouterr().out


def test_approve_reports_posts_merge_duplicate_rows():
    report = {"id": 7}
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["body"] = json.loads(req.data.decode("utf-8"))
        captured["prefer"] = req.headers.get("Prefer")
        cm = MagicMock()
        cm.__enter__.return_value = MagicMock()
        cm.__exit__.return_value = False
        return cm

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        ar.approve_reports([(report, "hash123")])

    assert captured["method"] == "POST"
    assert "on_conflict=report_id" in captured["url"]
    assert captured["body"][0]["report_id"] == 7
    assert captured["body"][0]["approval_hash"] == "hash123"
    assert captured["body"][0]["approved_by"] == "Auto-Moderator"
    assert "merge-duplicates" in captured["prefer"]


def test_run_skips_without_service_key(capsys):
    with patch.object(ar, "SUPABASE_KEY", ""):
        ar.run()
    assert "not set, skipping" in capsys.readouterr().out


def test_run_fetches_then_approves():
    with patch.object(ar, "SUPABASE_KEY", "svc-key"), \
         patch.object(ar, "fetch_pending_reports", return_value=[({"id": 1}, "h")]) as fp, \
         patch.object(ar, "approve_reports") as ap:
        ar.run()
    fp.assert_called_once()
    ap.assert_called_once_with([({"id": 1}, "h")])
