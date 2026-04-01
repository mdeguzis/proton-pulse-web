from pathlib import Path
import json

from scripts.split_reports import generate_index_html, generate_app_indexes


def test_index_html_created(tmp_path):
    keys = {("730", "2020"), ("730", "2019")}
    generate_index_html(keys, tmp_path)
    assert (tmp_path / "index.html").exists()


def test_appids_sorted_numerically(tmp_path):
    # "4000" must come after "730" numerically, not before it lexicographically
    # Search within the <summary> tags to avoid hits in the popular-titles section
    keys = {("4000", "2021"), ("570", "2022"), ("730", "2020")}
    generate_index_html(keys, tmp_path)
    html = (tmp_path / "index.html").read_text()
    pos_570 = html.index("<summary>570/</summary>")
    pos_730 = html.index("<summary>730/</summary>")
    pos_4000 = html.index("<summary>4000/</summary>")
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


# ─── generate_app_indexes ─────────────────────────────────────────────────────

def test_app_index_created(tmp_path):
    keys = {("730", "2020"), ("730", "2019")}
    data_dir = tmp_path / "data"
    generate_app_indexes(keys, data_dir)
    assert (data_dir / "730" / "index.json").exists()


def test_app_index_contains_sorted_years(tmp_path):
    keys = {("730", "2022"), ("730", "2019"), ("730", "2021")}
    data_dir = tmp_path / "data"
    generate_app_indexes(keys, data_dir)
    years = json.loads((data_dir / "730" / "index.json").read_text())
    assert years == ["2019", "2021", "2022"]


def test_app_index_multiple_apps(tmp_path):
    keys = {("730", "2020"), ("570", "2021"), ("570", "2022")}
    data_dir = tmp_path / "data"
    generate_app_indexes(keys, data_dir)
    assert json.loads((data_dir / "730" / "index.json").read_text()) == ["2020"]
    assert json.loads((data_dir / "570" / "index.json").read_text()) == ["2021", "2022"]


def test_app_index_unknown_year_included(tmp_path):
    keys = {("730", "2020"), ("730", "unknown")}
    data_dir = tmp_path / "data"
    generate_app_indexes(keys, data_dir)
    years = json.loads((data_dir / "730" / "index.json").read_text())
    assert "unknown" in years
    assert "2020" in years
