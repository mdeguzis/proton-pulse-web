import { escapeHtml } from '../utils.js?v=86489fcb';

function _pass(label) {
  return `<span class="cache-status-pass">${escapeHtml(label)}</span>`;
}
function _fail(label) {
  return `<span class="cache-status-fail">${escapeHtml(label)}</span>`;
}
function _warn(label) {
  return `<span class="cache-status-warn">${escapeHtml(label)}</span>`;
}

function _checkNoCacheMeta() {
  const metas = Array.from(document.querySelectorAll('meta[http-equiv]'));
  const has = key => metas.some(m => m.getAttribute('http-equiv')?.toLowerCase() === key.toLowerCase());
  return has('Cache-Control') && has('Pragma') && has('Expires');
}

function _loadedScriptHashes() {
  return Array.from(document.querySelectorAll('script[src]'))
    .map(s => {
      const src = s.getAttribute('src') || '';
      const match = src.match(/\?v=([0-9a-f]+)/);
      return { src: src.replace(/\?.*$/, '').replace(/^.*\//, ''), hash: match ? match[1] : null };
    })
    .filter(e => e.hash);
}

function _resourceCacheRows() {
  if (!window.performance?.getEntriesByType) return [];
  return performance.getEntriesByType('resource')
    .filter(e => e.initiatorType === 'script' || e.initiatorType === 'link')
    .filter(e => e.name.includes('?v='))
    .map(e => {
      const fromCache = e.transferSize === 0;
      const name = e.name.replace(/^.*\//, '').replace(/\?.*$/, '');
      const hash = (e.name.match(/\?v=([0-9a-f]+)/) || [])[1] || '?';
      return { name, hash, fromCache, duration: Math.round(e.duration) };
    });
}

export async function renderCacheStatus(container) {
  container.innerHTML = '<p class="admin-muted">Checking cache status...</p>';

  let deployed = null;
  try {
    const r = await fetch(`version.json?_=${Date.now()}`);
    if (r.ok) deployed = await r.json();
  } catch (_) { /* ignore */ }

  const metaOk = _checkNoCacheMeta();
  const scriptHashes = _loadedScriptHashes();
  const resourceRows = _resourceCacheRows();

  const versionRow = deployed
    ? `<tr><td>Deployed version</td><td>${_pass('v' + escapeHtml(deployed.version || '?') + ' &middot; ' + escapeHtml((deployed.sha || '').slice(0, 7)))}</td></tr>`
    : `<tr><td>Deployed version</td><td>${_fail('version.json unavailable')}</td></tr>`;

  const metaRow = `<tr><td>No-cache meta tags</td><td>${metaOk ? _pass('present') : _fail('missing -- HTML may be served stale')}</td></tr>`;

  const deployedAt = deployed?.deployed_at
    ? `<tr><td>Deployed at</td><td>${escapeHtml(new Date(deployed.deployed_at).toLocaleString())}</td></tr>`
    : '';

  const scriptRows = scriptHashes.length
    ? scriptHashes.map(e =>
        `<tr><td class="admin-muted" style="font-family:var(--mono);font-size:0.75rem">${escapeHtml(e.src)}</td><td style="font-family:var(--mono);font-size:0.75rem">${escapeHtml(e.hash)}</td></tr>`
      ).join('')
    : '<tr><td colspan="2" class="admin-muted">No versioned scripts detected</td></tr>';

  const cacheRows = resourceRows.length
    ? resourceRows.map(e =>
        `<tr>
          <td style="font-family:var(--mono);font-size:0.75rem">${escapeHtml(e.name)}</td>
          <td style="font-family:var(--mono);font-size:0.75rem">${escapeHtml(e.hash)}</td>
          <td>${e.fromCache ? _warn('cache') : _pass('network')} <span class="admin-muted">${e.duration}ms</span></td>
        </tr>`
      ).join('')
    : '<tr><td colspan="3" class="admin-muted">No resource timing data (cross-origin or API not supported)</td></tr>';

  container.innerHTML = `
    <div class="cache-status-section">
      <h3 class="admin-section-title" style="margin-top:0">Deploy info</h3>
      <table class="admin-table">
        <tbody>
          ${versionRow}
          ${deployedAt}
          ${metaRow}
        </tbody>
      </table>

      <details class="cache-status-details" style="margin-top:16px">
        <summary class="admin-muted" style="cursor:pointer">Loaded script hashes (${scriptHashes.length})</summary>
        <table class="admin-table" style="margin-top:8px">
          <thead><tr><th>File</th><th>Loaded ?v= hash</th></tr></thead>
          <tbody>${scriptRows}</tbody>
        </table>
      </details>

      <details class="cache-status-details" style="margin-top:12px">
        <summary class="admin-muted" style="cursor:pointer">Resource cache hits (${resourceRows.length})</summary>
        <table class="admin-table" style="margin-top:8px">
          <thead><tr><th>File</th><th>Hash</th><th>Source</th></tr></thead>
          <tbody>${cacheRows}</tbody>
        </table>
      </details>
    </div>`;
}
