"""HEAD-probe every URL in nonsteam-images.json and write status + probe date
to nonsteam-images-cache.json (#203).

Mirrors game_images.py for GOG/Epic. Catalog APIs return a cover URL for every
listed product, but the CDN can 404 (product delisted, image rotated, region
block). Without this probe, admin only learns about broken URLs when a user
actually loads a broken card and image_load_errors gets a row -- games no one
has visited stay silent.

Pipeline flow:
- finalize.py::generate_nonsteam_images builds the raw canonical_id -> url map
  from load_gog_covers() + load_epic_covers().
- We probe every URL that is either uncached OR whose cache entry is older
  than STALE_DAYS. Hot ids (recent-reports + most_played) are always probed.
  Backlog ids are capped at PROBE_CAP per run so a first-run warm-up doesn't
  hammer GOG/Epic CDNs.
- Cache entries are { url, status, probed_at }. status is "ok" or "missing".
- Frontend nonsteam-images.json includes only status=ok entries -- broken
  URLs are dropped so the client stops wasting a fetch on them and cards
  render the "Box art missing" tile directly.

Admin (js/admin/components/boxart.js) reads nonsteam-images-cache.json to
build knownMissingNonSteam, so the Missing filter surfaces GOG/Epic entries
the pipeline confirmed as broken, not just the client-reported ones.
"""

import json
import time
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

from .common import log

REQUEST_DELAY = 0.1       # seconds between HEAD requests; GOG/Epic CDNs tolerate
PROBE_CAP = 800           # backlog cap per run
STALE_DAYS = 30           # re-probe cache entries older than this


def _url_is_ok(url: str, timeout: int = 8) -> bool:
    """HEAD the URL and return True on 200. Any other status or transport
    error is treated as missing. Kept blunt on purpose: intermittent 5xxs
    will get another shot on the next pipeline run once the cache entry
    goes stale."""
    if not url:
        return False
    req = urllib.request.Request(
        url,
        method="HEAD",
        headers={"User-Agent": "Mozilla/5.0 (proton-pulse pipeline probe)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _load_cache(output_dir: Path) -> dict:
    cache_path = output_dir / "nonsteam-images-cache.json"
    if not cache_path.exists():
        return {}
    try:
        return json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"[nonsteam-images-probe] cache read failed, starting fresh: {exc}")
        return {}


def _is_stale(entry: dict) -> bool:
    try:
        probed = datetime.fromisoformat(entry["probed_at"]).date()
    except Exception:
        return True
    return (date.today() - probed) > timedelta(days=STALE_DAYS)


def _hot_ids(output_dir: Path) -> set[str]:
    """Non-Steam ids currently visible on the site (recent-reports + most_played)."""
    ids: set[str] = set()
    for fname in ("recent-reports.json", "most_played.json"):
        p = output_dir / fname
        if not p.exists():
            continue
        try:
            for entry in json.loads(p.read_text(encoding="utf-8")):
                aid = str(entry.get("appId", entry.get("app_id", ""))).strip()
                if aid.startswith(("gog:", "epic:")):
                    ids.add(aid)
        except Exception as exc:
            log(f"[nonsteam-images-probe] WARN: could not read {fname}: {exc}")
    return ids


def probe_nonsteam_images(output_dir: Path, catalog_urls: dict[str, str]) -> dict[str, str]:
    """Probe every URL in catalog_urls and return a filtered map of ids that
    resolve. Writes nonsteam-images-cache.json alongside. Called by
    generate_nonsteam_images (finalize.py) with the raw catalog output.
    """
    output_dir = Path(output_dir)
    cache = _load_cache(output_dir)
    hot = _hot_ids(output_dir)
    today = date.today().isoformat()

    to_probe: list[str] = []
    for aid in catalog_urls:
        entry = cache.get(aid)
        if entry is None or _is_stale(entry) or entry.get("url") != catalog_urls[aid]:
            to_probe.append(aid)

    hot_to_probe = [a for a in to_probe if a in hot]
    backlog_to_probe = [a for a in to_probe if a not in hot]

    log(
        f"[nonsteam-images-probe] {len(catalog_urls)} URLs | cache {len(cache)} | "
        f"hot {len(hot_to_probe)} to probe | backlog {len(backlog_to_probe)} (cap {PROBE_CAP})"
    )

    backlog_done = 0
    ok_count = 0
    miss_count = 0
    for aid in hot_to_probe + backlog_to_probe:
        if aid not in hot:
            if backlog_done >= PROBE_CAP:
                log(f"[nonsteam-images-probe] hit backlog cap ({PROBE_CAP}), deferring {len(backlog_to_probe) - backlog_done}")
                break
            backlog_done += 1
        url = catalog_urls[aid]
        ok = _url_is_ok(url)
        cache[aid] = {
            "url": url,
            "status": "ok" if ok else "missing",
            "probed_at": today,
        }
        if ok:
            ok_count += 1
        else:
            miss_count += 1
            log(f"[nonsteam-images-probe] {aid}: URL 404/error -> {url}")
        time.sleep(REQUEST_DELAY)

    # Purge cache entries that are no longer in the catalog. Left alone the
    # cache would grow forever with stale gog:/epic: ids that were delisted
    # from the source catalog after we last saw them.
    for aid in list(cache.keys()):
        if aid not in catalog_urls:
            del cache[aid]

    cache_path = output_dir / "nonsteam-images-cache.json"
    cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
    log(
        f"[nonsteam-images-probe] probed {ok_count + miss_count} URLs "
        f"({ok_count} ok, {miss_count} missing), cache size {len(cache)}"
    )

    # Filtered frontend map: only entries known to work. Anything missing or
    # never probed for a fresh id defaults to "keep" so first-run entries
    # still render until we've had a chance to check them.
    filtered: dict[str, str] = {}
    for aid, url in catalog_urls.items():
        entry = cache.get(aid)
        if entry is None or entry.get("status") != "missing":
            filtered[aid] = url
    return filtered
