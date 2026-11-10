"""Guard tests for the staging deploy workflow gates.

`update-data.yml` has three staging paths (shell-only, full pipeline, finalize
only) that must not overlap or the prod branch gets overwritten by a staging
run (this actually happened once, see the NOTE comment in the workflow near
line 525). These assertions pin the gate expressions so a careless edit does
not silently reintroduce that class of bug.
"""
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = yaml.safe_load(
    (ROOT / ".github" / "workflows" / "update-data.yml").read_text()
)


def _job(name):
    return WORKFLOW["jobs"][name]


def _step(job_name, step_name):
    for step in _job(job_name)["steps"]:
        if step.get("name") == step_name:
            return step
    raise AssertionError(f"step {step_name!r} not found in job {job_name!r}")


def test_staging_inputs_declared():
    inputs = WORKFLOW[True]["workflow_dispatch"]["inputs"]  # `on` parses as True in YAML 1.1
    assert "staging_with_pipeline" in inputs
    assert "staging_with_finalize" in inputs


def test_build_stage_skips_all_finalize_only_modes():
    # Build (probe planning + report processing) is the expensive stage. It
    # must skip whenever we're in any mode that reuses prod chunk state:
    # finalize_only, staging_with_finalize.
    gate = _job("build")["if"]
    assert "inputs.finalize_only != true" in gate
    assert "inputs.staging_with_finalize != true" in gate


def test_gh_pages_shell_and_backfill_modes_are_retired():
    # #396: pages_only, staging_only and the two backfill modes deployed to
    # gh-pages (or the retired staging repo), which nothing reads since the
    # Cloudflare move. publish-shell.yml owns shell deploys now.
    inputs = WORKFLOW[True]["workflow_dispatch"]["inputs"]
    for gone in ("pages_only", "staging_only", "backfill_app_ids",
                 "coverage_backfill_issue_type", "coverage_backfill_limit"):
        assert gone not in inputs, gone
    assert set(WORKFLOW["jobs"]) == {"build", "probe-chunks", "finalize", "report-build-status"}
    assert not (ROOT / ".github" / "workflows" / "deploy-on-merge.yml").exists()
    make = (ROOT / "Makefile").read_text()
    assert "gh-backfill-apps" not in make and "gh-coverage-backfill" not in make


def test_finalize_stage_runs_for_both_finalize_modes():
    gate = _job("finalize")["if"]
    assert "inputs.finalize_only == true" in gate
    assert "inputs.staging_with_finalize == true" in gate


def test_prod_deploy_gated_off_for_every_staging_mode():
    # If either staging flag is on, the one deploy step must target staging's
    # Pages project and bucket. Missing either check is the exact bug that
    # force-pushed prod's frontend over a staging preview once.
    env = _step("finalize", "Deploy to Cloudflare (R2 + Pages)")["env"]
    for key, staging in (("PAGES_PROJECT", "'proton-pulse-web-staging'"),
                         ("PAGES_BRANCH", "'staging'"),
                         ("R2_BUCKET", "'proton-pulse-data-staging'"),
                         ("DATA_BASE", "'https://staging-data.proton-pulse.com'")):
        expr = env[key]
        assert "inputs.staging_with_pipeline == true" in expr, key
        assert "inputs.staging_with_finalize == true" in expr, key
        assert f"&& {staging} ||" in expr, key


def test_staging_runs_never_push_to_the_retired_staging_repo():
    # #396: staging runs deploy to Cloudflare only. The old gh-pages step for
    # them force-pushed to mdeguzis/proton-pulse-web-staging, and
    # sync-staging-main.yml mirrored main there on every push.
    names = [s.get("name", "") for s in WORKFLOW["jobs"]["finalize"]["steps"]]
    assert "Deploy pipeline output to staging repo" not in names
    assert not (ROOT / ".github" / "workflows" / "sync-staging-main.yml").exists()
    for wf in (ROOT / ".github" / "workflows").glob("*.yml"):
        text = wf.read_text()
        assert "proton-pulse-web-staging.git" not in text, wf.name
        assert "STAGING_DEPLOY_TOKEN" not in text, wf.name


def test_gh_pages_rollback_and_fallbacks_are_retired():
    # #396: Cloudflare is the only deploy target. No deploy_target input, no
    # orphan gh-pages deploy, no gh-pages checkout feeding fallbacks.
    assert "deploy_target" not in WORKFLOW[True]["workflow_dispatch"]["inputs"]
    raw = (ROOT / ".github" / "workflows" / "update-data.yml").read_text()
    for gone in ("deploy_target", "ref: gh-pages", "gh-pages-data", "git rm -rf",
                 "origin gh-pages", "/tmp/backup-to-release.sh", "/tmp/preserve-"):
        assert gone not in raw, gone
    backup = _step("finalize", "Backup data to GitHub Release")
    assert "bash scripts/backup-to-release.sh /tmp/protondb-output" in backup["run"]
    for wf in ("retry-pages-build.yml",):
        assert not (ROOT / ".github" / "workflows" / wf).exists()
    assert not (ROOT / "scripts" / "preserve-steam-type-cache.sh").exists()


def test_probe_artifact_download_skipped_when_build_skipped():
    # In finalize_only + staging_with_finalize the build stage is off, so
    # there is no probe-input artifact to download. Attempting it fails
    # the whole finalize job.
    step = _step("finalize", "Download probe input artifact")
    gate = step["if"]
    assert "inputs.finalize_only != true" in gate
    assert "inputs.staging_with_finalize != true" in gate


def test_backfill_probe_step_skipped_when_no_new_probes():
    # Backfill Probe Discoveries reconciles freshly-probed results into the
    # data tree. finalize_only + staging_with_finalize skip probing, so this
    # step has nothing to do and would blow up on missing pipeline-state.json.
    step = _step("finalize", "Backfill Probe Discoveries")
    gate = step["if"]
    assert "inputs.finalize_only != true" in gate
    assert "inputs.staging_with_finalize != true" in gate


def test_pipeline_state_synthesized_from_disk_on_finalize_only_paths():
    # When the artifact is missing, finalize still needs a pipeline-state.json
    # so read_pipeline_state finds real index_keys. Both finalize-only modes
    # must trigger the synth step.
    step = _step("finalize", "Synthesize pipeline-state from disk")
    gate = step["if"]
    assert "inputs.finalize_only == true" in gate
    assert "inputs.staging_with_finalize == true" in gate
