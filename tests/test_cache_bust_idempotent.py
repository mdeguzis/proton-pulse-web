"""Regression test for #36: cache-bust must be idempotent even when JS files
have import cycles.

Earlier algorithm hashed raw bytes, so if A.js imported B.js (which embedded
hash(B) in A's content) and B.js imported A.js back, the hashes oscillated.
The router <-> components cycle in js/app/ triggered this and `make pre-push`
re-churned `?v=` values on every run.

The new algorithm hashes *stripped* content (with `?v=` params removed) so a
file's hash is a pure function of its source code, independent of its imports.
"""
import shutil
import textwrap
from pathlib import Path

from scripts.cache_bust import digest, run_cache_bust


def _write(p: Path, body: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8")


def _build_cyclic_fixture(root: Path) -> None:
    """A.js <-> B.js direct cycle, plus C.js -> A.js (one-way) for coverage."""
    _write(root / "js" / "a.js", """
        import { b } from './b.js';
        export const a = () => b() + 1;
    """)
    _write(root / "js" / "b.js", """
        import { a } from './a.js';
        export const b = () => a() + 1;
    """)
    _write(root / "js" / "c.js", """
        import { a } from './a.js';
        export const c = () => a() * 2;
    """)
    _write(root / "index.html", """
        <!DOCTYPE html>
        <html><head>
          <script type="module" src="js/a.js"></script>
        </head><body></body></html>
    """)


def test_idempotent_with_import_cycle(tmp_path: Path):
    _build_cyclic_fixture(tmp_path)

    js_first, html_first = run_cache_bust(tmp_path)
    assert "js/a.js" in js_first
    assert "js/b.js" in js_first
    assert "index.html" in html_first

    snapshot = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}

    js_second, html_second = run_cache_bust(tmp_path)
    assert js_second == [], f"second run rewrote JS files: {js_second}"
    assert html_second == [], f"second run rewrote HTML files: {html_second}"

    for p, before in snapshot.items():
        assert p.read_bytes() == before, f"{p} changed on second run"


def test_digest_ignores_existing_cache_bust_params(tmp_path: Path):
    """digest() must be invariant under existing ?v= params so cycles converge."""
    raw = tmp_path / "raw.js"
    raw.write_text("import { x } from './x.js';\n")
    busted = tmp_path / "busted.js"
    busted.write_text("import { x } from './x.js?v=deadbeef';\n")
    assert digest(raw) == digest(busted)


def test_passthrough_when_target_missing(tmp_path: Path):
    """Imports of non-existent files must be left alone (don't fabricate a hash)."""
    _write(tmp_path / "js" / "main.js", """
        import { x } from './does-not-exist.js';
        import { y } from './sibling.js';
        export const m = () => x() + y();
    """)
    _write(tmp_path / "js" / "sibling.js", "export const y = () => 2;\n")

    run_cache_bust(tmp_path)

    out = (tmp_path / "js" / "main.js").read_text()
    assert "./does-not-exist.js'" in out  # untouched, no ?v= appended
    assert "./sibling.js?v=" in out       # real import got versioned


def test_detects_real_content_change(tmp_path: Path):
    """A real edit to a file's source must produce a new hash on the next run."""
    _write(tmp_path / "js" / "leaf.js", "export const v = 1;\n")
    _write(tmp_path / "js" / "main.js", """
        import { v } from './leaf.js';
        export const m = () => v;
    """)

    run_cache_bust(tmp_path)
    first = (tmp_path / "js" / "main.js").read_text()

    # Edit the leaf and re-bust. The main.js import must pick up a new hash.
    (tmp_path / "js" / "leaf.js").write_text("export const v = 42;\n")
    run_cache_bust(tmp_path)
    second = (tmp_path / "js" / "main.js").read_text()
    assert first != second, "main.js should reflect leaf.js changes after re-bust"


def test_existing_repo_is_idempotent_now(tmp_path: Path):
    """Smoke check: copy the live repo's js/ and HTML files into tmp_path and
    assert one full cache-bust pass is enough to converge.
    """
    repo_root = Path(__file__).resolve().parents[1]
    for sub in ("js", "css"):
        src = repo_root / sub
        if src.is_dir():
            shutil.copytree(src, tmp_path / sub)
    for html in repo_root.glob("*.html"):
        shutil.copy2(html, tmp_path / html.name)

    run_cache_bust(tmp_path)
    js_second, html_second = run_cache_bust(tmp_path)
    assert js_second == [], f"second pass churned JS: {js_second}"
    assert html_second == [], f"second pass churned HTML: {html_second}"


# --- #595: a change anywhere below a module changes that module's ?v= --------

import hashlib
import re


def _v(text: str, name: str) -> str:
    m = re.search(re.escape(name) + r"\?v=([a-f0-9]{8})", text)
    assert m, f"no versioned ref to {name} in:\n{text}"
    return m.group(1)


def _chain_fixture(root: Path) -> None:
    """app.html -> main.js -> router.js -> home.js -> leaf.js, the shape that
    served stale home.js on staging: only leaf-side files changed."""
    _write(root / "app.html", '<script type="module" src="js/main.js"></script>\n')
    _write(root / "js" / "main.js", "import { route } from './router.js';\nroute();\n")
    _write(root / "js" / "router.js", "import { home } from './home.js';\nexport const route = () => home();\n")
    _write(root / "js" / "home.js", "import { leaf } from './leaf.js';\nexport const home = () => leaf;\n")
    _write(root / "js" / "leaf.js", "export const leaf = 1;\n")


def test_leaf_change_reaches_every_importer_and_the_html(tmp_path: Path):
    _chain_fixture(tmp_path)
    run_cache_bust(tmp_path)
    js = tmp_path / "js"
    before = {
        "router": _v((js / "main.js").read_text(), "router.js"),
        "home": _v((js / "router.js").read_text(), "home.js"),
        "leaf": _v((js / "home.js").read_text(), "leaf.js"),
        "main": _v((tmp_path / "app.html").read_text(), "js/main.js"),
    }
    (js / "leaf.js").write_text("export const leaf = 2;\n")
    js_changed, html_changed = run_cache_bust(tmp_path)
    after = {
        "router": _v((js / "main.js").read_text(), "router.js"),
        "home": _v((js / "router.js").read_text(), "home.js"),
        "leaf": _v((js / "home.js").read_text(), "leaf.js"),
        "main": _v((tmp_path / "app.html").read_text(), "js/main.js"),
    }
    for k in before:
        assert before[k] != after[k], f"{k} kept ?v={before[k]} after leaf.js changed"
    assert sorted(js_changed) == ["js/home.js", "js/main.js", "js/router.js"]
    assert html_changed == ["app.html"]


def test_change_below_a_cycle_reaches_both_members_and_outside_importers(tmp_path: Path):
    _build_cyclic_fixture(tmp_path)
    js = tmp_path / "js"
    # b.js (in the a<->b cycle) also imports a leaf.
    (js / "b.js").write_text("import { a } from './a.js';\nimport { d } from './d.js';\nexport const b = () => a() + d;\n")
    _write(js / "d.js", "export const d = 1;\n")
    run_cache_bust(tmp_path)
    a_before = _v((js / "c.js").read_text(), "a.js")
    b_before = _v((js / "a.js").read_text(), "b.js")
    (js / "d.js").write_text("export const d = 2;\n")
    run_cache_bust(tmp_path)
    assert _v((js / "c.js").read_text(), "a.js") != a_before
    assert _v((js / "a.js").read_text(), "b.js") != b_before
    # Still converges after the change.
    assert run_cache_bust(tmp_path) == ([], [])


def test_cycle_members_get_distinct_hashes(tmp_path: Path):
    _build_cyclic_fixture(tmp_path)
    run_cache_bust(tmp_path)
    js = tmp_path / "js"
    assert _v((js / "b.js").read_text(), "a.js") != _v((js / "a.js").read_text(), "b.js")


def test_dynamic_imports_are_versioned_and_propagate(tmp_path: Path):
    js = tmp_path / "js"
    _write(js / "page.js", """
        export async function open() {
          const a = await import('./lazy.js?v=00000001');
          const b = await import("./other.js");
          return [a, b];
        }
    """)
    _write(js / "lazy.js", "import { x } from './dep.js';\nexport const lazy = x;\n")
    _write(js / "other.js", "export const other = 1;\n")
    _write(js / "dep.js", "export const x = 1;\n")
    run_cache_bust(tmp_path)
    page = (js / "page.js").read_text()
    assert "00000001" not in page
    assert re.search(r"import\('\./lazy\.js\?v=[a-f0-9]{8}'\)", page)
    assert re.search(r'import\("\./other\.js\?v=[a-f0-9]{8}"\)', page)
    lazy_v = _v(page, "lazy.js")
    page_v_before = digest(js / "page.js")
    (js / "dep.js").write_text("export const x = 2;\n")
    run_cache_bust(tmp_path)
    assert _v((js / "page.js").read_text(), "lazy.js") != lazy_v
    assert digest(js / "page.js") != page_v_before
    assert run_cache_bust(tmp_path) == ([], [])


def test_module_without_imports_keeps_its_content_hash(tmp_path: Path):
    """Leaves keep the pre-#595 hash, so only importers churn once."""
    leaf = tmp_path / "leaf.js"
    leaf.write_text("export const v = 1;\n")
    expected = hashlib.md5(leaf.read_bytes()).hexdigest()[:8]
    assert digest(leaf) == expected


def test_hashes_do_not_depend_on_where_the_repo_lives(tmp_path: Path):
    """CI, the laptop and Termux check out to different paths. The same
    sources must produce the same ?v= everywhere."""
    for name in ("one", "two/nested"):
        _chain_fixture(tmp_path / name)
        run_cache_bust(tmp_path / name)
    for rel in ("js/main.js", "js/router.js", "js/home.js", "app.html"):
        assert (tmp_path / "one" / rel).read_text() == (tmp_path / "two/nested" / rel).read_text()


def test_deep_import_chain_does_not_recurse(tmp_path: Path):
    js = tmp_path / "js"
    js.mkdir()
    n = 3000
    for i in range(n):
        body = f"import {{ m{i+1} }} from './m{i+1}.js';\nexport const m{i} = m{i+1};\n" if i < n - 1 else f"export const m{i} = 0;\n"
        (js / f"m{i}.js").write_text(body)
    run_cache_bust(tmp_path)
    assert re.search(r"\./m1\.js\?v=[a-f0-9]{8}", (js / "m0.js").read_text())


def test_html_ref_to_a_missing_asset_is_left_alone(tmp_path: Path):
    _write(tmp_path / "page.html", '<script src="js/gone.js"></script><link href="css/x.css">\n')
    _write(tmp_path / "css" / "x.css", "body{}\n")
    run_cache_bust(tmp_path)
    out = (tmp_path / "page.html").read_text()
    assert 'src="js/gone.js"' in out
    assert re.search(r'href="css/x\.css\?v=[a-f0-9]{8}"', out)


def test_cli_reports_changes_then_nothing_to_do(tmp_path: Path, capsys, monkeypatch):
    from scripts import cache_bust
    _chain_fixture(tmp_path)
    monkeypatch.setattr(cache_bust.sys, "argv", ["cache_bust.py", str(tmp_path)])
    assert cache_bust.main() == 0
    first = capsys.readouterr().out
    assert "updated 3 JS file(s)" in first and "updated 1 page(s): app.html" in first
    assert cache_bust.main() == 0
    assert "all files already current" in capsys.readouterr().out
