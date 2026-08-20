"""Gates on the ad-hoc Deck verdict backfill workflow.

The delay default is the load-bearing detail. Every OTHER appdetails enricher
in this repo uses 2.0s because store.steampowered.com/api/appdetails
soft-throttles at ~200 requests / 5 minutes. This workflow hits a different
endpoint (saleaction/ajaxgetdeckappcompatibilityreport), measured at ~3 req/s
with zero failures over 80 consecutive requests. Copying the appdetails
spacing here would turn a 3-hour full fill into an 18-hour one that cannot
finish inside a job.
"""

from pathlib import Path

import pytest
import yaml

WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "deck-backfill.yml"


@pytest.fixture(scope="module")
def wf():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _on(doc):
    return doc[True] if True in doc else doc["on"]


def _steps(doc):
    return doc["jobs"]["backfill"]["steps"]


def test_is_manual_only(wf):
    assert list(_on(wf)) == ["workflow_dispatch"]


def test_defaults_to_a_full_fill(wf):
    # budget 0 = no cap. The whole point of the workflow.
    assert _on(wf)["workflow_dispatch"]["inputs"]["budget"]["default"] == "0"


def test_delay_is_tuned_to_this_endpoint_not_appdetails(wf):
    delay = float(_on(wf)["workflow_dispatch"]["inputs"]["delay"]["default"])
    # Fast enough to finish, slow enough to sit under the measured ceiling.
    assert 0.1 <= delay <= 1.0, "appdetails' 2.0s does not apply to this endpoint"


def test_timeout_fits_a_full_catalog_pass(wf):
    # ~32k rows at 0.35s is roughly 3 hours; the cap must clear that.
    assert wf["jobs"]["backfill"]["timeout-minutes"] >= 200


def test_serializes_runs(wf):
    assert wf["concurrency"]["group"] == "deck-backfill"
    assert wf["concurrency"]["cancel-in-progress"] is False


def test_shares_the_pipeline_cache_prefix(wf):
    restore = next(s for s in _steps(wf) if str(s.get("uses", "")).startswith("actions/cache/restore"))
    save = next(s for s in _steps(wf) if str(s.get("uses", "")).startswith("actions/cache/save"))
    assert restore["with"]["path"] == ".cache"
    # Must name update-data.yml, not this workflow, or the two never share.
    assert "update-data.yml" in restore["with"]["restore-keys"]
    assert "update-data.yml" in save["with"]["key"]


def test_saves_the_cache_even_on_failure(wf):
    save = next(s for s in _steps(wf) if str(s.get("uses", "")).startswith("actions/cache/save"))
    assert save.get("if") == "always()"


def test_sources_the_id_list_from_the_published_index(wf):
    # A fresh checkout has no pipeline output; deck-status scopes itself from
    # search-index.json, so the job must fetch it before running.
    body = WORKFLOW.read_text(encoding="utf-8")
    assert "search-index.json" in body
    # Hard-fail when the index is missing rather than silently scoping to zero
    # apps and reporting success -- that is the exact failure mode this whole
    # workflow exists to fix.
    assert "test -s /tmp/protondb-output/search-index.json" in body


def test_optional_priority_files_do_not_fail_the_run(wf):
    body = WORKFLOW.read_text(encoding="utf-8")
    assert "|| echo \"skip $f (optional)\"" in body


def test_does_not_deploy(wf):
    body = WORKFLOW.read_text(encoding="utf-8")
    for forbidden in ["publish-cloudflare.sh", "gh-pages", "wrangler", "s3 sync"]:
        assert forbidden not in body


def test_passes_output_dir_positionally(wf):
    # The CLI takes output_dir as a positional; --output-dir is rejected.
    body = WORKFLOW.read_text(encoding="utf-8")
    assert "deck-status \\\n            /tmp/protondb-output" in body
    assert "--output-dir" not in body
