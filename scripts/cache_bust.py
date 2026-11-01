"""Idempotent content-hash cache-busting for HTML pages and ES module imports.

A JS file's `?v=` must change whenever anything it loads changes, not only
when its own source does (#595). Browsers cache js/ for hours
(`max-age=14400`), so if router.js keeps the same `?v=` after home.js changes,
a returning visitor reuses the cached router.js, which still imports the old
home.js. The page then runs old code until the cache expires.

So the hash of a JS module covers its own *stripped* source (existing `?v=`
params removed) plus the hashes of every relative module it imports,
statically or via `import()`. Import cycles (router.js <-> components) are
handled as a group: each strongly connected component gets one hash from its
members' sources and the hashes of the groups it depends on, and each member
mixes that with its own source. Everything is derived from stripped content,
so a second run produces identical output (the #36 idempotency guarantee),
and the hashes contain no paths, so they match on every machine.

A module with no relative imports keeps the plain md5-of-stripped-source hash
it always had. CSS and other non-JS assets hash their own content only.

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
# before hashing makes every hash a pure function of source code, so import
# cycles can't prevent convergence.
CACHE_BUST_RE = re.compile(rb"\?v=[a-f0-9]{8}")

# Relative ES module specifier: import|export ... from './foo.js' or '../bar.js'
JS_IMPORT_RE = re.compile(
    r"""((?:import|export)\s[^'"]*from\s*['"])(\.[^'"?]+?)(\?v=[a-f0-9]+)?(['"])"""
)
# Relative dynamic import: import('./foo.js') / import("../bar.js?v=...").
# These were never versioned before #595, so lazily loaded modules went stale
# the same way.
JS_DYNAMIC_IMPORT_RE = re.compile(
    r"""(\bimport\(\s*['"])(\.[^'"?]+?)(\?v=[a-f0-9]+)?(['"]\s*\))"""
)

# <script src="js/...">, <link href="css/...">, with or without an existing ?v=
HTML_REF_RE = re.compile(
    r'(?P<attr>src|href)="(?P<path>(?:css|js)/[^"?]+)(?:\?v=[a-f0-9]+)?"'
)


def _md5(data: bytes) -> str:
    # MD5 for content cache-busting, not cryptographic security
    return hashlib.md5(data).hexdigest()  # nosemgrep: python.lang.security.insecure-hash-algorithms-md5.insecure-hash-algorithm-md5


def _stripped_bytes(path: Path) -> bytes:
    return CACHE_BUST_RE.sub(b"", path.read_bytes())


def _relative_imports(path: Path) -> list[Path]:
    """Existing files a JS module imports by relative specifier."""
    text = _stripped_bytes(path).decode("utf-8", errors="replace")
    out = []
    for rx in (JS_IMPORT_RE, JS_DYNAMIC_IMPORT_RE):
        for m in rx.finditer(text):
            target = (path.parent / m.group(2)).resolve()
            if target.is_file():
                out.append(target)
    return out


class _ModuleHasher:
    """Hashes JS modules over their import graph. One instance per run so the
    graph is walked once; results are memoised by resolved path."""

    def __init__(self) -> None:
        self._hash: dict[Path, str] = {}
        self._src_md5: dict[Path, str] = {}
        self._deps: dict[Path, list[Path]] = {}

    def _src(self, p: Path) -> str:
        if p not in self._src_md5:
            self._src_md5[p] = _md5(_stripped_bytes(p))
        return self._src_md5[p]

    def _edges(self, p: Path) -> list[Path]:
        if p not in self._deps:
            self._deps[p] = _relative_imports(p) if p.suffix == ".js" else []
        return self._deps[p]

    def full(self, path: Path) -> str:
        path = path.resolve()
        if path not in self._hash:
            self._solve(path)
        return self._hash[path]

    def _solve(self, root: Path) -> None:
        # Iterative Tarjan SCC. Components come out in reverse topological
        # order (dependencies first), so each one can be hashed as soon as it
        # is emitted.
        index: dict[Path, int] = {}
        low: dict[Path, int] = {}
        on_stack: set[Path] = set()
        stack: list[Path] = []
        counter = 0
        work: list[tuple[Path, int]] = [(root, 0)]
        while work:
            node, i = work.pop()
            if i == 0:
                # Only unvisited nodes are ever pushed with i == 0.
                index[node] = low[node] = counter
                counter += 1
                stack.append(node)
                on_stack.add(node)
            edges = self._edges(node)
            if i < len(edges):
                work.append((node, i + 1))
                nxt = edges[i]
                if nxt in self._hash:
                    continue
                if nxt not in index:
                    work.append((nxt, 0))
                elif nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
                continue
            # All edges done: propagate low-link to the parent frame.
            if work:
                parent = work[-1][0]
                if parent in low and parent in on_stack:
                    low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                members = []
                while True:
                    m = stack.pop()
                    on_stack.discard(m)
                    members.append(m)
                    if m == node:
                        break
                self._hash_component(members)

    def _hash_component(self, members: list[Path]) -> None:
        member_set = set(members)
        deps = sorted({
            self._hash[d]
            for m in members for d in self._edges(m)
            if d not in member_set
        })
        if len(members) == 1 and not deps and members[0] not in self._edges(members[0]):
            # No relative imports: the original content-only hash, unchanged.
            self._hash[members[0]] = self._src(members[0])
            return
        group = _md5(
            ",".join(sorted(self._src(m) for m in members)).encode()
            + b"|" + ",".join(deps).encode()
        )
        for m in members:
            self._hash[m] = _md5((group + self._src(m)).encode())


def digest(path: Path, hasher: _ModuleHasher | None = None) -> str:
    """8-char cache-bust hash for an asset. JS modules include their imports."""
    return (hasher or _ModuleHasher()).full(Path(path))[:8]


def _rewrite_js(js_path: Path, root: Path, hasher: _ModuleHasher) -> bool:
    src = js_path.read_text(encoding="utf-8")
    base_dir = js_path.parent

    def repl(m: re.Match[str]) -> str:
        # Groups: opening text, specifier, old ?v= (optional), closing quote
        # (plus ")" for a dynamic import).
        pre, specifier, tail = m.group(1), m.group(2), m.group(4)
        abs_path = (base_dir / specifier).resolve()
        if not abs_path.is_file():
            return m.group(0)
        return f"{pre}{specifier}?v={digest(abs_path, hasher)}{tail}"

    out = JS_DYNAMIC_IMPORT_RE.sub(repl, JS_IMPORT_RE.sub(repl, src))
    if out != src:
        js_path.write_text(out, encoding="utf-8")
        return True
    return False


def _rewrite_html(html_path: Path, root: Path, hasher: _ModuleHasher) -> bool:
    src = html_path.read_text(encoding="utf-8")

    def repl(m: re.Match[str]) -> str:
        path = root / m.group("path")
        if not path.is_file():
            return m.group(0)
        return f'{m.group("attr")}="{m.group("path")}?v={digest(path, hasher)}"'

    out = HTML_REF_RE.sub(repl, src)
    if out != src:
        html_path.write_text(out, encoding="utf-8")
        return True
    return False


def run_cache_bust(root: Path) -> tuple[list[str], list[str]]:
    """Bust JS-import and HTML-ref caches under `root`. Returns (js_changed, html_changed)."""
    root = Path(root)
    hasher = _ModuleHasher()
    js_changed: list[str] = []
    for js_file in sorted(glob(str(root / "js" / "**" / "*.js"), recursive=True)):
        if _rewrite_js(Path(js_file), root, hasher):
            js_changed.append(os.path.relpath(js_file, root))
    html_changed: list[str] = []
    for html_file in sorted(glob(str(root / "*.html"))):
        if _rewrite_html(Path(html_file), root, hasher):
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
