"""Stub out optional heavy deps so tests can import pipeline modules without them."""
import sys
from contextlib import ExitStack
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
    # ExitStack rather than a nested `with`: the patch list outgrew CPython's
    # 20-statically-nested-block limit (#246 tipped it over with a SyntaxError).
    # Adding a stub is now a one-line append with no ceiling.
    stubs = {
        "load_gog_catalog": {},
        "load_epic_catalog": {},
        "load_gog_covers": {},
        "load_epic_covers": {},
        "load_gog_release_years": {},
        "load_epic_release_years": {},
        "load_gog_meta": {},
        "load_epic_meta": {},
        # init_nonsteam_stub_dirs calls refresh_catalog (PCGW network) and
        # would create ~19k dirs under tmp_path -- stub the whole step.
        "init_nonsteam_stub_dirs": None,
        # #410: sweeps the FlightlessSomething API when its cache is cold.
        "run_flightless_benchmarks": None,
        # Fetches LIVE Supabase user_configs rows. Unstubbed, any real report
        # submitted "today" leaks a current-year file + metadata into the
        # test fixtures (test_live_backfill started failing the day the
        # first 2026 web report landed). Same rule as everything above:
        # every network callee finalize touches gets stubbed here.
        "merge_pulse_into_data_dir": None,
        "enrich_search_index_with_pcgamingwiki": None,
        "merge_pcgwiki_catalog": None,
        "enrich_search_index_with_anti_cheat": None,
        "enrich_search_index_with_steam_type": None,
        "build_deck_status": None,
        "validate_steam_app_ids": None,
        "write_depot_files": None,
        "write_proton_versions_json": None,
        # #246: clone_or_update_vrdb shallow-clones a 27MB repo and
        # backfill_vr_categories probes Steam appdetails at the mandatory 2s
        # spacing (up to 200 apps -- ~7 minutes). Unstubbed, EVERY finalize
        # test paid both costs; the suite went from 27 minutes to over an
        # hour before this landed. Same rule as everything above.
        "clone_or_update_vrdb": None,
        "build_vrdb_index": {},
        "write_vrdb_json": None,
        "vr_capable_app_ids": set(),
        "backfill_vr_categories": 0,
        "enrich_search_index_with_vr": 0,
        # Coverage-report helper. Its call site calls it "a cheap read against
        # the pipeline output dir", but against a cold cache it paginates ~95
        # PCGamingWiki Cargo pages at the mandatory 2.1s spacing -- minutes per
        # test against a community-run API. It used to be a local import inside
        # finalize_output, which no namespace patch could reach; hoisted to a
        # module-level import so it stubs like everything else here.
        "refresh_pcgwiki_catalog": {},
    }
    with ExitStack() as stack:
        for name, value in stubs.items():
            stack.enter_context(patch(f"scripts.pipeline.finalize.{name}", return_value=value))
        yield