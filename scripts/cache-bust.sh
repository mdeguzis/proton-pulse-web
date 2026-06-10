#!/usr/bin/env bash
# cache-bust.sh - append a content-hash ?v= to every local css/ and js/
# reference in the site's HTML pages AND to relative ES module import/export
# statements inside JS files, so a deploy invalidates browser and CDN cache
# for exactly the assets that changed.
#
# Idempotent: re-running with no asset changes rewrites nothing. Run it before
# committing CSS/JS changes (it is wired into `make build`).
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import re, hashlib, glob, os

def digest(path):
    return hashlib.md5(open(path, 'rb').read()).hexdigest()[:8]

# --- Pass 1: version relative imports inside JS files ---
# Matches: import ... from './foo.js' or '../bar.js' (with or without existing ?v=)
# Also matches: export ... from './foo.js'
JS_IMPORT = re.compile(
    r"""((?:import|export)\s[^'"]*from\s*['"])(\.[^'"?]+?)((?:\?v=[a-f0-9]+)?['"])"""
)

js_changed = []
for js_file in sorted(glob.glob('js/**/*.js', recursive=True)):
    src = open(js_file, encoding='utf-8').read()
    base_dir = os.path.dirname(js_file)

    def repl_js(m):
        pre, specifier, post = m.group(1), m.group(2), m.group(3)
        # strip any existing ?v= from post (quote char only remains)
        quote = post[-1]
        abs_path = os.path.normpath(os.path.join(base_dir, specifier))
        if not os.path.isfile(abs_path):
            return m.group(0)
        return f'{pre}{specifier}?v={digest(abs_path)}{quote}'

    out = JS_IMPORT.sub(repl_js, src)
    if out != src:
        open(js_file, 'w', encoding='utf-8').write(out)
        js_changed.append(js_file)

# --- Pass 2: version src/href references inside HTML files ---
HTML_REF = re.compile(r'(?P<attr>src|href)="(?P<path>(?:css|js)/[^"?]+)(?:\?v=[a-f0-9]+)?"')

html_changed = []
for html in sorted(glob.glob('*.html')):
    src = open(html, encoding='utf-8').read()

    def repl_html(m):
        path = m.group('path')
        if not os.path.isfile(path):
            return m.group(0)
        return f'{m.group("attr")}="{path}?v={digest(path)}"'

    out = HTML_REF.sub(repl_html, src)
    if out != src:
        open(html, 'w', encoding='utf-8').write(out)
        html_changed.append(html)

total = len(js_changed) + len(html_changed)
if total:
    if js_changed:
        print(f"cache-bust: updated {len(js_changed)} JS file(s): {', '.join(js_changed)}")
    if html_changed:
        print(f"cache-bust: updated {len(html_changed)} page(s): {', '.join(html_changed)}")
else:
    print("cache-bust: all files already current, nothing to do.")
PY
