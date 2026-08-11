import json
from pathlib import Path
from scripts.pipeline.stats import (
    normalize_gpu_vendor,
    normalize_cpu_brand,
    normalize_os_family,
    normalize_proton_type,
    normalize_device_family,
    normalize_rating,
    normalize_source,
    bucket_vram,
    extract_framegen,
    _score_to_tier,
    compute_stats,
    write_stats_json,
)


# ── normalize_gpu_vendor ──────────────────────────────────────────────────────

def test_gpu_vendor_explicit_amd():
    assert normalize_gpu_vendor({"gpuVendor": "amd"}) == "amd"

def test_gpu_vendor_explicit_nvidia():
    assert normalize_gpu_vendor({"gpuVendor": "nvidia"}) == "nvidia"

def test_gpu_vendor_explicit_intel():
    assert normalize_gpu_vendor({"gpuVendor": "intel"}) == "intel"

def test_gpu_vendor_explicit_uppercase():
    assert normalize_gpu_vendor({"gpuVendor": "AMD"}) == "amd"

def test_gpu_vendor_pattern_rtx():
    assert normalize_gpu_vendor({"gpu": "NVIDIA GeForce RTX 3080"}) == "nvidia"

def test_gpu_vendor_pattern_gtx():
    assert normalize_gpu_vendor({"gpu": "GTX 1080 Ti"}) == "nvidia"

def test_gpu_vendor_pattern_radeon():
    assert normalize_gpu_vendor({"gpu": "AMD Radeon RX 6800 XT"}) == "amd"

def test_gpu_vendor_pattern_rdna():
    assert normalize_gpu_vendor({"gpu": "RDNA 2 GPU"}) == "amd"

def test_gpu_vendor_pattern_intel_iris():
    assert normalize_gpu_vendor({"gpu": "Intel Iris Xe Graphics"}) == "intel"

def test_gpu_vendor_pattern_arc():
    assert normalize_gpu_vendor({"gpu": "Intel Arc A770"}) == "intel"

def test_gpu_vendor_unknown_empty():
    assert normalize_gpu_vendor({}) == "unknown"

def test_gpu_vendor_other():
    assert normalize_gpu_vendor({"gpu": "SomeUnknownGPU 9000"}) == "other"

def test_gpu_vendor_vangogh_explicit():
    assert normalize_gpu_vendor({"gpuVendor": "amd", "gpu": "VanGogh"}) == "amd"


# ── normalize_cpu_brand ───────────────────────────────────────────────────────

def test_cpu_brand_ryzen():
    assert normalize_cpu_brand({"cpu": "AMD Ryzen 9 7950X"}) == "amd"

def test_cpu_brand_intel_core():
    assert normalize_cpu_brand({"cpu": "Intel Core i7-12700K"}) == "intel"

def test_cpu_brand_xeon():
    assert normalize_cpu_brand({"cpu": "Intel Xeon E5-2699"}) == "intel"

def test_cpu_brand_unknown():
    assert normalize_cpu_brand({}) == "unknown"

def test_cpu_brand_other():
    assert normalize_cpu_brand({"cpu": "ARM Cortex-A55"}) == "other"

def test_cpu_brand_threadripper():
    assert normalize_cpu_brand({"cpu": "AMD Threadripper 3990X"}) == "amd"


# ── normalize_os_family ───────────────────────────────────────────────────────

def test_os_steamos():
    assert normalize_os_family({"os": "SteamOS 3.0"}) == "steamos"

def test_os_bazzite():
    assert normalize_os_family({"os": "Bazzite 2.0"}) == "bazzite"

def test_os_arch():
    assert normalize_os_family({"os": "Arch Linux"}) == "arch"

def test_os_manjaro():
    assert normalize_os_family({"os": "Manjaro KDE"}) == "arch"

def test_os_fedora():
    assert normalize_os_family({"os": "Fedora 38"}) == "fedora"

def test_os_nobara():
    assert normalize_os_family({"os": "Nobara 38"}) == "fedora"

def test_os_ubuntu():
    assert normalize_os_family({"os": "Ubuntu 22.04"}) == "ubuntu"

def test_os_mint():
    assert normalize_os_family({"os": "Linux Mint 21"}) == "ubuntu"

def test_os_debian():
    assert normalize_os_family({"os": "Debian 12"}) == "debian"

def test_os_opensuse():
    assert normalize_os_family({"os": "openSUSE Tumbleweed"}) == "opensuse"

def test_os_nixos():
    assert normalize_os_family({"os": "NixOS 23.11"}) == "nixos"

def test_os_gentoo():
    assert normalize_os_family({"os": "Gentoo Linux"}) == "gentoo"

def test_os_unknown():
    assert normalize_os_family({}) == "unknown"

def test_os_other():
    assert normalize_os_family({"os": "Some Random Distro"}) == "other"

def test_os_pop():
    assert normalize_os_family({"os": "ubuntu 22.04 (Pop derivative)"}) == "ubuntu"


# ── normalize_proton_type ─────────────────────────────────────────────────────

def test_proton_type_ge():
    assert normalize_proton_type({"protonVersion": "GE-Proton9-25"}) == "ge-proton"

def test_proton_type_ge_prefix():
    assert normalize_proton_type({"protonVersion": "GE 9-25"}) == "ge-proton"

def test_proton_type_tkg():
    assert normalize_proton_type({"protonVersion": "proton-tkg-6.5"}) == "proton-tkg"

def test_proton_type_next():
    assert normalize_proton_type({"protonVersion": "proton-next"}) == "proton-next"

def test_proton_type_experimental():
    assert normalize_proton_type({"protonVersion": "Proton Experimental"}) == "proton-experimental"

def test_proton_type_hotfix():
    assert normalize_proton_type({"protonVersion": "Proton Hotfix"}) == "proton-hotfix"

def test_proton_type_native():
    assert normalize_proton_type({"protonVersion": "native"}) == "native"

def test_proton_type_no_proton():
    assert normalize_proton_type({"protonVersion": "no proton"}) == "native"

def test_proton_type_slr():
    assert normalize_proton_type({"protonVersion": "Steam Linux Runtime"}) == "steam-linux-runtime"

def test_proton_type_stable_bare():
    assert normalize_proton_type({"protonVersion": "9.0-4"}) == "proton-stable"

def test_proton_type_stable_versioned():
    assert normalize_proton_type({"protonVersion": "10.0-3"}) == "proton-stable"

def test_proton_type_unknown():
    assert normalize_proton_type({}) == "unknown"

def test_proton_type_other():
    assert normalize_proton_type({"protonVersion": "SomeWeirdBuild"}) == "other"

def test_proton_type_proton_stable_branded():
    assert normalize_proton_type({"protonVersion": "Proton 8.0"}) == "proton-stable"

def test_proton_type_uses_proton_version_snake():
    assert normalize_proton_type({"proton_version": "GE-Proton9-1"}) == "ge-proton"


# ── normalize_device_family ───────────────────────────────────────────────────

def test_device_steam_deck_lcd():
    r = {"cpu": "AMD Custom APU 0405", "gpu": "AMD Custom GPU 0405"}
    assert normalize_device_family(r) == "steam-deck-lcd"

def test_device_steam_deck_oled():
    r = {"cpu": "AMD Custom APU 0932", "gpu": ""}
    assert normalize_device_family(r) == "steam-deck-oled"

def test_device_vangogh():
    r = {"cpu": "VanGogh", "gpu": "VanGogh"}
    assert normalize_device_family(r) == "steam-deck-lcd"

def test_device_desktop():
    r = {"cpu": "AMD Ryzen 9 7950X", "gpu": "RTX 3080"}
    assert normalize_device_family(r) == "desktop"

def test_device_unknown_empty():
    assert normalize_device_family({}) == "unknown"


# ── normalize_rating ──────────────────────────────────────────────────────────

def test_rating_platinum():
    assert normalize_rating({"rating": "platinum"}) == "platinum"

def test_rating_borked():
    assert normalize_rating({"rating": "borked"}) == "borked"

def test_rating_pending():
    assert normalize_rating({"rating": "pending"}) == "pending"

def test_rating_unknown():
    assert normalize_rating({"rating": "trash"}) == "unknown"

def test_rating_missing():
    assert normalize_rating({}) == "unknown"

def test_rating_uppercase():
    assert normalize_rating({"rating": "GOLD"}) == "gold"


# ── normalize_source ──────────────────────────────────────────────────────────

def test_source_pulse():
    assert normalize_source({"source": "pulse"}) == "pulse"

def test_source_protondb():
    assert normalize_source({"source": "protondb"}) == "protondb"

def test_source_missing_defaults_protondb():
    assert normalize_source({}) == "protondb"

def test_source_case_insensitive():
    assert normalize_source({"source": "Pulse"}) == "pulse"


# ── bucket_vram ───────────────────────────────────────────────────────────────

def test_vram_low():
    assert bucket_vram({"vramMb": 1024}) == "low"

def test_vram_mid():
    assert bucket_vram({"vramMb": 6144}) == "mid"

def test_vram_high():
    assert bucket_vram({"vramMb": 12288}) == "high"

def test_vram_zero():
    assert bucket_vram({"vramMb": 0}) == "unknown"

def test_vram_missing():
    assert bucket_vram({}) == "unknown"

def test_vram_snake_case():
    assert bucket_vram({"vram_mb": 8192}) == "high"

def test_vram_invalid():
    assert bucket_vram({"vramMb": "bad"}) == "unknown"


# ── extract_framegen ──────────────────────────────────────────────────────────

def test_framegen_yes():
    assert extract_framegen({"formResponses": {"requiresFramegen": "yes"}}) == "yes"

def test_framegen_no():
    assert extract_framegen({"formResponses": {"requiresFramegen": "no"}}) == "no"

def test_framegen_null():
    assert extract_framegen({"formResponses": {"requiresFramegen": None}}) is None

def test_framegen_missing_field():
    assert extract_framegen({"formResponses": {}}) is None

def test_framegen_missing_form_responses():
    assert extract_framegen({}) is None

def test_framegen_invalid_value():
    assert extract_framegen({"formResponses": {"requiresFramegen": "maybe"}}) is None

def test_framegen_non_dict_form_responses():
    assert extract_framegen({"formResponses": "yes"}) is None


# ── _score_to_tier ────────────────────────────────────────────────────────────

def test_score_platinum():
    assert _score_to_tier(80.0) == "platinum"

def test_score_gold():
    assert _score_to_tier(60.0) == "gold"

def test_score_silver():
    assert _score_to_tier(40.0) == "silver"

def test_score_bronze():
    assert _score_to_tier(20.0) == "bronze"

def test_score_borked():
    assert _score_to_tier(19.9) == "borked"

def test_score_hundred():
    assert _score_to_tier(100.0) == "platinum"


# ── compute_stats ─────────────────────────────────────────────────────────────

def _make_year_file(data_path, app_id, year, reports):
    app_dir = data_path / str(app_id)
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / f"{year}.json").write_text(json.dumps(reports))


def test_compute_stats_basic(tmp_path):
    # Decoupled from ProtonDB (#474): fixtures use source=pulse now. The
    # aggregation logic being verified here is source-agnostic; a separate
    # test below covers the protondb-filter behavior explicitly.
    _make_year_file(tmp_path, "730", "2023", [
        {"rating": "gold", "gpu": "RTX 3080", "cpu": "Intel Core i7", "os": "Arch Linux",
         "protonVersion": "9.0-4", "source": "pulse", "timestamp": 1700000000},
    ])
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 1
    assert stats["total_games"] == 1
    assert stats["by_rating"]["gold"] == 1
    assert stats["by_gpu_vendor"]["nvidia"] == 1
    assert stats["by_cpu_brand"]["intel"] == 1
    assert stats["by_os_family"]["arch"] == 1
    assert stats["by_proton_type"]["proton-stable"] == 1
    assert stats["by_source"]["pulse"] == 1


def test_compute_stats_ignores_protondb_source(tmp_path):
    # Decoupled from ProtonDB (#474): archive rows still on disk must not
    # contribute anything to stats.
    _make_year_file(tmp_path, "730", "2023", [
        {"rating": "gold", "source": "protondb", "timestamp": 1700000000,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
        {"rating": "borked", "source": "protondb", "timestamp": 1700000001,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 0
    assert stats["total_games"] == 0
    assert "protondb" not in stats["by_source"]


def test_compute_stats_mixed_source_counts_pulse_only(tmp_path):
    # Decoupled from ProtonDB (#474): a year file that mixes both sources
    # only counts the pulse row.
    _make_year_file(tmp_path, "730", "2023", [
        {"rating": "gold", "source": "protondb", "timestamp": 1700000000,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
        {"rating": "platinum", "source": "pulse", "timestamp": 1700000001,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 1
    assert stats["by_rating"].get("platinum") == 1
    assert stats["by_rating"].get("gold", 0) == 0


def test_compute_stats_empty_dir(tmp_path):
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 0
    assert stats["total_games"] == 0


def test_compute_stats_pulse_source(tmp_path):
    _make_year_file(tmp_path, "570", "2024", [
        {"rating": "platinum", "source": "pulse", "timestamp": 1700000001,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert stats["games_with_pulse"] == 1
    assert stats["by_source"]["pulse"] == 1


def test_compute_stats_skips_reserved_files(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "latest.json").write_text('[{"rating":"gold","timestamp":1}]')
    (app_dir / "index.json").write_text('["2024"]')
    (app_dir / "metadata.json").write_text('{}')
    (app_dir / "votes.json").write_text('{}')
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 0


def test_compute_stats_framegen(tmp_path):
    _make_year_file(tmp_path, "730", "2024", [
        {"rating": "gold", "source": "pulse", "timestamp": 1700000001,
         "formResponses": {"requiresFramegen": "yes"}, "gpu": "RTX 3080",
         "cpu": "", "os": "", "protonVersion": ""},
        {"rating": "gold", "source": "pulse", "timestamp": 1700000002,
         "formResponses": {"requiresFramegen": "no"}, "gpu": "RTX 3080",
         "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert stats["framegen_total_responses"] == 2
    assert stats["framegen_yes_count"] == 1


def test_compute_stats_stale_borked(tmp_path):
    _make_year_file(tmp_path, "730", "2020", [
        {"rating": "borked", "source": "pulse", "timestamp": 1577836800,
         "title": "Broken Game", "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert stats["stale_borked_count"] >= 1


def test_compute_stats_cross_tabs(tmp_path):
    _make_year_file(tmp_path, "730", "2023", [
        {"rating": "platinum", "gpu": "RTX 3080", "cpu": "", "os": "",
         "source": "pulse", "timestamp": 1700000000, "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert "nvidia" in stats["by_rating_x_gpu_vendor"]
    assert stats["by_rating_x_gpu_vendor"]["nvidia"]["platinum"] == 1


def test_compute_stats_year_bucketing(tmp_path):
    _make_year_file(tmp_path, "730", "2023", [
        {"rating": "gold", "source": "pulse", "timestamp": 1700000000,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert "2023" in stats["by_year"]
    assert stats["by_year"]["2023"] == 1


def test_compute_stats_top_games(tmp_path):
    for i in range(3):
        _make_year_file(tmp_path, f"10{i}", "2023",
                        [{"rating": "gold", "source": "pulse", "timestamp": 1700000000 + i,
                          "title": f"Game {i}", "gpu": "", "cpu": "", "os": "", "protonVersion": ""}] * (i + 1))
    stats = compute_stats(tmp_path)
    assert len(stats["top_games"]) <= 50


def test_write_stats_json(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _make_year_file(data_dir, "730", "2023", [
        {"rating": "gold", "source": "pulse", "timestamp": 1700000000,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    write_stats_json(data_dir, tmp_path)
    assert (tmp_path / "stats.json").exists()
    stats = json.loads((tmp_path / "stats.json").read_text())
    assert stats["total_reports"] == 1


def test_compute_stats_by_year_source(tmp_path):
    _make_year_file(tmp_path, "730", "2023", [
        {"rating": "gold", "source": "pulse", "timestamp": 1700000000,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert stats["by_year_source"]["2023"]["pulse"] == 1


def test_compute_stats_device_family(tmp_path):
    _make_year_file(tmp_path, "730", "2023", [
        {"rating": "gold", "source": "pulse", "timestamp": 1700000000,
         "cpu": "AMD Custom APU 0405", "gpu": "AMD Custom GPU 0405",
         "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert stats["by_device_family"]["steam-deck-lcd"] == 1


def test_compute_stats_vram_framegen_cross(tmp_path):
    _make_year_file(tmp_path, "730", "2024", [
        {"rating": "gold", "source": "pulse", "timestamp": 1700000001,
         "formResponses": {"requiresFramegen": "yes"}, "vramMb": 8192,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert "high" in stats["by_vram_x_framegen"]


# ── _iter_year_files edge cases ───────────────────────────────────────────────

def test_compute_stats_skips_non_directory_files(tmp_path):
    # Place a file (not dir) directly in data_path to hit the `continue` branch
    (tmp_path / "notadir.txt").write_text("hello")
    _make_year_file(tmp_path, "730", "2024", [
        {"rating": "gold", "source": "pulse", "timestamp": 1700000000,
         "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
    ])
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 1

def test_compute_stats_skips_corrupt_year_file(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text("not json at all")
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 0

def test_compute_stats_skips_non_list_year_file(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text('{"not": "a list"}')
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 0

def test_compute_stats_skips_empty_reports_list(tmp_path):
    _make_year_file(tmp_path, "730", "2024", [])
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 0

def test_compute_stats_skips_non_dict_report_entries(tmp_path):
    app_dir = tmp_path / "730"
    app_dir.mkdir()
    (app_dir / "2024.json").write_text(json.dumps(["not", "a", "dict"]))
    stats = compute_stats(tmp_path)
    assert stats["total_reports"] == 0

def test_compute_stats_framegen_below_threshold_skipped(tmp_path):
    # Only 2 framegen responses -- below FRAMEGEN_MIN_RESPONSES=3, so no entry
    for i in range(2):
        _make_year_file(tmp_path, f"73{i}", "2024", [
            {"rating": "gold", "source": "pulse", "timestamp": 1700000000 + i,
             "formResponses": {"requiresFramegen": "yes"}, "vramMb": 8192,
             "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
        ])
    stats = compute_stats(tmp_path)
    assert stats.get("top_framegen_games", []) == []

def test_compute_stats_framegen_zero_yes_pct_skipped(tmp_path):
    # All "no" framegen answers = yes_pct is 0, should be skipped
    for i in range(3):
        _make_year_file(tmp_path, f"73{i}", "2024", [
            {"rating": "gold", "source": "pulse", "timestamp": 1700000000 + i,
             "formResponses": {"requiresFramegen": "no"}, "vramMb": 8192,
             "gpu": "", "cpu": "", "os": "", "protonVersion": ""},
        ])
    stats = compute_stats(tmp_path)
    assert stats.get("top_framegen_games", []) == []
