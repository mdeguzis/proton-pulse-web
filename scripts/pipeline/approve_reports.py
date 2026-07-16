"""Approve pending reports by generating md5 hashes of their content.

A report is considered "pending" when it has no matching row in
report_approvals or the stored hash doesn't match the current content.

The hash is: md5(app_id + client_id + rating + notes + os + gpu + created_at)

This script runs as part of the daily pipeline. It fetches all reports
without a valid approval, computes the hash, and upserts into
report_approvals.
"""

import hashlib
import json
import os
import urllib.request

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://ilsgdshkaocrmibwdezk.supabase.co')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')


def compute_approval_hash(report):
    """Generate an md5 fingerprint from key report fields.

    Used as a content-change detector, not a cryptographic hash: if any of
    these fields change after approval, the fingerprint changes and the
    pipeline knows to re-run approval on the report. Collision resistance
    is irrelevant here (an attacker with write access to user_configs can
    already do worse things than forging a hash). Passing
    usedforsecurity=False tells Bandit / Semgrep the MD5 choice is
    intentional for a non-security use.
    """
    parts = [
        str(report.get('app_id', '')),
        str(report.get('client_id', '')),
        str(report.get('rating', '')),
        str(report.get('notes', '')),
        str(report.get('os', '')),
        str(report.get('gpu', '')),
        str(report.get('created_at', '')),
    ]
    raw = '|'.join(parts)
    return hashlib.md5(raw.encode('utf-8'), usedforsecurity=False).hexdigest()  # nosemgrep: python.lang.security.insecure-hash-algorithms-md5.insecure-hash-algorithm-md5 - non-security fingerprint; see docstring


def fetch_pending_reports():
    """Fetch reports that don't have a valid approval hash."""
    url = (
        f'{SUPABASE_URL}/rest/v1/user_configs'
        '?select=id,app_id,client_id,rating,notes,os,gpu,created_at'
        '&is_flagged=neq.true'
        '&order=created_at.desc'
        '&limit=500'
    )
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
    })
    # URL constructed from hardcoded Supabase base + static REST path
    with urllib.request.urlopen(req, timeout=30) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        reports = json.loads(resp.read())

    # Fetch existing approvals
    approval_url = f'{SUPABASE_URL}/rest/v1/report_approvals?select=report_id,approval_hash'
    req2 = urllib.request.Request(approval_url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
    })
    # URL constructed from hardcoded Supabase base + static REST path
    with urllib.request.urlopen(req2, timeout=30) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        approvals = json.loads(resp.read())

    existing = {a['report_id']: a['approval_hash'] for a in approvals}

    pending = []
    for r in reports:
        expected_hash = compute_approval_hash(r)
        stored_hash = existing.get(r['id'])
        if stored_hash != expected_hash:
            pending.append((r, expected_hash))

    return pending


def approve_reports(pending):
    """Upsert approval hashes for pending reports."""
    if not pending:
        print('[approve_reports] No pending reports to approve')
        return

    rows = []
    for report, hash_val in pending:
        rows.append({
            'report_id': report['id'],
            'approval_hash': hash_val,
            'approved_at': 'now()',
            'approved_by': 'Auto-Moderator',
        })

    # Batch upsert via PostgREST
    url = f'{SUPABASE_URL}/rest/v1/report_approvals?on_conflict=report_id'
    data = json.dumps(rows).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
    })
    # URL constructed from hardcoded Supabase base + static REST path
    with urllib.request.urlopen(req, timeout=30) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        pass

    print(f'[approve_reports] Approved {len(rows)} reports')


def run():
    if not SUPABASE_KEY:
        print('[approve_reports] SUPABASE_SERVICE_KEY not set, skipping')
        return
    pending = fetch_pending_reports()
    print(f'[approve_reports] Found {len(pending)} pending reports')
    approve_reports(pending)


if __name__ == '__main__':
    run()
