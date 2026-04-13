[![Update ProtonDB Data](https://github.com/mdeguzis/proton-pulse-data/actions/workflows/update-data.yml/badge.svg)](https://github.com/mdeguzis/proton-pulse-data/actions/workflows/update-data.yml) [![pages-build-deployment](https://github.com/mdeguzis/proton-pulse-data/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/mdeguzis/proton-pulse-data/actions/workflows/pages/pages-build-deployment)

# proton-pulse-data

Monthly GitHub Pages mirror for ProtonDB per-game community reports.
It is used by the [decky-proton-pulse](https://github.com/mdeguzis/decky-proton-pulse) plugin.

## Endpoints

```
GET https://mdeguzis.github.io/proton-pulse-data/data/{appId}/index.json
GET https://mdeguzis.github.io/proton-pulse-data/data/{appId}/{year}.json
GET https://mdeguzis.github.io/proton-pulse-data/data/{appId}/latest.json
GET https://mdeguzis.github.io/proton-pulse-data/
GET https://mdeguzis.github.io/proton-pulse-data/data-index.html
GET https://mdeguzis.github.io/proton-pulse-data/app.html?appid={appId}
```

## Web app

Static pages deployed to GitHub Pages alongside the data files:

**[Home](https://mdeguzis.github.io/proton-pulse-data/) (`index.html`) — Splash/landing page**
Project landing page with links to all tools and repos.

**[Game Search App](https://mdeguzis.github.io/proton-pulse-data/app.html) (`app.html`) — Game page**
Per-game report viewer. Pass an `appid` query parameter (e.g. `app.html?appid=730`) to load community reports for that game. Features include:
- Report cards with extended fields (CPU, GPU, kernel, Proton version, OS, RAM, notes)
- Hardware filters to narrow results by GPU driver, kernel, or Proton version
- Compatibility trend chart showing rating distribution over time

**[Data Index](https://mdeguzis.github.io/proton-pulse-data/data-index.html) (`data-index.html`) — Coverage dashboard**
Lists all games with ProtonDB data available in this mirror, along with Steam catalog coverage stats.

**[Coverage Report](https://mdeguzis.github.io/proton-pulse-data/coverage.html) (`coverage.html`)**
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

This repo includes a helper for creating downloadable logical Supabase backups
with the Supabase CLI, following the documented `db dump` flow for `roles`,
`schema`, and `data` exports.

The default `make` target uses an already-linked local Supabase CLI project, so
you do not have to put your database URL or password into shell history:

```bash
cd proton-pulse-data
npx --yes supabase link
make backup-supabase
```

If you prefer a non-interactive or CI-style flow, the script still supports an
explicit database URL:

```bash
cd proton-pulse-data
SUPABASE_DB_URL='postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres' \
  bash scripts/backup_supabase.sh
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
