"""Idempotent content-hash cache-busting for HTML pages and ES module imports.

Hash is computed from the file's *stripped* content (with any existing `?v=`
parameters removed) so the hash depends only on the source code, never on what
the file happens to import. This is what makes the script idempotent in the
presence of import cycles between JS modules.

Earlier version hashed raw bytes -- file A's bytes included the hash of file B
(embedded in its imports), so if B imported A back the hashes never settled.
The router <-> components cycle in js/app/ triggered exactly that, and
`make pre-push` re-churned `?v=` values on every run. See issue #36.

Run as a CLI (`python3 scripts/cache_bust.py [root]`) or import
`run_cache_bust(root)` from tests.
"""
from __future__ import annotations

import hashlib
import os
import re
import sys
from glob import glob
from pathlib import Path

# `?v=<8 hex chars>` is the cache-bust suffix the script emits. Stripping it
# before hashing makes the hash a pure function of the file's source code, so
# import cycles can't prevent convergence.
CACHE_BUST_RE = re.compile(rb"\?v=[a-f0-9]{8}")

# Relative ES module specifier: import|export ... from './foo.js' or '../bar.js'
JS_IMPORT_RE = re.compile(
    r"""((?:import|export)\s[^'"]*from\s*['"])(\.[^'"?]+?)((?:\?v=[a-f0-9]+)?['"])"""
)

# <script src="js/...">, <link href="css/...">, with or without an existing ?v=
HTML_REF_RE = re.compile(
    r'(?P<attr>src|href)="(?P<path>(?:css|js)/[^"?]+)(?:\?v=[a-f0-9]+)?"'
)


def _stripped_bytes(path: Path) -> bytes:
    return CACHE_BUST_RE.sub(b"", path.read_bytes())


def digest(path: Path) -> str:
    return hashlib.md5(_stripped_bytes(path)).hexdigest()[:8]


def _rewrite_js(js_path: Path, root: Path) -> bool:
    src = js_path.read_text(encoding="utf-8")
    base_dir = js_path.parent

    def repl(m: re.Match[str]) -> str:
        pre, specifier, post = m.group(1), m.group(2), m.group(3)
        quote = post[-1]
        abs_path = (base_dir / specifier).resolve()
        if not abs_path.is_file():
            return m.group(0)
        return f"{pre}{specifier}?v={digest(abs_path)}{quote}"

    out = JS_IMPORT_RE.sub(repl, src)
    if out != src:
        js_path.write_text(out, encoding="utf-8")
        return True
    return False


def _rewrite_html(html_path: Path, root: Path) -> bool:
    src = html_path.read_text(encoding="utf-8")

    def repl(m: re.Match[str]) -> str:
        path = root / m.group("path")
        if not path.is_file():
            return m.group(0)
        return f'{m.group("attr")}="{m.group("path")}?v={digest(path)}"'

    out = HTML_REF_RE.sub(repl, src)
    if out != src:
        html_path.write_text(out, encoding="utf-8")
        return True
    return False


def run_cache_bust(root: Path) -> tuple[list[str], list[str]]:
    """Bust JS-import and HTML-ref caches under `root`. Returns (js_changed, html_changed)."""
    root = Path(root)
    js_changed: list[str] = []
    for js_file in sorted(glob(str(root / "js" / "**" / "*.js"), recursive=True)):
        if _rewrite_js(Path(js_file), root):
            js_changed.append(os.path.relpath(js_file, root))
    html_changed: list[str] = []
    for html_file in sorted(glob(str(root / "*.html"))):
        if _rewrite_html(Path(html_file), root):
            html_changed.append(os.path.relpath(html_file, root))
    return js_changed, html_changed


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    js_changed, html_changed = run_cache_bust(root)
    total = len(js_changed) + len(html_changed)
    if total:
        if js_changed:
            print(f"cache-bust: updated {len(js_changed)} JS file(s): {', '.join(js_changed)}")
        if html_changed:
            print(f"cache-bust: updated {len(html_changed)} page(s): {', '.join(html_changed)}")
    else:
        print("cache-bust: all files already current, nothing to do.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
