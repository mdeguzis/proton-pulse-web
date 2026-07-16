"""Generate hardware-suggestions.json from pci.ids for GPU autocomplete.

Downloads the PCI IDs database (updated daily by pciutils), extracts GPU
device names for NVIDIA/AMD/Intel using keyword filtering, and writes a
JSON file with sorted unique model names. Also includes a curated CPU list
from the Steam Hardware Survey top models.

Output: /tmp/protondb-output/hardware-suggestions.json
"""

import json
import os
import re
import urllib.request

PCI_IDS_URL = 'https://pci-ids.ucw.cz/v2.2/pci.ids'

GPU_VENDORS = {
    '10de': 'nvidia',
    '1002': 'amd',
    '8086': 'intel',
}

GPU_KEYWORDS_NVIDIA = re.compile(
    r'GeForce|GTX|RTX|Quadro|Tesla|TITAN', re.IGNORECASE
)
GPU_KEYWORDS_AMD = re.compile(
    r'Radeon|RX\s|Vega|Navi|FirePro', re.IGNORECASE
)
GPU_KEYWORDS_INTEL = re.compile(
    r'Arc\s[A-Z]|Iris\s|UHD Graphics|HD Graphics|\bXe\b', re.IGNORECASE
)

VENDOR_KEYWORDS = {
    '10de': GPU_KEYWORDS_NVIDIA,
    '1002': GPU_KEYWORDS_AMD,
    '8086': GPU_KEYWORDS_INTEL,
}

BRACKET_RE = re.compile(r'\[(.+?)\]')

CURATED_OS = [
    'Arch Linux',
    'Bazzite',
    'CachyOS',
    'ChimeraOS',
    'Debian',
    'Debian 12',
    'Debian 13',
    'EndeavourOS',
    'Fedora',
    'Fedora 40',
    'Fedora 41',
    'Fedora 42',
    'Garuda Linux',
    'Gentoo',
    'Linux Mint',
    'Linux Mint 22',
    'Manjaro',
    'Nobara',
    'Nobara 40',
    'Nobara 41',
    'NixOS',
    'openSUSE Tumbleweed',
    'Pop!_OS',
    'Pop!_OS 22.04',
    'SteamOS',
    'SteamOS 3.5',
    'SteamOS 3.6',
    'Ubuntu',
    'Ubuntu 22.04',
    'Ubuntu 24.04',
    'Ubuntu 24.10',
    'Void Linux',
    'Zorin OS',
]

CURATED_CPUS = [
    # Steam Deck APUs
    'AMD Custom APU 0405',
    'AMD Custom APU 0932',
    # AMD Ryzen 3000 series
    'AMD Ryzen 5 3600',
    'AMD Ryzen 5 3600X',
    'AMD Ryzen 7 3700X',
    'AMD Ryzen 7 3800X',
    'AMD Ryzen 9 3900X',
    'AMD Ryzen 9 3950X',
    # AMD Ryzen 5000 series
    'AMD Ryzen 5 5500',
    'AMD Ryzen 5 5600',
    'AMD Ryzen 5 5600X',
    'AMD Ryzen 5 5600G',
    'AMD Ryzen 7 5700X',
    'AMD Ryzen 7 5800X',
    'AMD Ryzen 7 5800X3D',
    'AMD Ryzen 9 5900X',
    'AMD Ryzen 9 5950X',
    # AMD Ryzen 7000 series
    'AMD Ryzen 5 7600',
    'AMD Ryzen 5 7600X',
    'AMD Ryzen 7 7700X',
    'AMD Ryzen 7 7800X3D',
    'AMD Ryzen 9 7900X',
    'AMD Ryzen 9 7900X3D',
    'AMD Ryzen 9 7950X',
    'AMD Ryzen 9 7950X3D',
    # AMD Ryzen 9000 series
    'AMD Ryzen 5 9600X',
    'AMD Ryzen 7 9700X',
    'AMD Ryzen 7 9800X3D',
    'AMD Ryzen 9 9900X',
    'AMD Ryzen 9 9950X',
    # AMD mobile
    'AMD Ryzen 5 5600H',
    'AMD Ryzen 7 5800H',
    'AMD Ryzen 7 6800H',
    'AMD Ryzen 7 7840HS',
    'AMD Ryzen 9 7945HX',
    'AMD Ryzen AI 9 HX 370',
    # Intel 10th gen
    'Intel Core i5-10400',
    'Intel Core i5-10400F',
    'Intel Core i7-10700',
    'Intel Core i7-10700K',
    'Intel Core i9-10900K',
    # Intel 11th gen
    'Intel Core i5-11400',
    'Intel Core i5-11600K',
    'Intel Core i7-11700K',
    'Intel Core i9-11900K',
    # Intel 12th gen
    'Intel Core i3-12100',
    'Intel Core i3-12100F',
    'Intel Core i5-12400',
    'Intel Core i5-12400F',
    'Intel Core i5-12600K',
    'Intel Core i7-12700',
    'Intel Core i7-12700K',
    'Intel Core i9-12900K',
    'Intel Core i9-12900KS',
    # Intel 13th gen
    'Intel Core i5-13400',
    'Intel Core i5-13600K',
    'Intel Core i5-13600KF',
    'Intel Core i7-13700K',
    'Intel Core i7-13700KF',
    'Intel Core i9-13900K',
    'Intel Core i9-13900KS',
    # Intel 14th gen
    'Intel Core i5-14400',
    'Intel Core i5-14600K',
    'Intel Core i5-14600KF',
    'Intel Core i7-14700K',
    'Intel Core i7-14700KF',
    'Intel Core i9-14900K',
    'Intel Core i9-14900KS',
    # Intel Core Ultra (mobile)
    'Intel Core Ultra 5 125U',
    'Intel Core Ultra 5 125H',
    'Intel Core Ultra 7 155H',
    'Intel Core Ultra 7 155U',
    'Intel Core Ultra 9 185H',
    # Intel Core Ultra 200 series
    'Intel Core Ultra 5 225',
    'Intel Core Ultra 5 245K',
    'Intel Core Ultra 7 265K',
    'Intel Core Ultra 9 285K',
]


def fetch_pci_ids():
    print(f'[hardware_suggestions] Downloading {PCI_IDS_URL}')
    req = urllib.request.Request(PCI_IDS_URL, headers={'User-Agent': 'proton-pulse-pipeline/1.0'})
    # URL from hardcoded PCI_IDS_URL constant (pci-ids.ucw.cz)
    with urllib.request.urlopen(req, timeout=30) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        return resp.read().decode('utf-8', errors='replace')


def extract_gpu_names(pci_text):
    gpus = set()
    current_vendor = None

    for line in pci_text.splitlines():
        if not line or line.startswith('#'):
            continue
        if line[0] != '\t':
            vid = line[:4].strip().lower()
            current_vendor = vid if vid in GPU_VENDORS else None
            continue
        if current_vendor and line[0] == '\t' and (len(line) < 2 or line[1] != '\t'):
            device_name = line.strip().split('  ', 1)[-1] if '  ' in line.strip() else line.strip()[4:].strip()
            kw = VENDOR_KEYWORDS.get(current_vendor)
            if not kw or not kw.search(device_name):
                continue
            bracket = BRACKET_RE.search(device_name)
            name = bracket.group(1) if bracket else device_name
            name = name.strip()
            if name and len(name) > 3 and not name.startswith('PCI'):
                if re.search(r'Audio|Modem|IDE |IPMI|LAN |USB |Bridge|SATA|Ethernet|Serial|Memory Controller Hub', name, re.IGNORECASE):
                    continue
                gpus.add(name)

    return sorted(gpus)


def run(output_dir=None):
    if output_dir is None:
        output_dir = os.environ.get('OUTPUT_DIR', '/tmp/protondb-output')
    os.makedirs(output_dir, exist_ok=True)

    pci_text = fetch_pci_ids()
    gpus = extract_gpu_names(pci_text)
    print(f'[hardware_suggestions] Extracted {len(gpus)} GPU models')

    result = {
        'gpu': gpus,
        'cpu': CURATED_CPUS,
        'os': CURATED_OS,
    }

    out_path = os.path.join(output_dir, 'hardware-suggestions.json')
    with open(out_path, 'w') as f:
        json.dump(result, f, separators=(',', ':'))
    print(f'[hardware_suggestions] Wrote {out_path} ({os.path.getsize(out_path)} bytes)')
    return out_path


if __name__ == '__main__':
    run()
