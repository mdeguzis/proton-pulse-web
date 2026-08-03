"""Regression guards for the shared head/scripts helpers used by the pipeline-
generated top-level pages (coverage.html, data-index.html). #448.

Motivating incident: both pages linked bare "site.css" + "topbar.js" at the
repo root -- fine before the CSS/JS reorg, broken after. CF Pages returns the
SPA fallback for any missing path, so the pages rendered unstyled with no
topbar and read as "abysmal" design instead of a plain broken-link bug.
These tests keep the head + tail wiring pinned to the post-reorg paths and
make sure no future change can quietly reintroduce the bare references.
"""

from pathlib import Path

from scripts.pipeline import finalize


def test_head_links_the_shared_css_bundle():
    head = "\n".join(finalize._pipeline_page_head("Test Page"))
    # Match about.html's CSS cascade order exactly. If about.html adds one
    # (e.g. a new shared/foo.css) the pipeline pages should stay in sync --
    # this list is the mirror, so an intentional site-wide addition
    # requires a same-diff update here.
    assert 'href="css/shared/base.css"' in head
    assert 'href="css/shared/topbar.css"' in head
    assert 'href="css/shared/site.css"' in head
    assert 'href="css/shared/cards.css"' in head


def test_head_no_bare_root_paths():
    head = "\n".join(finalize._pipeline_page_head("Test Page"))
    assert 'href="site.css"' not in head
    assert 'src="topbar.js"' not in head


def test_head_sets_title_and_viewport_and_dark_scheme():
    head = "\n".join(finalize._pipeline_page_head("Custom Title"))
    assert "<title>Custom Title</title>" in head
    assert 'name="viewport"' in head
    assert 'content="dark"' in head


def test_head_declares_content_security_policy():
    # Same CSP as about.html so the pipeline pages inherit the site's
    # security posture. The Supabase CDN + inline styles are both allowed.
    head = "\n".join(finalize._pipeline_page_head("Test"))
    assert 'http-equiv="Content-Security-Policy"' in head
    assert "cdn.jsdelivr.net" in head
    assert "'unsafe-inline'" in head


def test_head_inlines_extra_style_when_provided():
    head = "\n".join(finalize._pipeline_page_head("Test", extra_style="body{color:red}"))
    assert "<style>body{color:red}</style>" in head


def test_head_omits_style_tag_when_no_extra():
    head = "\n".join(finalize._pipeline_page_head("Test"))
    assert "<style>" not in head


def test_scripts_load_topbar_and_deps_from_js_lib():
    scripts = "\n".join(finalize._pipeline_page_scripts())
    # topbar.js drives the injected banner + nav. Its deps must load first
    # so the topbar can wire up the user chip and analytics without racing.
    for src in (
        "js/lib/supabase-client.js",
        "js/lib/log-buffer.js",
        "js/lib/analytics.js",
        "js/lib/topbar.js",
        "js/lib/toast.js",
    ):
        assert f'src="{src}"' in scripts, f"missing {src} in scripts tail"


def test_scripts_no_bare_root_paths():
    scripts = "\n".join(finalize._pipeline_page_scripts())
    assert 'src="topbar.js"' not in scripts
    assert 'src="supabase-client.js"' not in scripts


def test_generator_functions_use_the_helpers():
    """No bare 'site.css' or 'topbar.js' in the generator output paths.

    Read the source of finalize.py and scan every HTML-generating function
    for the old flat paths. Comments and the docstring in _SHARED_CSS may
    mention "site.css" as history -- match only the actual output form.
    """
    src = Path(finalize.__file__).read_text()
    assert 'href="site.css"' not in src, "generator still links to root site.css"
    assert 'src="topbar.js"' not in src, "generator still scripts root topbar.js"
    assert 'src="supabase-client.js"' not in src, (
        "generator still scripts root supabase-client.js"
    )
