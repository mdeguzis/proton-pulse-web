"""Gates on the ad-hoc VR backfill workflow (#246).

This workflow shares the appdetails cache with update-data.yml. The cache key
prefix is the whole contract: get it wrong and the two jobs each start cold,
re-probing thousands of apps the other already answered, against an API that
throttles at ~200 requests / 5 minutes.
"""

from pathlib import Path

import pytest
import yaml

WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "vr-backfill.yml"
UPDATE_DATA = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "update-data.yml"


@pytest.fixture(scope="module")
def wf():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _on(doc):
    # PyYAML parses a bare `on:` key as the boolean True.
    return doc[True] if True in doc else doc["on"]


def _steps(doc):
    return doc["jobs"]["backfill"]["steps"]


def test_is_manual_only(wf):
    # No schedule and no push trigger: this drain is deliberate, and an
    # accidental automatic run would eat the shared Steam rate-limit budget
    # the real pipeline needs.
    assert list(_on(wf)) == ["workflow_dispatch"]


def test_exposes_the_tuning_inputs(wf):
    inputs = _on(wf)["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"total_cap", "pass_cap", "cooldown", "request_delay"}


def test_defaults_respect_the_steam_rolling_window(wf):
    inputs = _on(wf)["workflow_dispatch"]["inputs"]
    # 200 req / 5 min is the documented soft throttle. A pass_cap above 200 or
    # a cooldown under the window means the next pass starts inside the same
    # window and immediately bails.
    assert int(inputs["pass_cap"]["default"]) <= 200
    assert float(inputs["cooldown"]["default"]) >= 300
    # 2.0s is the shared value across every appdetails enricher; going lower
    # earned a rolling-window ban the last time it was tried.
    assert float(inputs["request_delay"]["default"]) >= 2.0


def test_serializes_runs(wf):
    # Two concurrent drains would share one rate-limit window and race on the
    # same cache entries.
    assert wf["concurrency"]["group"] == "vr-backfill"
    assert wf["concurrency"]["cancel-in-progress"] is False


def test_shares_the_pipeline_cache_key_prefix(wf):
    restore = next(s for s in _steps(wf) if str(s.get("uses", "")).startswith("actions/cache/restore"))
    save = next(s for s in _steps(wf) if str(s.get("uses", "")).startswith("actions/cache/save"))
    assert restore["with"]["path"] == ".cache"
    assert save["with"]["path"] == ".cache"
    # The restore-keys prefix must name update-data.yml, not this workflow, or
    # the drain starts from an empty cache every time.
    assert "update-data.yml" in restore["with"]["restore-keys"]
    assert "update-data.yml" in save["with"]["key"]


def test_the_cache_prefix_matches_what_update_data_writes(wf):
    # Pin the two together: if update-data.yml's key shape changes, this fails
    # rather than silently splitting the cache.
    restore = next(s for s in _steps(wf) if str(s.get("uses", "")).startswith("actions/cache/restore"))
    prefix = "pipeline-cache-${{ runner.os }}-"
    assert restore["with"]["restore-keys"].strip().startswith(prefix)
    assert prefix in UPDATE_DATA.read_text(encoding="utf-8")


def test_saves_the_cache_even_when_the_drain_fails(wf):
    # A partial drain still answered real apps; dropping the cache would make
    # the next run redo exactly the same throttled requests.
    save = next(s for s in _steps(wf) if str(s.get("uses", "")).startswith("actions/cache/save"))
    assert save.get("if") == "always()"


def test_does_not_deploy_anything(wf):
    # The drain only fills the appdetails cache; publishing is finalize's job.
    # A deploy here could race the pipeline and half-publish data.
    body = WORKFLOW.read_text(encoding="utf-8")
    for forbidden in ["publish-cloudflare.sh", "gh-pages", "wrangler", "s3 sync"]:
        assert forbidden not in body


def test_invokes_the_documented_cli(wf):
    body = WORKFLOW.read_text(encoding="utf-8")
    assert "scripts/split_reports.py vr-backfill" in body
    for flag in ["--total-cap", "--pass-cap", "--cooldown", "--request-delay"]:
        assert flag in body


def test_timeout_allows_a_full_drain(wf):
    # A 2000-app drain at 2s/request plus cooldowns runs ~90 minutes; the
    # default 360-minute runner cap would be fine but an explicit bound keeps
    # a wedged run from burning the whole allowance.
    assert wf["jobs"]["backfill"]["timeout-minutes"] >= 120
