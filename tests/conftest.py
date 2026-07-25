"""Stub out optional heavy deps so tests can import pipeline modules without them."""
import sys
from unittest.mock import MagicMock, patch

import pytest

if 'ijson' not in sys.modules:
    sys.modules['ijson'] = MagicMock()


@pytest.fixture(autouse=True)
def _no_network_in_finalize():
    """Keep finalize_output unit tests off the network.

    finalize.py imports catalog loaders and search-index enrichers into its
    own namespace; unpatched they fetch full remote datasets from inside
    unit tests whenever the tmp_path / .cache copy is cold (Epic pages its
    whole GraphQL catalog; PCGamingWiki paginates ~95 Cargo pages at the
    mandatory 2.1s spacing, minutes per test, against a community-run API).
    Patch finalize's references so tests exercising finalize_output stay
    hermetic. Tests for the loaders/enrichers themselves target their source
    modules directly and are unaffected; tests that need other values
    re-patch inside the test (inner patch wins).
    """
    with (
        patch("scripts.pipeline.finalize.load_gog_catalog", return_value={}),
        patch("scripts.pipeline.finalize.load_epic_catalog", return_value={}),
        patch("scripts.pipeline.finalize.load_gog_covers", return_value={}),
        patch("scripts.pipeline.finalize.load_epic_covers", return_value={}),
        patch("scripts.pipeline.finalize.load_gog_release_years", return_value={}),
        patch("scripts.pipeline.finalize.load_epic_release_years", return_value={}),
        patch("scripts.pipeline.finalize.enrich_search_index_with_pcgamingwiki", return_value=None),
        patch("scripts.pipeline.finalize.merge_pcgwiki_catalog", return_value=None),
        patch("scripts.pipeline.finalize.enrich_search_index_with_anti_cheat", return_value=None),
        patch("scripts.pipeline.finalize.enrich_search_index_with_steam_type", return_value=None),
        patch("scripts.pipeline.finalize.build_deck_status", return_value=None),
        patch("scripts.pipeline.finalize.validate_steam_app_ids", return_value=None),
        patch("scripts.pipeline.finalize.write_depot_files", return_value=None),
        patch("scripts.pipeline.finalize.write_proton_versions_json", return_value=None),
    ):
        yield
