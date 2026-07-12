// Vendor infrastructure health for status.html (#278).
//
// Fetches the full Statuspage.io components list from GitHub and Cloudflare
// and returns tile-shaped payloads that reflect ONLY the components Proton
// Pulse depends on. A Cloudflare "Dashboard - Degraded Performance" incident
// or a GitHub "Copilot" incident should NOT flip our tile yellow, because
// neither service affects the site. The modal keeps the wider incident visible
// (other-degraded list at the bottom) so a broader outage is still discoverable
// without falsely alarming visitors.
//
// Component ids are pinned. If Statuspage.io rotates them the row will read
// as "unknown" and the change becomes obvious rather than silent.

// GitHub components we actually depend on.
//   vg70hn9s2tyj  Pages         - prod site hosted here
//   br0l2tvcx85d  Actions       - CI + deploys
export const GH_CRITICAL_COMPONENT_IDS = ['vg70hn9s2tyj', 'br0l2tvcx85d'];

// Cloudflare components we actually depend on.
//   57srcl8zcn7c  Workers            - pp-edge-status Cron runs here (#275)
//   tmh50tx2nprs  Workers KV         - status payload persistence
//   5wnz34mhfhrk  CDN/Cache          - proton-pulse.com is behind Cloudflare CDN
//   dp8ppfycqxcs  Authoritative DNS  - proton-pulse.com DNS
export const CF_CRITICAL_COMPONENT_IDS = ['57srcl8zcn7c', 'tmh50tx2nprs', '5wnz34mhfhrk', 'dp8ppfycqxcs'];

const GH_STATUS_COMPONENTS_URL = 'https://www.githubstatus.com/api/v2/components.json';
const CF_STATUS_COMPONENTS_URL = 'https://www.cloudflarestatus.com/api/v2/components.json';

// Same cadence as the announcements list -- 5 minutes is plenty for vendor
// status feeds that themselves update on the order of minutes, and it keeps
// the anonymous rate limits comfortably in the clear.
export const VENDOR_REFRESH_MS = 5 * 60 * 1000;

// Map a Statuspage.io component status string to the same operational /
// degraded / down / unknown vocabulary the Supabase cards already use.
export function componentStatusToState(s) {
  if (s === 'operational') return 'operational';
  if (s === 'degraded_performance' || s === 'partial_outage' || s === 'under_maintenance') return 'degraded';
  if (s === 'major_outage') return 'down';
  return 'unknown';
}

// Aggregate a list of component states into one tile state: any down -> down;
// else any degraded -> degraded; else operational; else (empty) unknown.
export function worstOfStates(states) {
  if (!Array.isArray(states) || states.length === 0) return 'unknown';
  if (states.some((s) => s === 'down')) return 'down';
  if (states.some((s) => s === 'degraded')) return 'degraded';
  if (states.every((s) => s === 'operational')) return 'operational';
  return 'unknown';
}

function summarizeComponents(components, criticalIds) {
  // Preserve the critical order the caller declared so the modal reads left
  // to right in a predictable way instead of Statuspage.io's arbitrary order.
  const byId = new Map(components.map((c) => [c.id, c]));
  const critical = [];
  const criticalSet = new Set(criticalIds);
  for (const id of criticalIds) {
    const c = byId.get(id);
    if (!c) {
      critical.push({ id, name: '(missing from feed)', status: 'unknown', state: 'unknown', updated_at: null });
      continue;
    }
    critical.push({
      id,
      name: c.name,
      status: c.status,
      state: componentStatusToState(c.status),
      updated_at: c.updated_at || null,
    });
  }
  // Other-degraded: any component NOT in the critical list that is degraded /
  // down. Muted in the modal but still visible so a wider incident is not
  // hidden from the reader.
  const otherDegraded = components
    .filter((c) => !criticalSet.has(c.id) && c.status !== 'operational' && c.status !== 'under_maintenance')
    .map((c) => ({ id: c.id, name: c.name, status: c.status, state: componentStatusToState(c.status) }));
  return { critical, otherDegraded };
}

async function fetchVendor({ name, url, criticalIds, vendorStatusUrl, tag }) {
  const start = Date.now();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const components = Array.isArray(body?.components) ? body.components : [];
    const { critical, otherDegraded } = summarizeComponents(components, criticalIds);
    const state = worstOfStates(critical.map((c) => c.state));
    console.debug(`[status] vendor ${tag}`, {
      state,
      critical: critical.map((c) => `${c.name}=${c.status}`),
      otherDegradedCount: otherDegraded.length,
      source: url,
    });
    return {
      name,
      status: state,
      http_status: res.status,
      latency_ms: Date.now() - start,
      checked_at: new Date().toISOString(),
      vendor: tag,
      vendor_status_url: vendorStatusUrl,
      critical,
      other_degraded: otherDegraded,
    };
  } catch (err) {
    console.warn(`[status] vendor ${tag} fetch failed`, { source: url, error: String(err && err.message || err) });
    return {
      name,
      status: 'unknown',
      http_status: 0,
      latency_ms: Date.now() - start,
      checked_at: new Date().toISOString(),
      vendor: tag,
      vendor_status_url: vendorStatusUrl,
      critical: [],
      other_degraded: [],
      error: String(err && err.message || err),
    };
  }
}

// Fetch both vendor feeds in parallel. Returns an array in a fixed display
// order (GitHub Pages first, then Cloudflare) so the DOM stays stable across
// refreshes.
export async function fetchVendorStatuses() {
  const [gh, cf] = await Promise.all([
    fetchVendor({
      name: 'GitHub',
      url: GH_STATUS_COMPONENTS_URL,
      criticalIds: GH_CRITICAL_COMPONENT_IDS,
      vendorStatusUrl: 'https://www.githubstatus.com/',
      tag: 'github',
    }),
    fetchVendor({
      name: 'Cloudflare',
      url: CF_STATUS_COMPONENTS_URL,
      criticalIds: CF_CRITICAL_COMPONENT_IDS,
      vendorStatusUrl: 'https://www.cloudflarestatus.com/',
      tag: 'cloudflare',
    }),
  ]);
  return [gh, cf];
}
