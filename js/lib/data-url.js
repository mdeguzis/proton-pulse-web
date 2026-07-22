// Cache-busting helper for pipeline-emitted data files (#119).
//
// The pipeline writes data-versions.json: a tiny map of {filename: hash8} for
// every data file it emits. The frontend fetches the manifest once per page
// load with cache: 'no-store' so we always see the latest hashes; from there
// every other data fetch can append ?v=<hash>, giving the browser and CDN a
// stable URL until the file actually changes.
//
// Usage (see js/app/components/search.js for the canonical pattern):
//   const r = await fetch(await dataUrl('search-index.json'));
//
// If the manifest is missing or the file is not in it, falls back to the
// bare filename -- older deploys and one-off files still work.

let _manifestPromise = null;
let _dataConfigPromise = null;

// Runtime deploy config (#362). The publish step writes data-config.json for the
// selected target: on Cloudflare it carries { dataBase: 'https://data.proton-pulse.com' }
// so the 75k per-game data/ buckets are served from R2; on GitHub Pages it is
// absent/empty and data/ stays same-origin. This is the switch that keeps the
// deploy target pluggable and reversible without any frontend code change.
function _loadDataConfig() {
  if (_dataConfigPromise) return _dataConfigPromise;
  _dataConfigPromise = fetch('data-config.json', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return _dataConfigPromise;
}

function _hostname() {
  return (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
}

function _isLocal() {
  const host = _hostname();
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
}

function _isStaging() {
  const host = _hostname();
  // Include the GH-Pages fallback host so a staging rollback still resolves.
  return host === 'staging.proton-pulse.com' || host.endsWith('.github.io');
}

function _manifestUrl() {
  // #380: staging must NEVER read from prod (the two now have separate R2
  // buckets and independent manifests). Local dev reads the prod manifest
  // because a local vite server has no data-versions.json of its own.
  //   staging.proton-pulse.com   -> staging manifest, staging bucket
  //   www.proton-pulse.com       -> prod manifest, prod bucket
  //   localhost / gh.io fallback -> prod manifest (dev + rollback path)
  if (_isStaging() && _hostname() === 'staging.proton-pulse.com') {
    return 'data-versions.json';  // same-origin on staging
  }
  if (_isStaging() || _isLocal()) {
    return 'https://www.proton-pulse.com/data-versions.json';
  }
  return 'data-versions.json';
}

function _loadManifest() {
  if (_manifestPromise) return _manifestPromise;
  _manifestPromise = fetch(_manifestUrl(), { cache: 'no-store' })
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}));
  return _manifestPromise;
}

/**
 * Resolve a data file path with its content-hash cache buster appended.
 * @param {string} name - Plain filename (e.g. 'search-index.json').
 * @returns {Promise<string>} The same name with `?v=<hash>` when the manifest
 *   has a hash for it, otherwise the bare name.
 */
export async function dataUrl(name) {
  const [manifest, config] = await Promise.all([_loadManifest(), _loadDataConfig()]);
  const hash = manifest[name];
  const versioned = hash ? `${name}?v=${hash}` : name;
  // Per-game data/ buckets can live on a separate host (R2) depending on the
  // deploy target. Only data/ paths reroute; small top-level files ship with the
  // shell and stay same-origin. Empty dataBase (GitHub Pages) is a no-op.
  const dataBase = config && config.dataBase;
  if (dataBase && name.startsWith('data/')) {
    return `${dataBase.replace(/\/$/, '')}/${versioned}`;
  }
  return versioned;
}

/**
 * Synchronous version that returns the bare name immediately. Useful for code
 * paths that cannot easily await -- they lose the cache-bust but never break.
 * Prefer dataUrl() when possible.
 */
export function dataUrlSync(name) {
  return name;
}
