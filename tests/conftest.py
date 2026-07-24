"""Stub out optional heavy deps so tests can import pipeline modules without them."""
import sys
from unittest.mock import MagicMock, patch

import pytest

if 'ijson' not in sys.modules:
    sys.modules['ijson'] = MagicMock()


@pytest.fixture(autouse=True)
def _no_network_catalog_loads():
    """Keep finalize_output unit tests off the network.

    finalize.py imports the GOG/Epic catalog loaders into its own namespace;
    unpatched they fetch the full remote catalogs (Epic pages its entire
    GraphQL catalog page by page) from inside unit tests whenever the local
    .cache/ copy is missing or stale. Patch finalize's references so tests
    exercising finalize_output stay hermetic. Tests for the loaders
    themselves target the gog_catalog / epic_catalog modules directly and
    are unaffected; tests that need other values re-patch inside the test.
    """
    with (
        patch("scripts.pipeline.finalize.load_gog_catalog", return_value={}),
        patch("scripts.pipeline.finalize.load_epic_catalog", return_value={}),
        patch("scripts.pipeline.finalize.load_gog_covers", return_value={}),
        patch("scripts.pipeline.finalize.load_epic_covers", return_value={}),
        patch("scripts.pipeline.finalize.load_gog_release_years", return_value={}),
        patch("scripts.pipeline.finalize.load_epic_release_years", return_value={}),
    ):
        yield
