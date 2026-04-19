[![Update ProtonDB Data](https://github.com/mdeguzis/proton-pulse-data/actions/workflows/update-data.yml/badge.svg)](https://github.com/mdeguzis/proton-pulse-data/actions/workflows/update-data.yml) [![pages-build-deployment](https://github.com/mdeguzis/proton-pulse-data/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/mdeguzis/proton-pulse-data/actions/workflows/pages/pages-build-deployment)

# proton-pulse-data

> Website: **<https://www.proton-pulse.com/>** — the site and JSON data are now served from this custom domain. Old `mdeguzis.github.io/proton-pulse-data/*` URLs still redirect, but please update bookmarks and any automation to the new host.

Monthly GitHub Pages mirror for ProtonDB per-game community reports.
It is used by the [decky-proton-pulse](https://github.com/mdeguzis/decky-proton-pulse) plugin.

## Endpoints

```
GET https://www.proton-pulse.com/data/{appId}/index.json
GET https://www.proton-pulse.com/data/{appId}/{year}.json
GET https://www.proton-pulse.com/data/{appId}/latest.json
GET https://www.proton-pulse.com/
GET https://www.proton-pulse.com/data-index.html
GET https://www.proton-pulse.com/app.html?appid={appId}
```

## Web app

Static pages deployed to GitHub Pages alongside the data files:

**[Home](https://www.proton-pulse.com/) (`index.html`) — Splash/landing page**
Project landing page with links to all tools and repos.

**[Game Search App](https://www.proton-pulse.com/app.html) (`app.html`) — Game page**
Per-game report viewer. Pass an `appid` query parameter (e.g. `app.html?appid=730`) to load community reports for that game. Features include:
- Report cards with extended fields (CPU, GPU, kernel, Proton version, OS, RAM, notes) — always visible, no tap required
- Hardware filters to narrow results by GPU, OS, and rating
- Native Pulse reports (submitted from the plugin) shown alongside ProtonDB community reports
- Pulse config cards showing saved launch option profiles per game
- Mobile-friendly layout with a collapsible left-side hamburger menu

**[Data Index](https://www.proton-pulse.com/data-index.html) (`data-index.html`) — Coverage dashboard**
Lists all games with ProtonDB data available in this mirror, along with Steam catalog coverage stats.

**[Coverage Report](https://www.proton-pulse.com/coverage.html) (`coverage.html`)**
Steam catalog coverage statistics.

## Data format

Each `data/{appId}/{year}.json` and `data/{appId}/latest.json` is a JSON array
of normalized Proton Pulse report objects:

```json
[
  {
    "appId": "730",
    "cpu": "AMD Ryzen 7 5800X3D",
    "duration": "severalHours",
    "gpu": "AMD Radeon RX 6800 XT",
    "gpuDriver": "Mesa 23.1.0",
    "kernel": "6.8.0",
    "notes": "Runs great.",
    "os":  "Arch Linux",
    "protonVersion": "Proton 8.0-5",
    "ram": "32 GB",
    "rating": "platinum",
    "timestamp": 1693526400,
    "title": ""
  }
]
```

`data/{appId}/index.json` contains the sorted list of year files available for
that game, and `latest.json` mirrors the most recent year bucket.

## Update schedule

Runs automatically each day via GitHub Actions.
Source data comes from the monthly dumps in [bdefore/protondb-data](https://github.com/bdefore/protondb-data).

## Live backfills

Some games are missing from the monthly upstream dump even though ProtonDB live
detailed report data exists. Add those games to
`config/live_backfill_app_ids.json`, and the pipeline will generate normal
`data/{appId}/...` files for them during the build.

## Triggering manually

Go to **Actions -> Update ProtonDB Data -> Run workflow**.

## Supabase backups

This repo includes a helper for creating logical Supabase backups (`roles`,
`schema`, `data`) using `pg_dump` directly — no Supabase CLI or Docker required.

`pg_dump` is installed automatically by `make setup` (via `pkg` on Termux or
`apt-get` on Debian/Ubuntu). To install it standalone:

```bash
make install-pg
```

Set your database URL in a `.env` file at the repo root:

```bash
SUPABASE_DB_URL='postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
```

The connection string is in the Supabase dashboard under
**Settings → Database → Connection string → URI** (use Session mode, port 5432).

Then run:

```bash
make backup-supabase
```

Or pass the URL directly:

```bash
SUPABASE_DB_URL='postgresql://...' bash scripts/backup_supabase.sh
```

Outputs are written to `data/supabase/<timestamp>/` plus a matching
`.tar.gz` archive, and are ignored by git. You can override the location or
name with:

```bash
SUPABASE_BACKUP_DIR=artifacts/supabase
SUPABASE_BACKUP_LABEL=nightly
```

This should also be easy to move into GitHub Actions later by supplying
`SUPABASE_DB_URL` from repository secrets and uploading the generated archive
as a workflow artifact.

## Steam catalog coverage

The coverage report can expand to the full Steam game catalog when
`STEAM_API_KEY` is available. For local runs, place the key in a local `.env`
file at the repo root:

```env
STEAM_API_KEY=your_key_here
```

That file is ignored by git. In GitHub Actions, the workflow writes the secret
into the same `.env` shape during the build so local and CI behavior stay
consistent.

The Steam app ID pull currently relies on the vendored
`vendor/Steam-Games-Scraper` git submodule while that project remains active.
After cloning this repo, initialize submodules before running local commands:

```bash
make setup
```

or:

```bash
git submodule update --init --recursive
```

The GitHub Actions probe pass is split into resumable cache-backed checkpoints.
Each chunk saves `.cache/protondb-summary-probe-cache.json` under a fresh cache key
so an interrupted multi-hour run can resume from the latest completed chunk instead
of restarting the whole probe sweep.

## Local development setup

Bootstrap the local toolchain with:

```bash
make setup
```

That setup flow:
- initializes git submodules
- installs `shellcheck` with `sudo apt install -y shellcheck` when missing
- installs the Python dev environment with `uv`

## Storage strategy

The `gh-pages` branch is an orphan with a single commit. It is force-pushed
on each run so history does not pile up. Repo size stays close to the current dataset.
