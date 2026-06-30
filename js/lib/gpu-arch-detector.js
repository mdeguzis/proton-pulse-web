/**
 * GPU architecture detection from a model name string.
 * Returns a short architecture label (e.g. "RDNA2", "Ada", "Polaris")
 * or an empty string when the model is unrecognised.
 *
 * Checks run from most-specific to least-specific within each vendor so
 * that e.g. "RTX 4090" matches Ada before the broader NVIDIA patterns fire.
 */

export function detectGpuArch(gpu) {
  if (!gpu) return '';
  const s = gpu.toLowerCase();

  // ---- AMD ----------------------------------------------------------------

  // RDNA4 — RX 9xxx (e.g. RX 9070)
  if (/\brx\s*9\d{3}\b/.test(s)) return 'RDNA4';

  // RDNA3 — RX 7xxx (e.g. RX 7900 XTX, RX 7600)
  if (/\brx\s*7\d{3}\b/.test(s)) return 'RDNA3';

  // RDNA2 — RX 6xxx or Van Gogh (Steam Deck APU)
  if (/\brx\s*6\d{3}\b/.test(s) || /vangogh|van gogh/.test(s)) return 'RDNA2';

  // RDNA (1st gen) — RX 5xxx
  if (/\brx\s*5\d{3}\b/.test(s)) return 'RDNA';

  // Vega — RX Vega 56/64, Radeon VII
  if (/vega\s*\d+|radeon\s+vii/.test(s)) return 'Vega';

  // Polaris — RX 4xx/5xx (discrete, not RDNA RX 5xxx already matched above)
  if (/\brx\s*[45][0-9]{2}\b/.test(s)) return 'Polaris';

  // GCN3 — Tonga/Fiji: R9 Fury, R9 Nano, R9 285, R9 380/390
  // #151: dropped "R9 280" from the GCN3 set -- it's GCN2 (Tahiti). Only
  // R9 285 (Tonga) belongs here.
  if (/r9\s*(fury|nano)|r9\s*3[89]0|r9\s*285/.test(s)) return 'GCN3';

  // GCN2 — Sea Islands: R9 270/280, R7 260/265
  if (/r[79]\s*2[678]\d/.test(s)) return 'GCN2';

  // GCN1 — Southern Islands: HD 7xxx
  if (/hd\s*7[0-9]{3}/.test(s)) return 'GCN1';

  // ---- Intel --------------------------------------------------------------
  // #151: Intel block runs BEFORE NVIDIA so the Arc A-series doesn't get
  // swallowed by NVIDIA Ampere's `\ba\d{3,4}\b` workstation fallback.
  // Architectures are distinct across vendors so reorder is safe.

  // Arc Battlemage — Arc B-series (B580, B770)
  if (/arc\s*b\d{3}/.test(s)) return 'Battlemage';

  // Arc Alchemist — Arc A-series (A380, A750, A770)
  if (/arc\s*a\d{3}/.test(s) || /\balchemist\b/.test(s)) return 'Alchemist';

  // Xe / Gen12 — Iris Xe, UHD 7xx (Tiger Lake / Alder Lake). Allow an
  // optional "graphics" word between UHD and the model number so e.g.
  // "Intel UHD Graphics 770" matches.
  if (/iris\s*xe|uhd(?:\s+graphics)?\s*7[0-9]{2}/.test(s)) return 'Xe';

  // Gen9 — HD 5xx/6xx, UHD 6xx (Skylake/Kaby Lake/Coffee Lake). Same
  // optional "graphics" affordance as Xe.
  if (/(?:^|\W)hd(?:\s+graphics)?\s*[56]\d{2}|uhd(?:\s+graphics)?\s*6[0-9]{2}/.test(s)) return 'Gen9';

  // ---- NVIDIA -------------------------------------------------------------

  // Blackwell — RTX 5xxx (e.g. RTX 5090)
  if (/rtx\s*5\d{3}/.test(s)) return 'Blackwell';

  // Ada Lovelace — RTX 4xxx (e.g. RTX 4090, RTX 4060 Ti)
  if (/rtx\s*4\d{3}/.test(s)) return 'Ada';

  // Ampere — RTX 3xxx (e.g. RTX 3080) or workstation A-series (A100, A4000)
  if (/rtx\s*3\d{3}/.test(s) || /\ba\d{3,4}\b/.test(s)) return 'Ampere';

  // Turing — RTX 2xxx, GTX 1650/1660
  if (/rtx\s*2\d{3}/.test(s) || /gtx\s*16[56]\d/.test(s)) return 'Turing';

  // Pascal — GTX 1050/1060/1070/1080 (range widened from 10[567] to 10[5-8]
  // so the GTX 1080 flagship matches; #151).
  if (/gtx\s*10[5-8]\d/.test(s)) return 'Pascal';

  // Maxwell — GTX 9xx, GTX 750 (not GTX 760+ which are Kepler)
  if (/gtx\s*9[0-9]{2}/.test(s) || /gtx\s*750/.test(s)) return 'Maxwell';

  // Kepler — GTX 6xx, GTX 7xx (excepting 750 already matched)
  if (/gtx\s*[67]\d{2}/.test(s)) return 'Kepler';

  return '';
}
