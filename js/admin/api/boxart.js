// Admin box-art helpers: probe the canonical header-image URL for a
// game across Steam / GOG / Epic and report success or a human-readable
// error message. Meant for the admin "Missing Box Art" tab.
//
// URL choice per store:
//   steam: shared.akamai.steamstatic.com/store_item_assets/steam/apps/APP/header.jpg
//     (fallback: cloudflare.steamstatic.com/steam/apps/APP/header.jpg,
//      then whatever the pipeline stashed in game-images.json)
//   gog:   value from nonsteam-images.json (image.gog-statics.com/HASH.png)
//   epic:  value from nonsteam-images.json (Epic Games Media OG image)
//
// Steam has an official appdetails endpoint that returns the current
// header_image (and other assets) so refetchSteamHeader() can suggest
// a URL when the CDN-derived one 404s. GOG / Epic don't have equivalent
// no-auth endpoints, so their refetch is a plain URL probe of the
// value we already have in nonsteam-images.json.

import { SUPABASE_URL } from '../config.js?v=ffed3d84';

const STEAM_STANDARD = (appId) =>
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(appId)}/header.jpg`;
const STEAM_CLOUDFLARE = (appId) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(appId)}/header.jpg`;
// Server-side proxy that fetches from Steam appdetails / SteamGridDB
// with server credentials. Steam's appdetails and SGDB both refuse
// browser origins, so a proxy is the only way this works from the
// admin UI. See supabase/functions/image-refetch/index.ts.
const IMAGE_REFETCH_ENDPOINT = () => `${SUPABASE_URL}/functions/v1/image-refetch`;

// Result shape returned by every probe/refetch function:
//   { ok: boolean, url: string|null, status: number|null, error: string|null }
//   ok=true means the URL loaded a real image; ok=false means it didn't
//   and `error` explains why in one short sentence.
function _result(ok, { url = null, status = null, error = null } = {}) {
  return { ok, url, status, error };
}

// HEAD probe an image URL. Some image CDNs reject HEAD (return 405),
// so a soft fallback falls back to GET without downloading the body via
// AbortController when HEAD isn't allowed. Returns _result shape.
export async function probeImageUrl(url) {
  if (!url) return _result(false, { error: 'no url' });
  try {
    const head = await fetch(url, { method: 'HEAD', mode: 'cors', cache: 'no-store' });
    if (head.ok) return _result(true, { url, status: head.status });
    // 405 = HEAD not allowed; retry with GET (aborted mid-body).
    if (head.status === 405) {
      const ac = new AbortController();
      const res = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store', signal: ac.signal });
      ac.abort();
      return res.ok
        ? _result(true, { url, status: res.status })
        : _result(false, { url, status: res.status, error: `HTTP ${res.status} ${res.statusText || ''}`.trim() });
    }
    return _result(false, { url, status: head.status, error: `HTTP ${head.status} ${head.statusText || ''}`.trim() });
  } catch (e) {
    // Network / CORS / DNS. Return the raw message so the admin can
    // see what actually happened rather than a generic "failed".
    return _result(false, { url, error: `network: ${e.message || String(e)}` });
  }
}

// Try the Steam standard URL, then Cloudflare, then a caller-supplied
// pipeline fallback (from game-images.json). Returns the first one that
// works, or the last failure if none do.
export async function probeSteamHeader(appId, pipelineFallback = null) {
  const tries = [STEAM_STANDARD(appId), STEAM_CLOUDFLARE(appId)];
  if (pipelineFallback) tries.push(pipelineFallback);
  let last = _result(false, { error: 'no candidates' });
  for (const url of tries) {
    const r = await probeImageUrl(url);
    if (r.ok) return r;
    last = r;
  }
  return last;
}

// Ask the server-side proxy to fetch the current header_image from
// the store and verify it. Steam's appdetails / SGDB / etc. all block
// browser-origin fetches with CORS, so the proxy is the only working
// path. `source` picks the backend: 'steam' = appdetails, 'sgdb' =
// SteamGridDB (needs SGDB_API_KEY on the server).
async function _callImageRefetch(appId, source) {
  try {
    const res = await fetch(IMAGE_REFETCH_ENDPOINT(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: String(appId), source }),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    if (!body) return _result(false, { status: res.status, error: `proxy HTTP ${res.status} (no body)` });
    if (body.ok) return _result(true, { url: body.url });
    return _result(false, { status: body.status, error: body.error || 'unknown' });
  } catch (e) {
    return _result(false, { error: `network: ${e.message || String(e)}` });
  }
}

export async function refetchSteamHeader(appId) {
  const idStr = String(appId).replace(/[^0-9]/g, '');
  if (!idStr) return _result(false, { error: `invalid Steam appId "${appId}"` });
  return _callImageRefetch(idStr, 'steam');
}

// Fetch a header from SteamGridDB via the proxy. Works for Steam ids
// today; non-Steam (gog:/epic:) support depends on a title-search path
// that phase 3 of issue #175 wires up.
export async function refetchSgdbHeader(appId) {
  return _callImageRefetch(appId, 'sgdb');
}

// Non-Steam refetch just re-probes whatever nonsteam-images.json says
// (there's no public GOG/Epic image-manifest API we can call from the
// browser). If the URL still 404s the admin knows to update the
// pipeline's static list.
export async function refetchNonSteamHeader(canonicalId, currentUrl) {
  if (!currentUrl) return _result(false, { error: `no cached URL for ${canonicalId}` });
  return probeImageUrl(currentUrl);
}
