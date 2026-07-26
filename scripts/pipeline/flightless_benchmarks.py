"""FlightlessSomething benchmark ingestion (#410).

FlightlessSomething (github.com/erkexzcx/flightlesssomething, hosted at
flightlesssomething.ambrosia.one) is a MangoHud benchmark sharing platform.
Anonymous reads are allowed; the instance holds a few thousand benchmarks,
so one paginated sweep per run is cheap.

The API has NO game/app-id concept -- benchmarks are free-text titled
("Cyberpunk 2077 - Low settings - SCX-Scheds"), so association with our
catalog is title matching with a strict bar (Mike's rule): a benchmark
self-assigns to a game only on an EXACT normalized-title match or a
similarity of at least MATCH_THRESHOLD (0.90) between the game title and
the leading portion of the benchmark title. Anything below the bar lands
in a review queue for the admin panel (where matches can also be
rearranged / reassigned); we never guess.

A title that exists on several storefronts (Steam + GOG + Epic entries of
the same game) attaches the benchmark to ALL of them -- a benchmark says
nothing about which store the runner bought it from.

Benchmarks are DISPLAY-ONLY context: they never feed confidence scores or
tier math. MangoHud is a Linux overlay so most runs are Proton or native
Linux, but nothing in the data says which (or on what Proton version), so
the game page shows them under an explicit info banner instead of mixing
them into stats.

Benchmarks whose game exists nowhere in our index get a stub id
`mango_<8-char-base36>` derived exactly like the pw_ ids (#406): sha256 of
the normalized title. Deterministic, so re-runs are stable and an admin
remap can reference the id before the game ever gains a real entry.

Emits (all into the pipeline output dir):
  flightless-benchmarks.json   { "<appId>": { "count": N,
                                   "search_url": <link to FS search>,
                                   "benchmarks": [ {id, title, url,
                                     created_at, run_count, specs} ] } }
  flightless-review-queue.json [ {benchmark_id, title, best_match_app_id,
                                   best_match_title, similarity} ]
Also updates data/<appId>/metadata.json with
  "has_flightlessmango_status": true/false
for every app the sweep touched (true) and every previously-true app that
no longer matches (false), so the game page can gate its benchmarks
section without fetching the full map.

License/attribution: we store only benchmark metadata + our own derived
stats and always deep-link back to the source benchmark page.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

from .common import app_id_to_dir, log

BASE_URL = "https://flightlesssomething.ambrosia.one"
OUTPUT_FILENAME = "flightless-benchmarks.json"
REVIEW_QUEUE_FILENAME = "flightless-review-queue.json"
CACHE_FILENAME = "flightless-benchmarks-cache.json"

# Same contact UA rule as PCGW: identify ourselves + a contact route.
USER_AGENT = "proton-pulse-pipeline/1.0 (+https://www.proton-pulse.com; github.com/mdeguzis/proton-pulse-web)"

PER_PAGE = 100          # API max
MAX_PAGES = 100         # 10k benchmarks -- instance holds ~3k today
REQUEST_DELAY_SEC = 1.0  # polite pacing; no documented read limit
TIMEOUT_SEC = 30
FRESH_TTL_SEC = 20 * 3600  # daily-ish; benchmarks accrue slowly

# Mike's matching bar: exact normalized match, or >= 0.90 similarity
# between the game title and the leading slice of the benchmark title.
MATCH_THRESHOLD = 0.90

_MANGO_ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz"


def normalize_title(s: str) -> str:
    """Lowercase, strip everything but alphanumerics to single spaces.
    Mirrors js/app/lib/search-match.js normalizeSearchable so the frontend
    and pipeline agree on what "the same title" means.
    """
    out = []
    prev_space = True
    for ch in str(s or "").lower():
        if ch.isalnum():
            out.append(ch)
            prev_space = False
        elif not prev_space:
            out.append(" ")
            prev_space = True
    return "".join(out).strip()


def title_to_mango_id(title: str) -> str:
    """Deterministic stub id for a benchmark game absent from our index:
    `mango_` + 8 base36 chars of sha256(normalized title). Same derivation
    as pcgamingwiki_catalog.slug_to_pw_id (#406) so the whole family of
    synthetic ids behaves identically.
    """
    n = int.from_bytes(hashlib.sha256(normalize_title(title).encode("utf-8")).digest()[:6], "big")
    chars = []
    for _ in range(8):
        chars.append(_MANGO_ID_CHARS[n % 36])
        n //= 36
    return "mango_" + "".join(chars)


def match_benchmark_title(bench_title: str, index_titles: dict[str, list[str]]) -> tuple[list[str], str | None, float]:
    """Find the app(s) our index knows this benchmark belongs to.

    index_titles: {normalized_game_title: [app_ids]} built once per run --
    a list because the same title can exist on several storefronts (Steam
    + GOG + Epic), and a benchmark says nothing about which store the
    runner bought the game from, so it attaches to all of them.

    Returns (app_ids, matched_normalized_title, similarity). similarity is
    1.0 for an exact hit, the SequenceMatcher ratio for the best fuzzy
    candidate (even when below threshold -- callers use it for the review
    queue), and 0.0 when nothing came close.

    Benchmark titles are usually "Game Name - settings - notes", so the
    fuzzy pass compares each candidate game title against the LEADING
    slice of the benchmark title of the same length. This keeps
    "Cyberpunk 2077 - Low settings" a strong match for "Cyberpunk 2077"
    without letting "Portal" match "Portal With RTX Benchmark" via a
    short-substring accident: the candidate must cover >= half of the
    benchmark title's tokens too.
    """
    norm_bench = normalize_title(bench_title)
    if not norm_bench:
        return [], None, 0.0
    # Exact: the whole benchmark title IS a game title.
    if norm_bench in index_titles:
        return index_titles[norm_bench], norm_bench, 1.0

    bench_tokens = norm_bench.split(" ")
    # (ratio, game_len, app_ids, norm_game): longer titles win ratio ties so
    # "Dying Light 2" beats "Dying Light" when both prefix-match.
    best: tuple[float, int, list[str], str | None] = (0.0, 0, [], None)
    for norm_game, app_ids in index_titles.items():
        game_len = len(norm_game)
        if not game_len:
            continue
        # Cheap pre-filter: first token must appear in the benchmark title,
        # and the game must not be wildly longer than the benchmark title.
        game_tokens = norm_game.split(" ")
        if game_tokens[0] not in bench_tokens:
            continue
        if game_len > len(norm_bench) + 8:
            continue
        leading = norm_bench[:game_len]
        ratio = SequenceMatcher(None, norm_game, leading).ratio()
        # Token-presence guard: every token of the game title must actually
        # appear in the benchmark title. The leading slice cuts mid-token,
        # so 'overwatch 2' vs 'overwatch p[roton...]' scored 0.909 -- one
        # lucky char over the bar -- and OW1 benchmarks landed on OW2. A
        # missing token (the '2') caps the score into the review band.
        if not all(t in bench_tokens for t in game_tokens):
            ratio = min(ratio, MATCH_THRESHOLD - 0.01)
        # Sequel guard: if the benchmark title continues the name right after
        # the matched slice with a digit or roman numeral ("dying light 2 ..."
        # vs game "dying light"), this is very likely a DIFFERENT game in the
        # same series. Cap below the auto-match bar so it lands in review.
        rest = norm_bench[game_len:].strip()
        next_token = rest.split(" ")[0] if rest else ""
        if next_token and (next_token.isdigit() or next_token in ("ii", "iii", "iv", "v", "vi", "vii")):
            ratio = min(ratio, MATCH_THRESHOLD - 0.01)
        # Guard against SINGLE-token common-word titles ("Portal", "Control")
        # prefix-matching a long benchmark that is mostly about something
        # else. Multi-token game titles with every token present (enforced
        # above) are already specific -- "Overwatch 2 - EEVDF vs scx_cake"
        # must auto-match OW2 even though the settings suffix is wordy.
        if len(game_tokens) == 1 and len(bench_tokens) > 2:
            ratio *= 0.75
        if (ratio, game_len) > (best[0], best[1]):
            best = (ratio, game_len, app_ids, norm_game)
    return best[2], best[3], best[0]


def _http_get_json(url: str) -> dict | list | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        # Hardcoded FlightlessSomething base + static REST paths.
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        log(f"[flightless] WARN: GET {url.split('?')[0]} failed: {exc}")
        return None


def fetch_all_benchmarks() -> list[dict] | None:
    """Paginated sweep of GET /api/benchmarks. Returns None if the FIRST
    page fails (caller falls back to cache); a mid-sweep failure returns
    what we have so a flaky page never wipes the dataset.
    """
    out: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        payload = _http_get_json(f"{BASE_URL}/api/benchmarks?page={page}&per_page={PER_PAGE}")
        if payload is None:
            if page == 1:
                return None
            log(f"[flightless] pagination stopped at page {page} (error); keeping {len(out)} rows")
            return out
        rows = payload.get("benchmarks") if isinstance(payload, dict) else None
        if not isinstance(rows, list) or not rows:
            return out
        out.extend(r for r in rows if isinstance(r, dict))
        total_pages = int(payload.get("total_pages") or 0) if isinstance(payload, dict) else 0
        if total_pages and page >= total_pages:
            return out
        time.sleep(REQUEST_DELAY_SEC)
    log(f"[flightless] hit MAX_PAGES ({MAX_PAGES}); truncating")
    return out


def _load_cache(cache_path: Path) -> dict:
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("fetched_at", 0)
            data.setdefault("benchmarks", [])
            return data
    except Exception:
        pass
    return {"fetched_at": 0, "benchmarks": []}


def _benchmark_summary(b: dict) -> dict:
    """The slice of a benchmark row we republish. Everything else (user
    identity, description body) stays on their site -- we deep-link.
    """
    bid = b.get("id")
    return {
        "id": bid,
        "title": str(b.get("title") or ""),
        "url": f"{BASE_URL}/benchmarks/{bid}",
        "created_at": str(b.get("created_at") or ""),
        "run_count": int(b.get("run_count") or 0),
        "specs": str(b.get("specifications") or ""),
    }


def search_url_for_title(title: str) -> str:
    """Direct link to the FlightlessSomething search for a game title, e.g.
    https://flightlesssomething.ambrosia.one/?search=overwatch+2
    """
    return f"{BASE_URL}/?search={urllib.parse.quote_plus(normalize_title(title))}"


def build_benchmark_map(
    benchmarks: list[dict],
    search_index: list,
    manual_overrides: dict[str, str] | None = None,
) -> tuple[dict[str, dict], list[dict]]:
    """Associate benchmarks with app ids.

    manual_overrides: {str(benchmark_id): app_id} from the (future) admin
    panel -- always wins over the auto-matcher.

    Returns (per-app map, review queue). Unmatched benchmarks with no
    near-miss get a mango_<hash> stub entry in the map; near-misses
    (similarity between 0.5 and the threshold) go to the review queue so
    an admin can assign them.
    """
    manual_overrides = manual_overrides or {}
    # One title -> MANY apps: the same game listed on Steam, GOG, and Epic
    # (and PCGW) all collect the benchmark. Cap the fan-out so a generic
    # title shared by dozens of shovelware entries cannot explode the map.
    index_titles: dict[str, list[str]] = {}
    titles_by_app: dict[str, str] = {}
    for row in search_index:
        if not (isinstance(row, list) and len(row) > 1 and row[1]):
            continue
        norm = normalize_title(str(row[1]))
        if not norm:
            continue
        apps = index_titles.setdefault(norm, [])
        if len(apps) < 8:
            apps.append(str(row[0]))
        titles_by_app.setdefault(str(row[0]), str(row[1]))

    per_app: dict[str, dict] = {}
    review: list[dict] = []

    def _add(app_id: str, title_for_search: str, bench: dict) -> None:
        slot = per_app.setdefault(app_id, {
            "count": 0,
            "search_url": search_url_for_title(title_for_search),
            "benchmarks": [],
        })
        slot["count"] += 1
        slot["benchmarks"].append(_benchmark_summary(bench))

    for bench in benchmarks:
        title = str(bench.get("title") or "").strip()
        if not title:
            continue
        override_app = manual_overrides.get(str(bench.get("id")))
        if override_app:
            _add(override_app, titles_by_app.get(override_app, title), bench)
            continue
        app_ids, matched_norm, sim = match_benchmark_title(title, index_titles)
        if app_ids and sim >= MATCH_THRESHOLD:
            # Self-assign to every storefront entry sharing the title.
            for app_id in app_ids:
                _add(app_id, titles_by_app.get(app_id, title), bench)
        elif app_ids and sim >= 0.5:
            # Close but below the bar: admin review, never a guess.
            review.append({
                "benchmark_id": bench.get("id"),
                "title": title,
                "best_match_app_id": app_ids[0],
                "best_match_title": matched_norm,
                "similarity": round(sim, 3),
            })
        else:
            # Game unknown to our index: deterministic stub id.
            _add(title_to_mango_id(title), title, bench)

    return per_app, review


def _update_metadata_flags(data_output_path: Path, matched_app_ids: set[str]) -> tuple[int, int]:
    """Write has_flightlessmango_status into per-app metadata.json.

    True for every matched app with a data dir; existing metadata files
    that say true but no longer match flip to false. Byte-identical
    rewrites are skipped so the #392 delta sync ignores untouched apps.
    """
    set_true = 0
    set_false = 0
    for app_id in sorted(matched_app_ids):
        app_dir = data_output_path / app_id_to_dir(app_id)
        if not app_dir.is_dir():
            continue  # mango_ stubs have no data dir (yet) -- map-only
        meta_path = app_dir / "metadata.json"
        try:
            existing = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
            if not isinstance(existing, dict):
                existing = {}
        except Exception:
            existing = {}
        if existing.get("has_flightlessmango_status") is True:
            continue
        existing["has_flightlessmango_status"] = True
        meta_path.write_text(json.dumps(existing, sort_keys=True) + "\n", encoding="utf-8")
        set_true += 1

    # Flip stale trues back off (benchmark deleted / remapped by an admin).
    for meta_path in data_output_path.glob("*/metadata.json"):
        app_id_dir = meta_path.parent.name
        try:
            existing = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(existing, dict) or existing.get("has_flightlessmango_status") is not True:
            continue
        # Compare on the dir form: matched ids pass through app_id_to_dir above.
        if any(app_id_to_dir(a) == app_id_dir for a in matched_app_ids):
            continue
        existing["has_flightlessmango_status"] = False
        meta_path.write_text(json.dumps(existing, sort_keys=True) + "\n", encoding="utf-8")
        set_false += 1
    return set_true, set_false


def run_flightless_benchmarks(output_dir: Path, data_output_path: Path | None = None, force: bool = False) -> None:
    """Entry point: sweep, match, publish. Never raises -- a benchmark-site
    outage must not fail the pipeline run.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path = output_dir / CACHE_FILENAME
    cache = _load_cache(cache_path)

    now = int(time.time())
    if (now - int(cache.get("fetched_at") or 0)) < FRESH_TTL_SEC and not force and cache.get("benchmarks"):
        benchmarks = cache["benchmarks"]
        log(f"[flightless] cache hit ({len(benchmarks)} benchmarks, age {now - int(cache['fetched_at'])}s)")
    else:
        log("[flightless] sweeping benchmark list")
        fetched = fetch_all_benchmarks()
        if fetched is None:
            benchmarks = cache.get("benchmarks") or []
            log(f"[flightless] API unreachable; using {len(benchmarks)} cached benchmarks")
        else:
            benchmarks = fetched
            cache_path.write_text(json.dumps({"fetched_at": now, "benchmarks": benchmarks}), encoding="utf-8")
            log(f"[flightless] swept {len(benchmarks)} benchmarks")

    index_path = output_dir / "search-index.json"
    try:
        search_index = json.loads(index_path.read_text(encoding="utf-8"))
        if not isinstance(search_index, list):
            search_index = []
    except Exception:
        log("[flightless] search-index.json unavailable; skipping match pass")
        return

    per_app, review = build_benchmark_map(benchmarks, search_index)
    (output_dir / OUTPUT_FILENAME).write_text(
        json.dumps(per_app, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    (output_dir / REVIEW_QUEUE_FILENAME).write_text(
        json.dumps(review, separators=(",", ":")), encoding="utf-8")
    mango_stubs = sum(1 for k in per_app if k.startswith("mango_"))
    log(
        f"[flightless] matched {len(per_app) - mango_stubs} apps, {mango_stubs} mango_ stubs, "
        f"{len(review)} queued for admin review"
    )

    if data_output_path is not None:
        set_true, set_false = _update_metadata_flags(Path(data_output_path), set(per_app.keys()))
        log(f"[flightless] metadata flags: {set_true} set true, {set_false} flipped false")
