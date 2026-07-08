// Stats page utilities: constants, labels, formatters, and pivot helpers.

// Definition of every filter dimension: order shown in the UI, the cross-tab
// key in stats.json, and a label for the dropdown button.
export const FILTER_DIMS = [
  { id: 'gpu',    label: 'GPU',     statsKey: 'by_gpu_vendor',     crossKey: 'by_rating_x_gpu_vendor' },
  { id: 'cpu',    label: 'CPU',     statsKey: 'by_cpu_brand',      crossKey: 'by_rating_x_cpu_brand' },
  { id: 'os',     label: 'OS',      statsKey: 'by_os_family',      crossKey: 'by_rating_x_os_family' },
  { id: 'device', label: 'Device',  statsKey: 'by_device_family',  crossKey: 'by_rating_x_device_family' },
  { id: 'store',  label: 'Store',   statsKey: 'by_store',          crossKey: 'by_rating_x_store' },
  { id: 'source', label: 'Source',  statsKey: 'by_source',         crossKey: 'by_rating_x_source' },
  { id: 'runType', label: 'Runtime Type', statsKey: 'by_run_type',     crossKey: 'by_rating_x_run_type' },
  { id: 'rating', label: 'Rating',  statsKey: 'by_rating',         crossKey: null },
];

export function dimDef(id) { return FILTER_DIMS.find(d => d.id === id) || null; }

// Cosmetic labels for normalized tokens. Falls back to titlecase otherwise.
const PRETTY = {
  amd: 'AMD', nvidia: 'NVIDIA', intel: 'Intel',
  other: 'Other', unknown: 'Unknown',
  steamos: 'SteamOS', bazzite: 'Bazzite', arch: 'Arch / derivatives',
  fedora: 'Fedora / derivatives', ubuntu: 'Ubuntu / derivatives',
  debian: 'Debian / derivatives', opensuse: 'openSUSE',
  nixos: 'NixOS', gentoo: 'Gentoo',
  'ge-proton': 'GE-Proton', 'proton-experimental': 'Proton Experimental',
  'proton-stable': 'Proton (stable)', 'proton-hotfix': 'Proton Hotfix',
  'proton-tkg': 'Proton-TKG', 'proton-next': 'Proton Next',
  'steam-linux-runtime': 'Steam Linux Runtime',
  native: 'Native Linux',
  proton: 'Proton',
  'proton-experimental': 'Proton Experimental',
  'proton-ge': 'Proton GE',
  'proton-cachyos': 'CachyOS Proton',
  'proton-tkg': 'Proton-TKG',
  'proton-lsfg': 'Proton + LSFG',
  steam: 'Steam', gog: 'GOG', epic: 'Epic',
  protondb: 'ProtonDB', pulse: 'Pulse',
  'steam-deck-lcd': 'Steam Deck LCD',
  'steam-deck-oled': 'Steam Deck OLED',
  desktop: 'Desktop / other',
  platinum: 'Platinum', gold: 'Gold', silver: 'Silver',
  bronze: 'Bronze', borked: 'Borked', pending: 'Pending',
};

export function label(token) {
  return PRETTY[token] || (token.charAt(0).toUpperCase() + token.slice(1));
}

export function fmt(n) { return (n || 0).toLocaleString(); }

// The cross-tab payload is { dimValue: { rating: count, ... } }.
// To pivot to "ratings given dim=value" we just read cross[value].
export function pivotRatingByDim(cross, dimValue) {
  return cross[dimValue] || {};
}

// Sum across rating values to get the dim totals (after filtering by rating)
export function pivotDimByRating(cross, ratingValue) {
  const out = {};
  for (const [dim, bucket] of Object.entries(cross)) {
    out[dim] = bucket[ratingValue] || 0;
  }
  return out;
}

export function sum(obj) {
  return Object.values(obj).reduce((a, b) => a + (b || 0), 0);
}

// Round a number UP to a "nice" axis ceiling: 1, 2, or 5 * 10^N.
// Example: 47823 -> 50000, 18234 -> 20000, 700 -> 1000.
export function niceCeil(n) {
  if (!n || n < 0) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const norm = n / base;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

// Format axis label as compact (10K, 1.5M, 423) for tight rendering
export function formatAxisLabel(n) {
  if (n === 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 && n < 1e4 ? 1 : 0) + 'K';
  return String(Math.round(n));
}

// VRAM cosmetic labels (framegen-specific)
export const VRAM_PRETTY = {
  low:     'Low VRAM (<4 GB)',
  mid:     'Mid VRAM (4-8 GB)',
  high:    'High VRAM (8 GB+)',
  unknown: 'Unknown',
};

export function vramLabel(k) { return VRAM_PRETTY[k] || label(k); }

// Tier colors used by the ratings trend chart
export const TIER_COLORS = {
  platinum: '#b4c7dc',
  gold:     '#c8a050',
  silver:   '#8fa0b0',
  bronze:   '#b07040',
  borked:   '#c85050',
};
