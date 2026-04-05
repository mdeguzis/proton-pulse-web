# proton-pulse-data — Makefile

UV_CACHE_DIR ?= /tmp/uv-cache

.PHONY: help setup test test-py init-submodules fetch-steam-catalog

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  setup    Install Python dependencies with uv"
	@echo "  init-submodules  Initialize and update git submodules"
	@echo "  test     Run the test suite with uv"
	@echo "  test-py  Run the Python test suite with uv"
	@echo "  fetch-steam-catalog  Fetch and cache Steam app IDs using STEAM_API_KEY"

init-submodules:
	git submodule update --init --recursive

setup: init-submodules
	UV_CACHE_DIR=$(UV_CACHE_DIR) uv sync --group dev

test: test-py

test-py:
	UV_CACHE_DIR=$(UV_CACHE_DIR) uv run --group dev python -m pytest tests/ -v

fetch-steam-catalog: setup
	UV_CACHE_DIR=$(UV_CACHE_DIR) uv run python scripts/split_reports.py steam-catalog
