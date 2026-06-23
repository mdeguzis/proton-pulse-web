"""Standalone script to fetch and cache the Epic Games Store catalog."""

import os
import sys
from pathlib import Path

# Add repo root so scripts.pipeline is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.pipeline.epic_catalog import load_epic_catalog

force = os.environ.get("FORCE_REFRESH", "false").lower() == "true"
catalog = load_epic_catalog(force_refresh=force)
print(f"[epic-catalog] {len(catalog):,} entries loaded")
