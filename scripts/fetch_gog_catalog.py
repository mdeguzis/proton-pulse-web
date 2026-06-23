"""Standalone script to fetch and cache the GOG game catalog."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.pipeline.gog_catalog import load_gog_catalog

force = os.environ.get("FORCE_REFRESH", "false").lower() == "true"
catalog = load_gog_catalog(force_refresh=force)
print(f"[gog-catalog] {len(catalog):,} entries loaded")
