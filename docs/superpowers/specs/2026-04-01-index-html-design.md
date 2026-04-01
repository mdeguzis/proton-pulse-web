# Design: proton-pulse-data HTML Index

**Date:** 2026-04-01
**Status:** Approved

## Summary

Generate a plain `index.html` at the GitHub Pages root listing all available
`data/{appId}/{year}.json` files as a collapsible tree, so users can browse
what data exists without knowing appIds or years upfront.

## Architecture

Index generation is added to the end of `process_data()` in
`scripts/split_reports.py`. After all year files are flushed to disk, the
function iterates the already-populated `buffer` dict (keyed by `(appId, year)`)
to build the HTML — no second filesystem walk required.

Output path: `{output_dir}/index.html` (sibling of `data/`, not inside it),
so GitHub Pages serves it at the repo root as
`https://mdeguzis.github.io/proton-pulse-data/`.

## HTML Structure

- Plain HTML, no external CSS, no JavaScript
- Native `<details>`/`<summary>` elements for collapse/expand (zero JS)
- `<h1>proton-pulse-data index</h1>` at the top
- AppIds sorted numerically ascending
- Years sorted ascending within each app
- Each year is a plain `<a href="data/{appId}/{year}.json">` link that opens the raw JSON
- Timestamp at the bottom: `Generated: YYYY-MM-DD HH:MM UTC`

Example tree rendered in the browser:

```
proton-pulse-data index

▶ 730/
▶ 4000/
▶ 570/
...

Generated: 2026-04-01 00:05 UTC
```

Expanded:

```
▼ 730/
    2019.json
    2020.json
    2021.json
▶ 4000/
```

## Workflow Changes

Two updates to `.github/workflows/update-data.yml`:

1. **Copy step** — after the existing `cp -rv /tmp/protondb-output/data/. scripts-repo/data/`,
   add a line to copy `index.html`:
   ```sh
   cp /tmp/protondb-output/index.html scripts-repo/index.html
   ```

2. **Git add step** — change `git add data/` to `git add data/ index.html` so
   the index is committed alongside data changes.

## Out of Scope

- Game names (not present in the ProtonDB report data)
- Search or filtering
- `index.json` machine-readable index (separate feature if needed)
- CSS styling beyond minimal inline style for indentation
