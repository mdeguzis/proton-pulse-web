# proton-pulse-data — Makefile

UV_CACHE_DIR ?= /tmp/uv-cache

.PHONY: help setup install-pg test lint lint-py lint-pylint lint-sh test-py init-submodules fetch-steam-catalog backup-supabase install-docker

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
