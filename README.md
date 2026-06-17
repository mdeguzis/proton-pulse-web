[![CI](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/ci.yml/badge.svg)](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/ci.yml) [![codecov](https://codecov.io/gh/mdeguzis/proton-pulse-web/graph/badge.svg)](https://codecov.io/gh/mdeguzis/proton-pulse-web) [![Update ProtonDB Data](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/update-data.yml/badge.svg)](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/update-data.yml) [![Content Moderation](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/content-moderation.yml/badge.svg)](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/content-moderation.yml) [![pages-build-deployment](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/pages/pages-build-deployment) [![Sync gh-pages to staging repo](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/sync-staging-main.yml/badge.svg)](https://github.com/mdeguzis/proton-pulse-web/actions/workflows/sync-staging-main.yml)

# proton-pulse-web

> Website: **<https://www.proton-pulse.com/>** - the site and JSON data are now served from this custom domain. Old `mdeguzis.github.io/proton-pulse-web/*` URLs still redirect, but please update bookmarks and any automation to the new host.

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

**[Home](https://www.proton-pulse.com/) (`index.html`) - Splash/landing page**
Project landing page with links to all tools and repos.

**[Game Search App](https://www.proton-pulse.com/app.html) (`app.html`) - Game page**
Per-game report viewer. Pass an `appid` query parameter (e.g. `app.html?appid=730`) to load community reports for that game. Features include:
- Report cards with extended fields (CPU, GPU, kernel, Proton version, OS, RAM, notes) - always visible, no tap required
- Hardware filters to narrow results by GPU, OS, and rating
- Native Pulse reports (submitted from the plugin) shown alongside ProtonDB community reports
- Pulse config cards showing saved launch option profiles per game
- Mobile-friendly layout with a collapsible left-side hamburger menu

**[Data Index](https://www.proton-pulse.com/data-index.html) (`data-index.html`) - Coverage dashboard**
Lists all games with ProtonDB data available in this mirror, along with Steam catalog coverage stats.

**[Coverage Report](https://www.proton-pulse.com/coverage.html) (`coverage.html`)**
Steam catalog coverage statistics.

**[Admin Panel](https://www.proton-pulse.com/admin.html) (`admin.html`) - Moderation tools**
Restricted to admins (Steam auth required). Provides:
- Flagged report review with sort, filter by type and date range, and search
- Reinstate, delete, or ban user actions per report
- Banned user management with unban and report restore
- Admin roster view

## Content moderation

See [Content Moderation](https://github.com/mdeguzis/proton-pulse-web/wiki/Content-Moderation) in the wiki.

## Admin access

The `admins` table in Supabase controls who can access the admin panel. To add or remove an admin directly (fallback if the panel is inaccessible):

```bash
source ~/.supabase
curl -s -X POST "https://api.supabase.com/v1/projects/ilsgdshkaocrmibwdezk/database/query" \
  -H "Authorization: Bearer $SUPABASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "INSERT INTO public.admins (proton_pulse_user_id, steam_username) VALUES ('"'"'<uuid>'"'"', '"'"'<username>'"'"') ON CONFLICT DO NOTHING;"}'
```

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

## Local development

```bash
make setup
```

## Documentation

Full docs live in the [wiki](https://github.com/mdeguzis/proton-pulse-web/wiki):

- [Data Pipeline](https://github.com/mdeguzis/proton-pulse-web/wiki/Data-Pipeline)
- [API Reference](https://github.com/mdeguzis/proton-pulse-web/wiki/API-Reference)
- [Supabase Voting](https://github.com/mdeguzis/proton-pulse-web/wiki/Supabase-Voting)
- [Steam Auth Flow](https://github.com/mdeguzis/proton-pulse-web/wiki/Steam-Auth-Flow)
- [Content Moderation](https://github.com/mdeguzis/proton-pulse-web/wiki/Content-Moderation)
- [Design Palette](https://github.com/mdeguzis/proton-pulse-web/wiki/Design-Palette)
