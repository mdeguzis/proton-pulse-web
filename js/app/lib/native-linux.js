// native-linux.js -- which Steam games ship a native Linux build (#241).
// The pipeline publishes native-linux.json (scripts/pipeline/steam_platforms.py)
// from Steam's GetItems platforms data:
//   { generated_at, source, checked, unknown, native: ["570", "730", ...] }
// The home page uses it for the "Exclude native" filter chip.
//
// Loading is strict, like steam-type-breakdown.js after #569: a missing file
// comes back from Pages as the SPA HTML with a 200, and treating that as "no
// native games" would make the filter silently do nothing. A file where Steam
// answered for no apps (checked 0, written when every batch failed) is
// unusable too. Both reject, and the caller hides the filter.
import { dataUrl } from '../../lib/data-url.js?v=9ba434e3';

let _promise = null;

/** Resolves to a Set of native Linux Steam app ids; rejects if unusable. */
export function loadNativeLinux() {
  if (_promise) return _promise;
  _promise = (async () => {
    const res = await fetch(await dataUrl('native-linux.json'));
    if (!res.ok) throw new Error(`native-linux.json HTTP ${res.status}`);
    const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
    if (type.includes('text/html')) throw new Error('native-linux.json returned HTML (file not published)');
    const data = await res.json();
    if (!data || !Array.isArray(data.native)) throw new Error('native-linux.json has no native list');
    if (!(data.checked > 0)) throw new Error(`native-linux.json checked no apps${data.error ? `: ${data.error}` : ''}`);
    console.debug('[native-linux] loaded', { native: data.native.length, checked: data.checked, unknown: data.unknown, source: data.source });
    return new Set(data.native.map(String));
  })().catch((err) => { _promise = null; throw err; });
  return _promise;
}

/**
 * Apply the Native Linux chip selection. 'exclude' drops games with a native
 * Linux build; 'all' or no selection keeps everything. Games the pipeline
 * couldn't check are kept: unknown is never treated as native.
 */
export function filterByNative(reports, sel, nativeSet) {
  if (!sel || sel.size === 0 || sel.has('all') || !nativeSet) return reports;
  if (!sel.has('exclude')) return reports;
  return reports.filter((r) => !nativeSet.has(String(r.appId)));
}

export function _resetNativeLinuxForTests() { _promise = null; }
