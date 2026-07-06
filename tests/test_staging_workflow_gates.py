"""Guard tests for the staging deploy workflow gates.

`update-data.yml` has three staging paths (shell-only, full pipeline, finalize
only) that must not overlap or the prod branch gets overwritten by a staging
run (this actually happened once, see the NOTE comment in the workflow near
line 525). These assertions pin the gate expressions so a careless edit does
not silently reintroduce that class of bug.
"""
from pathlib import Path

import yaml


WORKFLOW = yaml.safe_load(
    (Path(__file__).resolve().parent.parent / ".github" / "workflows" / "update-data.yml").read_text()
)


def _job(name):
    return WORKFLOW["jobs"][name]


def _step(job_name, step_name):
    for step in _job(job_name)["steps"]:
        if step.get("name") == step_name:
            return step
    raise AssertionError(f"step {step_name!r} not found in job {job_name!r}")


def test_all_three_staging_inputs_declared():
    inputs = WORKFLOW[True]["workflow_dispatch"]["inputs"]  # `on` parses as True in YAML 1.1
    assert "staging_only" in inputs
    assert "staging_with_pipeline" in inputs
    assert "staging_with_finalize" in inputs


def test_build_stage_skips_all_finalize_only_modes():
    # Build (probe planning + report processing) is the expensive stage. It
    # must skip whenever we're in any mode that reuses prod chunk state:
    # pages_only, staging_only, finalize_only, staging_with_finalize.
    gate = _job("build")["if"]
    assert "inputs.finalize_only != true" in gate
    assert "inputs.staging_with_finalize != true" in gate
    assert "inputs.staging_only != true" in gate


def test_finalize_stage_runs_for_both_finalize_modes():
    gate = _job("finalize")["if"]
    assert "inputs.finalize_only == true" in gate
    assert "inputs.staging_with_finalize == true" in gate


def test_prod_deploy_gated_off_for_every_staging_mode():
    # If either staging flag is on, the prod deploy step must be skipped.
    # Missing either check is the exact bug that force-pushed prod's
    # frontend over a staging preview last time.
    step = _step("finalize", "Deploy to gh-pages (orphan, no history)")
    gate = step["if"]
    assert "inputs.staging_with_pipeline != true" in gate
    assert "inputs.staging_with_finalize != true" in gate


def test_staging_deploy_gated_on_for_both_staging_finalize_modes():
    step = _step("finalize", "Deploy pipeline output to staging repo")
    gate = step["if"]
    assert "inputs.staging_with_pipeline == true" in gate
    assert "inputs.staging_with_finalize == true" in gate


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
