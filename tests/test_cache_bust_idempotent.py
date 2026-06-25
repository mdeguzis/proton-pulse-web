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
