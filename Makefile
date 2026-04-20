# proton-pulse-data — Makefile

UV_CACHE_DIR ?= /tmp/uv-cache
GITHUB_WORKFLOW ?= update-data.yml
BACKFILL_APP_IDS ?=
COVERAGE_BACKFILL_ISSUE_TYPE ?=
COVERAGE_BACKFILL_LIMIT ?= 0
WATCH_INTERVAL ?= 10
WATCH_ALL_WORKFLOWS ?= true

.PHONY: help setup install-pg test lint lint-py lint-pylint lint-sh test-py init-submodules fetch-steam-catalog backup-supabase install-docker \
	gh-run gh-pages-only gh-backfill-apps gh-coverage-backfill gh-run-watch gh-check

help:
	@echo "Usage: make <target>"
	@echo ""
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
	@echo "  gh-check            Verify gh is installed and authenticated"
	@echo "  gh-run              Trigger the full GitHub Actions update-data workflow via gh"
	@echo "  gh-pages-only       Trigger the Pages-only publish workflow path via gh"
	@echo "  gh-backfill-apps    Trigger targeted app backfill"
	@echo "                      Usage: make gh-backfill-apps BACKFILL_APP_IDS=1145350,2358720"
	@echo "  gh-coverage-backfill Trigger coverage-based backfill"
	@echo "                      Usage: make gh-coverage-backfill COVERAGE_BACKFILL_ISSUE_TYPE=no-titles COVERAGE_BACKFILL_LIMIT=50"
	@echo "  gh-run-watch        Poll active GitHub Actions runs until they finish"
	@echo "                      Optional: WATCH_INTERVAL=5 make gh-run-watch"
	@echo "                      Optional: WATCH_ALL_WORKFLOWS=false make gh-run-watch"

init-submodules:
	git submodule update --init --recursive

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

gh-run: gh-check
	gh workflow run $(GITHUB_WORKFLOW)
	@echo "Triggered $(GITHUB_WORKFLOW)"

gh-pages-only: gh-check
	gh workflow run $(GITHUB_WORKFLOW) --field pages_only=true
	@echo "Triggered $(GITHUB_WORKFLOW) with pages_only=true"

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
