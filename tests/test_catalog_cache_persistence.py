"""Store catalog caches must live somewhere that survives a run (#497).

The PCGW caches were written into the pipeline OUTPUT dir, which is /tmp on a
runner. The only thing copying them anywhere durable was the gh-pages deploy
loop, and #362 made cloudflare the deploy target, so that loop stopped running.
Every run wrote a cache and threw it away, which is why refresh_catalog's
disk-fallback could never engage when PCGW began rejecting Cargo queries -- and
why the guard added alongside it was inert in CI.

.cache/ is the directory the pipeline's Actions cache persists between runs,
and where the GOG and Epic catalog caches already live.
"""
from pathlib import Path

from scripts.pipeline.gog_catalog import DEFAULT_GOG_CATALOG_CACHE_PATH
from scripts.pipeline.pcgamingwiki import DEFAULT_ENRICHER_CACHE_PATH
from scripts.pipeline.pcgamingwiki_catalog import DEFAULT_CATALOG_CACHE_PATH

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_pcgw_caches_default_into_the_persisted_cache_dir():
    for p in (DEFAULT_CATALOG_CACHE_PATH, DEFAULT_ENRICHER_CACHE_PATH):
        assert p.parent == REPO_ROOT / ".cache", f"{p} is not under the persisted .cache/ dir"


def test_pcgw_caches_share_the_dir_the_gog_cache_already_uses():
    """Whatever persists the GOG cache must also persist these."""
    assert DEFAULT_CATALOG_CACHE_PATH.parent == DEFAULT_GOG_CATALOG_CACHE_PATH.parent
    assert DEFAULT_ENRICHER_CACHE_PATH.parent == DEFAULT_GOG_CATALOG_CACHE_PATH.parent


def test_actions_cache_covers_that_directory():
    """The workflow must actually cache the dir these defaults point at.

    A default pointing somewhere nothing persists is the original bug wearing
    a different path.
    """
    wf = (REPO_ROOT / ".github/workflows/update-data.yml").read_text(encoding="utf-8")
    assert "path: .cache" in wf, "update-data.yml no longer caches .cache/"


def test_seeding_cannot_clobber_a_newer_cache():
    """gh-pages seeding must compare timestamps, not overwrite blindly.

    The unconditional `cp` inverted its own intent: gh-pages froze when the
    weekly refresh workflow started no-opping, and the copy then overwrote the
    genuinely fresher catalog the Actions cache was carrying, forcing a
    ~274s GOG+Epic re-fetch on every single run.
    """
    wf = (REPO_ROOT / ".github/workflows/update-data.yml").read_text(encoding="utf-8")
    assert "seed-catalog-cache.sh" in wf
    assert "cp gh-pages-data/gog-catalog-cache.json" not in wf
    assert "cp gh-pages-data/epic-catalog-cache.json" not in wf
    assert (REPO_ROOT / "scripts/seed-catalog-cache.sh").exists()


def test_scheduled_catalog_refresh_does_not_ask_the_cache_for_permission():
    """A weekly refresh whose cadence equals the TTL must force.

    Otherwise it keeps finding the cache a few hours short of expiry and does
    nothing, which is exactly what happened: 'loaded 8,053 entries from cache
    (age 147.1h)' then 'Cache unchanged, nothing to commit'.
    """
    for name in ("update-gog-catalog.yml", "update-epic-catalog.yml"):
        wf = (REPO_ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
        assert "github.event_name == 'schedule'" in wf, f"{name} scheduled run does not force a refresh"
