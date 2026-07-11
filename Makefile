# proton-pulse-web — Makefile

UV_CACHE_DIR ?= /tmp/uv-cache
GITHUB_WORKFLOW ?= update-data.yml
BACKFILL_APP_IDS ?=
COVERAGE_BACKFILL_ISSUE_TYPE ?=
COVERAGE_BACKFILL_LIMIT ?= 0
WATCH_INTERVAL ?= 10
WATCH_ALL_WORKFLOWS ?= true
STAGING_VERSION_URL ?= https://mdeguzis.github.io/proton-pulse-web-staging/version.json
FORCE_DEPLOY ?=

.PHONY: help setup install install-pg test test-js lint lint-py lint-pylint lint-sh test-py init-submodules fetch-steam-catalog backup-supabase install-docker \
	gh-run gh-pages-only gh-staging gh-staging-pipeline gh-staging-finalize gh-resume gh-finalize-only gh-backfill-apps gh-coverage-backfill gh-run-watch gh-check check-staging-sync \
	build serve smoke smoke-live pre-push coverage deploy-worker

build:
	@bash scripts/cache-bust.sh

# Deploy a Cloudflare Worker (default: edge-status). Override: make deploy-worker WORKER=<name>
deploy-worker:
	@bash scripts/deploy-worker.sh $(WORKER)

# Run Jest unit tests + manifest completeness check
test-js:
	@npx jest

# Run Jest with coverage report and enforce thresholds from jest.config.js
coverage:
	@npx jest --coverage

# Full pre-push gate: cache-bust, Jest (with coverage), smoke
pre-push: build coverage smoke

# Render-path smoke test: serves a staged copy of the site (with an error
# catcher injected at the top of every <head>) and drives headless Firefox
# through home + reference game pages. Catches ReferenceErrors inside
# render() that pass jest but break the live site. Run before pushing
# changes to renderGamePage / renderCard / renderConfigCard / search wiring.
smoke:
	@bash scripts/smoke.sh

# Same harness pointed at the production site -- skips the local staging
# step (so no error-catcher injection; DOM-state assertions only) and
# catches deploy issues like a stale cache buster.
smoke-live:
	@BASE_URL=https://www.proton-pulse.com bash scripts/smoke.sh

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  build               Update cache buster hashes (?v=hash) in HTML files"
	@echo "  test-js             Run Jest unit tests and manifest completeness check"
	@echo "  coverage            Run Jest with coverage report and enforce thresholds"
	@echo "  pre-push            Full pre-push gate: build + coverage + smoke"
	@echo "  install             Install node deps (vite + jest) via pnpm"
	@echo "  serve               Run vite dev server with CSS HMR (http://localhost:5173)"
	@echo "  smoke               Render-path smoke test against a local staged copy"
	@echo "  smoke-live          Same harness pointed at https://www.proton-pulse.com"
	@echo "  sync-runtime        Pull scoring-info.json and form-schema.json from plugin repo"
	@echo "  setup               Bootstrap local dev tools and Python dependencies"
	@echo "  install-pg          Install pg_dump (postgresql) via pkg (Termux/Debian)"
	@echo "  init-submodules     Initialize and update git submodules"
	@echo "  test                Run linting and the Python test suite"
	@echo "  lint                Run static checks that should match VS Code Problems output"
	@echo "  lint-py             Run pyright over the Python workspace"
	@echo "  lint-pylint         Run pylint over Python sources"
	@echo "  lint-sh             Run shellcheck over shell scripts"
	@echo "  test-py             Run the Python test suite with uv"
	@echo "  fetch-steam-catalog Fetch and cache Steam app IDs using STEAM_API_KEY"
	@echo "  backup-supabase     Dump Supabase DB via pg_dump (requires SUPABASE_DB_URL)"
	@echo "  install-docker      Install Docker Engine via the local helper script"
	@echo "  deploy-worker       Deploy a Cloudflare Worker (default edge-status; WORKER=<name> to override)"
	@echo "  gh-check            Verify gh is installed and authenticated"
	@echo "  check-staging-sync  Verify staging SHA matches HEAD before a prod deploy (auto-runs)"
	@echo "  gh-run              Trigger the full GitHub Actions update-data workflow via gh"
	@echo "  gh-pages-only       Promote current main to production (requires staging to be in sync)"
	@echo "  gh-staging          Deploy shell files to staging only (no prod deploy) for preview"
	@echo "  gh-staging-pipeline Run FULL pipeline against staging + deploy data to staging (#117, ~30 min)"
	@echo "  gh-staging-finalize Skip probe/build, re-run finalize + stats against prod state, deploy to staging (#196, ~5 min)"
	@echo "  gh-resume           Re-run only chunks marked incomplete in the manifest (#171)"
	@echo "  gh-finalize-only    Skip probing, re-run finalize against current manifest state (#171)"
	@echo "  gh-backfill-apps    Trigger targeted app backfill"
	@echo "                      Usage: make gh-backfill-apps BACKFILL_APP_IDS=1145350,2358720"
	@echo "  gh-coverage-backfill Trigger coverage-based backfill"
	@echo "                      Usage: make gh-coverage-backfill COVERAGE_BACKFILL_ISSUE_TYPE=no-titles COVERAGE_BACKFILL_LIMIT=50"
	@echo "  gh-run-watch        Poll active GitHub Actions runs until they finish"
	@echo "                      Optional: WATCH_INTERVAL=5 make gh-run-watch"
	@echo "                      Optional: WATCH_ALL_WORKFLOWS=false make gh-run-watch"

init-submodules:
	git submodule update --init --recursive

install:
	@command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm not found, install node + pnpm first" >&2; exit 1; }
	pnpm install

# Pull scoring-info.json and form-schema.json from the decky-proton-pulse repo
# so scoring.html and the submit form can render locally. These files live in
# the plugin repo and are normally pulled by the gh-pages deploy workflow; for
# local dev we grab them from a sibling checkout if present, else from GitHub.
PLUGIN_REPO ?= ../decky-proton-pulse
sync-runtime:
	@if [ -d "$(PLUGIN_REPO)/src/data" ]; then \
		echo "Copying runtime data from $(PLUGIN_REPO)/src/data..."; \
		cp "$(PLUGIN_REPO)/src/data/scoring-info.json" ./scoring-info.json; \
		cp "$(PLUGIN_REPO)/src/data/form-schema.json" ./form-schema.json; \
	else \
		echo "Plugin repo not found at $(PLUGIN_REPO), pulling from GitHub..."; \
		curl -sfL https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/src/data/scoring-info.json -o ./scoring-info.json; \
		curl -sfL https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/src/data/form-schema.json -o ./form-schema.json; \
	fi
	@echo "Synced: scoring-info.json, form-schema.json"

# live preview of the static site with CSS hot-module reload
# vite picks up every .html in the repo root as its own page route
serve:
	@if [ -d node_modules/vite ]; then pnpm run dev; else npx vite --host --port 5173; fi

install-pg:
	@if command -v pg_dump >/dev/null 2>&1; then \
		echo "pg_dump already installed: $$(pg_dump --version)"; \
	elif command -v pkg >/dev/null 2>&1; then \
		echo "Installing postgresql via pkg..."; \
		pkg install -y postgresql; \
	elif command -v apt-get >/dev/null 2>&1; then \
		echo "Installing postgresql-client via apt-get..."; \
		sudo apt-get install -y postgresql-client; \
	else \
		echo "error: cannot auto-install pg_dump. Install postgresql-client manually." >&2; \
		exit 1; \
	fi

setup: install-pg
	UV_CACHE_DIR=$(UV_CACHE_DIR) bash scripts/setup_dev.sh

test: lint test-py

lint: lint-py lint-pylint lint-sh

lint-py:
	UV_CACHE_DIR=$(UV_CACHE_DIR) uv run --group dev pyright

lint-pylint:
	PYLINTHOME=/tmp/pylint-cache PYTHONPATH=scripts UV_CACHE_DIR=$(UV_CACHE_DIR) uv run --group dev pylint scripts/split_reports.py scripts/pipeline

lint-sh:
	@command -v shellcheck >/dev/null 2>&1 || { \
		echo "error: shellcheck is required for 'make lint-sh' and 'make test'." >&2; \
		echo "install it first, for example: sudo apt-get install shellcheck" >&2; \
		exit 1; \
	}
	find scripts -type f -name '*.sh' -print0 | xargs -0r shellcheck -x

test-py:
	UV_CACHE_DIR=$(UV_CACHE_DIR) uv run --group dev python -m pytest tests/ -v

fetch-steam-catalog: setup
	UV_CACHE_DIR=$(UV_CACHE_DIR) uv run python scripts/split_reports.py steam-catalog

backup-supabase: install-pg
	@if [[ -z "$${SUPABASE_DB_URL:-}" ]] && [[ -f .env ]]; then \
		export $$(grep -v '^#' .env | xargs) 2>/dev/null; \
	fi; \
	bash scripts/backup_supabase.sh

install-docker:
	sudo bash scripts/install_docker.sh

gh-check:
	@command -v gh >/dev/null 2>&1 || { \
		echo "error: gh is required for GitHub workflow targets." >&2; \
		echo "install it first, then run 'gh auth status' to verify access." >&2; \
		exit 1; \
	}
	gh auth status

check-staging-sync:
	@if [ -n "$(FORCE_DEPLOY)" ]; then \
		echo "FORCE_DEPLOY set -- skipping staging sync check."; \
	else \
		echo "Checking staging site is in sync with origin/staging before prod deploy..."; \
		staging_sha=$$(curl -sf '$(STAGING_VERSION_URL)' \
			| python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha","")[:7])' 2>/dev/null || true); \
		git fetch origin staging --quiet 2>/dev/null || true; \
		branch_sha=$$(git rev-parse --short=7 origin/staging 2>/dev/null || git rev-parse --short=7 HEAD); \
		if [ -z "$$staging_sha" ]; then \
			echo "error: could not read $(STAGING_VERSION_URL)" >&2; \
			echo "Run 'make gh-staging' from the staging branch and verify before promoting to prod." >&2; \
			exit 1; \
		fi; \
		if [ "$$staging_sha" != "$$branch_sha" ]; then \
			echo "error: staging site is at $$staging_sha but origin/staging is at $$branch_sha" >&2; \
			echo "Run 'make gh-staging' from the staging branch, verify the fix, then re-run this target." >&2; \
			echo "To skip this check (emergencies only): FORCE_DEPLOY=1 make $@" >&2; \
			exit 1; \
		fi; \
		echo "Staging site matches origin/staging ($$staging_sha). OK to promote."; \
	fi

gh-run: gh-check check-staging-sync
	gh workflow run $(GITHUB_WORKFLOW)
	@echo "Triggered $(GITHUB_WORKFLOW)"

gh-pages-only: gh-check check-staging-sync
	gh workflow run $(GITHUB_WORKFLOW) --field pages_only=true
	@echo "Triggered $(GITHUB_WORKFLOW) with pages_only=true"

gh-staging: gh-check
	@bash scripts/wait-for-remote.sh
	gh workflow run $(GITHUB_WORKFLOW) --ref staging --field staging_only=true
	@echo "Triggered $(GITHUB_WORKFLOW) with staging_only=true -- preview at https://mdeguzis.github.io/proton-pulse-web-staging/"

# Full-pipeline staging deploy (#117). Runs the whole pipeline against the
# staging branch and deploys the resulting data + shell to the staging repo.
# Slow (30+ min); only needed when a pipeline-data change needs end-to-end
# verification before promoting to prod. Regular UI-only changes should
# keep using `make gh-staging`.
gh-staging-pipeline: gh-check
	@bash scripts/wait-for-remote.sh
	gh workflow run $(GITHUB_WORKFLOW) --ref staging --field staging_with_pipeline=true
	@echo "Triggered $(GITHUB_WORKFLOW) with staging_with_pipeline=true -- full pipeline against staging, ~30 min. Preview at https://mdeguzis.github.io/proton-pulse-web-staging/"

# Fast staging deploy for finalize-only changes (#196). Skips build + probe
# entirely; restores prod chunk state from gh-pages, reruns only finalize +
# stats against it, and deploys to the staging repo. Use for changes that
# touch finalize.py or search-index shape without needing new probe data --
# e.g. adding a column to search-index.json. Wall time: ~5 min instead of 30.
gh-staging-finalize: gh-check
	@bash scripts/wait-for-remote.sh
	gh workflow run $(GITHUB_WORKFLOW) --ref staging --field staging_with_finalize=true
	@echo "Triggered $(GITHUB_WORKFLOW) with staging_with_finalize=true -- finalize + stats only against prod chunk state, deploy to staging (~5 min). Preview at https://mdeguzis.github.io/proton-pulse-web-staging/"

# Resume a partial run (#171 Phase 3). Reads gh-pages/.pipeline-state/
# manifest.json, subtracts chunks marked completed, and re-runs only the
# missing ones. Use after a chunk stalls or times out mid-pipeline. Save
# vs a fresh dispatch: chunks that already succeeded stay cached, so a
# 1-chunk rescue takes ~10 min instead of 30+.
gh-resume: gh-check
	gh workflow run $(GITHUB_WORKFLOW) --field resume=true
	@echo "Triggered $(GITHUB_WORKFLOW) with resume=true -- only missing chunks will re-run (#171)"

# Re-run finalize alone (#171 Phase 3). Skips build + probe-chunks entirely;
# reads chunk state from gh-pages manifest as-is and rebuilds the site
# outputs. Use after a finalize-side bug fix when the probe cache is fine.
gh-finalize-only: gh-check
	gh workflow run $(GITHUB_WORKFLOW) --field finalize_only=true
	@echo "Triggered $(GITHUB_WORKFLOW) with finalize_only=true -- probes skipped, finalize only (#171)"

gh-backfill-apps: gh-check
	@if [ -z "$(BACKFILL_APP_IDS)" ]; then \
		echo "error: BACKFILL_APP_IDS is required." >&2; \
		echo "usage: make gh-backfill-apps BACKFILL_APP_IDS=1145350,2358720" >&2; \
		exit 1; \
	fi
	gh workflow run $(GITHUB_WORKFLOW) --field backfill_app_ids="$(BACKFILL_APP_IDS)"
	@echo "Triggered $(GITHUB_WORKFLOW) with backfill_app_ids=$(BACKFILL_APP_IDS)"

gh-coverage-backfill: gh-check
	@if [ -z "$(COVERAGE_BACKFILL_ISSUE_TYPE)" ]; then \
		echo "error: COVERAGE_BACKFILL_ISSUE_TYPE is required." >&2; \
		echo "usage: make gh-coverage-backfill COVERAGE_BACKFILL_ISSUE_TYPE=no-titles COVERAGE_BACKFILL_LIMIT=50" >&2; \
		exit 1; \
	fi
	gh workflow run $(GITHUB_WORKFLOW) \
		--field coverage_backfill_issue_type="$(COVERAGE_BACKFILL_ISSUE_TYPE)" \
		--field coverage_backfill_limit="$(COVERAGE_BACKFILL_LIMIT)"
	@echo "Triggered $(GITHUB_WORKFLOW) with coverage_backfill_issue_type=$(COVERAGE_BACKFILL_ISSUE_TYPE) coverage_backfill_limit=$(COVERAGE_BACKFILL_LIMIT)"

gh-run-watch: gh-check
	@while true; do \
		clear; \
		if [ "$(WATCH_ALL_WORKFLOWS)" = "true" ]; then \
			WORKFLOW_LABEL="all workflows"; \
			WORKFLOW_ARGS=""; \
		else \
			WORKFLOW_LABEL="$(GITHUB_WORKFLOW)"; \
			WORKFLOW_ARGS="--workflow $(GITHUB_WORKFLOW)"; \
		fi; \
		echo "========================================"; \
		echo "GitHub Actions Watch"; \
		echo "========================================"; \
		echo "$$WORKFLOW_LABEL"; \
		echo "$$(date '+%Y-%m-%d %H:%M:%S')"; \
		echo ""; \
		ACTIVE_RUNS="$$(gh run list $$WORKFLOW_ARGS --limit 20 --json databaseId,workflowName,status,displayTitle,headBranch,event,startedAt --jq '.[] | select(.status != "completed") | "#\(.databaseId) | \(.workflowName // "-")\nstatus: \(.status) | event: \(.event) | branch: \(.headBranch // "-")\nstarted: \(.startedAt // "-")\ntitle: \(.displayTitle)\n"')"; \
		COMPLETED_RUNS="$$(gh run list $$WORKFLOW_ARGS --limit 3 --json databaseId,workflowName,status,conclusion,displayTitle,headBranch,event,updatedAt --jq '[.[] | select(.status == "completed")] | reverse[] | "#\(.databaseId) | \(.workflowName // "-")\nresult: \(.conclusion // "-") | event: \(.event) | branch: \(.headBranch // "-")\nupdated: \(.updatedAt // "-")\ntitle: \(.displayTitle)\n"')"; \
		echo "========================================"; \
		echo "Last 3 Completed Runs"; \
		echo "========================================"; \
		if [ -n "$$COMPLETED_RUNS" ]; then \
			printf "%s\n" "$$COMPLETED_RUNS"; \
		else \
			echo "No completed runs found."; \
		fi; \
		echo ""; \
		echo "========================================"; \
		echo "Active Runs"; \
		echo "========================================"; \
		if [ -n "$$ACTIVE_RUNS" ]; then \
			printf "%s\n" "$$ACTIVE_RUNS"; \
		else \
			echo "No active runs found."; \
		fi; \
		echo ""; \
		if [ -z "$$ACTIVE_RUNS" ]; then \
			echo "No active runs remain. Exiting."; \
			break; \
		fi; \
		echo "Refreshing in $(WATCH_INTERVAL)s. Press Ctrl+C to stop."; \
		sleep $(WATCH_INTERVAL); \
	done
