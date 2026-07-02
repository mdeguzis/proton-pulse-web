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

function _isStagingOrLocal() {
  const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.github.io');
}

function _manifestUrl() {
  // Staging fetches data files from prod; the manifest comes from the same
  // origin so the hashes match the files actually being served.
  return _isStagingOrLocal()
    ? 'https://www.proton-pulse.com/data-versions.json'
    : 'data-versions.json';
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
  const manifest = await _loadManifest();
  const hash = manifest[name];
  return hash ? `${name}?v=${hash}` : name;
}

/**
 * Synchronous version that returns the bare name immediately. Useful for code
 * paths that cannot easily await -- they lose the cache-bust but never break.
 * Prefer dataUrl() when possible.
 */
export function dataUrlSync(name) {
  return name;
}
