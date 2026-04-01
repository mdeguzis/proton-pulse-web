# index.html Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a plain `index.html` at the GitHub Pages root listing all `data/{appId}/{year}.json` files as a collapsible tree.

**Architecture:** `generate_index_html()` is added to `scripts/split_reports.py` and called at the end of `process_data()` using the in-memory `buffer` dict — no extra filesystem walk. The workflow copies `index.html` to the repo and commits it alongside data.

**Tech Stack:** Python 3.12, pytest, plain HTML (`<details>`/`<summary>`), GitHub Actions

---

### Task 1: Add pytest dev dependency

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: Add pytest**

```bash
uv add --dev pytest
```

- [ ] **Step 2: Verify**

```bash
uv run pytest --version
```

Expected output: `pytest 8.x.x`

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "chore: add pytest dev dependency"
```

---

### Task 2: Write failing tests for generate_index_html()

**Files:**
- Create: `tests/test_index.py`

- [ ] **Step 1: Create tests/test_index.py**

```python
from pathlib import Path

from scripts.split_reports import generate_index_html


def test_index_html_created(tmp_path):
    keys = {("730", "2020"), ("730", "2019")}
    generate_index_html(keys, tmp_path)
    assert (tmp_path / "index.html").exists()


def test_appids_sorted_numerically(tmp_path):
    # "4000" must come after "730" numerically, not before it lexicographically
    keys = {("4000", "2021"), ("570", "2022"), ("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    pos_570 = html.index("570/")
    pos_730 = html.index("730/")
    pos_4000 = html.index("4000/")
    assert pos_570 < pos_730 < pos_4000


def test_years_sorted_ascending(tmp_path):
    keys = {("730", "2022"), ("730", "2019"), ("730", "2021")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    pos_2019 = html.index("2019.json")
    pos_2021 = html.index("2021.json")
    pos_2022 = html.index("2022.json")
    assert pos_2019 < pos_2021 < pos_2022


def test_year_links_correct_href(tmp_path):
    keys = {("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert 'href="data/730/2020.json"' in html


def test_details_summary_structure(tmp_path):
    keys = {("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert "<details>" in html
    assert "<summary>730/</summary>" in html


def test_generated_timestamp_present(tmp_path):
    keys = {("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert "Generated:" in html
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_index.py -v
```

Expected: all 6 tests FAIL with `ImportError: cannot import name 'generate_index_html'`

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/test_index.py
git commit -m "test: add failing tests for generate_index_html"
```

---

### Task 3: Implement generate_index_html()

**Files:**
- Modify: `scripts/split_reports.py`

- [ ] **Step 1: Add the function** after the `parse_and_split()` function (before `main()`):

```python
def generate_index_html(index_keys: set, output_path: Path) -> None:
    """
    Write index.html to output_path listing all data/{appId}/{year}.json files
    as a collapsible tree using native <details>/<summary> elements.
    index_keys is a set of (appId, year) tuples.
    """
    from datetime import datetime, timezone

    # Collect {appId: [year, ...]} sorted numerically
    app_years: dict[str, list[str]] = {}
    for (app_id, year) in index_keys:
        app_years.setdefault(app_id, []).append(year)

    sorted_app_ids = sorted(app_years.keys(), key=int)
    for app_id in sorted_app_ids:
        app_years[app_id] = sorted(app_years[app_id], key=lambda y: int(y) if y.isdigit() else y)

    lines = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="utf-8">',
        "  <title>proton-pulse-data index</title>",
        "</head>",
        "<body>",
        "<h1>proton-pulse-data index</h1>",
        "<ul>",
    ]

    for app_id in sorted_app_ids:
        lines.append("  <li>")
        lines.append("    <details>")
        lines.append(f"      <summary>{app_id}/</summary>")
        lines.append("      <ul>")
        for year in app_years[app_id]:
            href = f"data/{app_id}/{year}.json"
            lines.append(f'        <li><a href="{href}">{year}.json</a></li>')
        lines.append("      </ul>")
        lines.append("    </details>")
        lines.append("  </li>")

    now = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines += [
        "</ul>",
        f"<p>Generated: {now}</p>",
        "</body>",
        "</html>",
    ]

    index_file = output_path / "index.html"
    index_file.write_text("\n".join(lines) + "\n")
    log(f"[index] Written: {index_file}")
```

- [ ] **Step 2: Call it from process_data()** — add this line at the end of `process_data()`, after the `log("Done!")` line:

```python
    generate_index_html(buffer, output_path)
```

Note: `buffer` is already in scope in `process_data()` at that point — it's the same `defaultdict` populated by `parse_and_split()` calls.

Wait — `buffer` is local to each `parse_and_split()` call, not `process_data()`. We need to accumulate the set of `(appId, year)` pairs seen across all source files.

The index only needs keys, not report content — so have `parse_and_split()` return `(count, set(buffer.keys()))` instead of the full buffer. This avoids keeping all report objects alive in memory for the whole run.

**Updated `parse_and_split()` return value** — change the final `return count` to:

```python
    return count, set(buffer.keys())
```

**Updated calls in `process_data()`** — replace:

```python
            count = parse_and_split(f, data_output_path, source_label=json_file.name)
        elapsed = time.time() - t0
        log(f"[json] Done: {count:,} reports in {elapsed:.1f}s")
        parsed_count += count
```

with:

```python
            count, src_keys = parse_and_split(f, data_output_path, source_label=json_file.name)
        elapsed = time.time() - t0
        log(f"[json] Done: {count:,} reports in {elapsed:.1f}s")
        parsed_count += count
        index_keys.update(src_keys)
```

And replace the tar.gz block similarly:

```python
                        count, src_keys = parse_and_split(f, data_output_path, source_label=member.name)
                        log(f"[tar]      {count:,} reports parsed")
                        parsed_count += count
                        index_keys.update(src_keys)
```

**Add `index_keys` declaration** at the top of `process_data()`, after `parsed_count = 0`:

```python
    index_keys: set[tuple] = set()
```

**Replace the `generate_index_html` call** at the end of `process_data()` to use `index_keys`:

```python
    generate_index_html(index_keys, output_path)
```

**Update `generate_index_html()` signature** to accept a set of tuples instead of a buffer dict:

```python
def generate_index_html(index_keys: set, output_path: Path) -> None:
    """
    Write index.html to output_path listing all data/{appId}/{year}.json files
    as a collapsible tree using native <details>/<summary> elements.
    index_keys is a set of (appId, year) tuples.
    """
    from datetime import datetime, timezone

    # Collect {appId: [year, ...]} sorted numerically
    app_years: dict[str, list[str]] = {}
    for (app_id, year) in index_keys:
        app_years.setdefault(app_id, []).append(year)

    sorted_app_ids = sorted(app_years.keys(), key=int)
    for app_id in sorted_app_ids:
        app_years[app_id] = sorted(app_years[app_id], key=lambda y: int(y) if y.isdigit() else y)

    lines = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="utf-8">',
        "  <title>proton-pulse-data index</title>",
        "</head>",
        "<body>",
        "<h1>proton-pulse-data index</h1>",
        "<ul>",
    ]

    for app_id in sorted_app_ids:
        lines.append("  <li>")
        lines.append("    <details>")
        lines.append(f"      <summary>{app_id}/</summary>")
        lines.append("      <ul>")
        for year in app_years[app_id]:
            href = f"data/{app_id}/{year}.json"
            lines.append(f'        <li><a href="{href}">{year}.json</a></li>')
        lines.append("      </ul>")
        lines.append("    </details>")
        lines.append("  </li>")

    now = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines += [
        "</ul>",
        f"<p>Generated: {now}</p>",
        "</body>",
        "</html>",
    ]

    index_file = output_path / "index.html"
    index_file.write_text("\n".join(lines) + "\n")
    log(f"[index] Written: {index_file}")

- [ ] **Step 3: Run tests**

```bash
uv run pytest tests/test_index.py -v
```

Expected: all 6 tests PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/split_reports.py
git commit -m "feat: add generate_index_html to split_reports.py"
```

---

### Task 4: Update GitHub Actions workflow

**Files:**
- Modify: `.github/workflows/update-data.yml`

- [ ] **Step 1: Add index.html copy** — in the "Sync processed data to scripts-repo" step, add after the `cp -rv` line:

```yaml
      - name: Sync processed data to scripts-repo
        run: |
          mkdir -p scripts-repo/data
          cp -rv /tmp/protondb-output/data/. scripts-repo/data/
          cp /tmp/protondb-output/index.html scripts-repo/index.html
```

- [ ] **Step 2: Update git add** — in the "Commit and Push changes" step, change:

```yaml
          git add data/
```

to:

```yaml
          git add data/ index.html
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/update-data.yml
git commit -m "ci: copy and commit index.html in update-data workflow"
```

---

### Task 5: Smoke-test locally

**Files:** none

- [ ] **Step 1: Run the full test suite**

```bash
uv run pytest tests/ -v
```

Expected: all tests PASS

- [ ] **Step 2: Run split_reports.py against sample data to verify index.html output**

```bash
mkdir -p /tmp/test-index-out
echo '[{"appId":730,"timestamp":1580000000},{"appId":4000,"timestamp":1693526400}]' \
  > /tmp/test-reports.json
mkdir -p /tmp/test-input
cp /tmp/test-reports.json /tmp/test-input/reports.json
uv run python scripts/split_reports.py /tmp/test-input /tmp/test-index-out
cat /tmp/test-index-out/index.html
```

Expected: valid HTML with `<details><summary>730/</summary>` and a link to `data/730/2020.json` (the year from timestamp 1580000000 = Jan 2020), and `4000/` with `2023.json`.

- [ ] **Step 3: Final commit if any fixups needed, otherwise done**
