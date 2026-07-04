"""Tests for scripts/pipeline/hardware_suggestions.py (GPU/CPU/OS suggestions)."""

import json
import os
from unittest.mock import patch

from scripts.pipeline import hardware_suggestions as hs

# A representative slice of pci.ids: a vendor header (no leading tab), device
# lines (one leading tab, "id  name"), a sub-device line (two tabs, ignored),
# non-GPU devices, and a non-GPU vendor whose GPU-looking device must be skipped.
SAMPLE_PCI_IDS = "\n".join([
    "# comment line",
    "10de  NVIDIA Corporation",
    "\t2482  GA102 [GeForce RTX 3070 Ti]",
    "\t\t1028 3984  sub-device should be ignored",
    "\t1234  NVIDIA High Definition Audio Controller",
    "1002  Advanced Micro Devices, Inc. [AMD/ATI]",
    "\t73df  Navi 22 [Radeon RX 6700 XT]",
    "8086  Intel Corporation",
    "\t56a0  DG2 [Arc A770]",
    "\t7ae0  Alder Lake USB Controller",
    "9999  Some Other Vendor",
    "\tabcd  GeForce Fake From Wrong Vendor",
])


def test_extract_gpu_names_pulls_bracketed_marketing_names():
    names = hs.extract_gpu_names(SAMPLE_PCI_IDS)
    assert "GeForce RTX 3070 Ti" in names
    assert "Radeon RX 6700 XT" in names
    assert "Arc A770" in names


def test_extract_gpu_names_filters_non_gpu_and_wrong_vendor():
    names = hs.extract_gpu_names(SAMPLE_PCI_IDS)
    # audio / USB devices are dropped even under a GPU vendor
    assert not any("Audio" in n for n in names)
    assert not any("USB" in n for n in names)
    # a GeForce-looking device under a non-GPU vendor is not collected
    assert "GeForce Fake From Wrong Vendor" not in names


def test_extract_gpu_names_returns_sorted_unique():
    names = hs.extract_gpu_names(SAMPLE_PCI_IDS)
    assert names == sorted(names)
    assert len(names) == len(set(names))


def test_run_writes_json_with_gpu_cpu_os(tmp_path):
    with patch.object(hs, "fetch_pci_ids", return_value=SAMPLE_PCI_IDS):
        out_path = hs.run(output_dir=str(tmp_path))

    assert os.path.exists(out_path)
    data = json.loads(open(out_path).read())
    assert set(data.keys()) == {"gpu", "cpu", "os"}
    assert data["cpu"] == hs.CURATED_CPUS
    assert data["os"] == hs.CURATED_OS
    assert "GeForce RTX 3070 Ti" in data["gpu"]


def test_run_defaults_output_dir_from_env(tmp_path):
    with patch.object(hs, "fetch_pci_ids", return_value=SAMPLE_PCI_IDS), \
         patch.dict(os.environ, {"OUTPUT_DIR": str(tmp_path)}):
        out_path = hs.run()
    assert out_path == os.path.join(str(tmp_path), "hardware-suggestions.json")


def test_fetch_pci_ids_uses_urlopen():
    class _Resp:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return SAMPLE_PCI_IDS.encode("utf-8")

    with patch("urllib.request.urlopen", return_value=_Resp()) as m:
        text = hs.fetch_pci_ids()
    assert "GeForce" in text
    assert m.called
