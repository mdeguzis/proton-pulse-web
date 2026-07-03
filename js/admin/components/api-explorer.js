// Admin API Explorer tab (issue #186).
//
// Inspect the raw JSON a Steam endpoint returns for a game -- handy for
// debugging box art, content descriptors, and Steam Deck verdicts. Accepts an
// app ID or a game name (resolved against the search index). The actual fetch
// goes through the steam-explore edge function because Steam is CORS-blocked
// from the browser.

import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';
import { escapeHtml } from '../utils.js?v=bd5a67c2';
import { exploreSteam } from '../api/steam-explore.js?v=536d3280';

let _index = null;
async function _loadIndex() {
  if (_index) return _index;
  try {
    const r = await fetch(await dataUrl('search-index.json'));
    _index = r.ok ? await r.json() : [];
  } catch {
    _index = [];
  }
  return _index;
}

// Resolve free-text input to a Steam app id. A numeric input passes through; a
// name does a case-insensitive title match against the search index (exact
// first, then a substring match), Steam rows only.
async function _resolveAppId(input) {
  const q = String(input || '').trim();
  if (!q) return { id: null, error: 'Enter an app ID or a game name.' };
  if (/^\d+$/.test(q)) return { id: q };
  const idx = await _loadIndex();
  const ql = q.toLowerCase();
  const isSteam = (r) => Array.isArray(r) && (r[5] === 'steam' || /^\d+$/.test(String(r[0])));
  const exact = idx.find((r) => isSteam(r) && String(r[1] || '').toLowerCase() === ql);
  const match = exact || idx.find((r) => isSteam(r) && String(r[1] || '').toLowerCase().includes(ql));
  if (!match) return { id: null, error: `No Steam game matched "${q}".` };
  return { id: String(match[0]), title: String(match[1] || '') };
}

export function renderApiExplorer() {
  const el = document.getElementById('api-explorer-content');
  if (!el) return;
  el.innerHTML = `
    <div class="admin-card" style="padding:14px 16px; margin-bottom:16px">
      <div class="admin-subhead">Steam API Explorer</div>
      <p class="admin-hint" style="margin:6px 0 10px">Inspect the raw JSON a Steam endpoint returns for a game. Enter an app ID or a game name (resolved against the search index). Fetched server-side because Steam is CORS-blocked from the browser.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        <input id="apix-input" class="admin-input" type="text" placeholder="App ID or game name" style="flex:0 1 300px; min-width:0">
        <select id="apix-endpoint" class="admin-select" title="Which Steam endpoint to fetch">
          <option value="appdetails">appdetails (metadata + content descriptors)</option>
          <option value="deck">Steam Deck compatibility</option>
        </select>
        <button id="apix-fetch" class="admin-btn admin-btn--primary">Fetch</button>
      </div>
      <p id="apix-status" class="admin-hint" style="margin:10px 0 0" hidden></p>
      <pre id="apix-output" class="apix-output" hidden></pre>
    </div>`;

  const setStatus = (text, isError) => {
    const s = document.getElementById('apix-status');
    if (!s) return;
    s.hidden = false;
    s.textContent = text;
    s.className = 'admin-hint' + (isError ? ' admin-error' : '');
  };

  const doFetch = async () => {
    const input = document.getElementById('apix-input')?.value || '';
    const endpoint = document.getElementById('apix-endpoint')?.value || 'appdetails';
    setStatus('Resolving...');
    const resolved = await _resolveAppId(input);
    if (!resolved.id) { setStatus(resolved.error, true); return; }
    setStatus(`Fetching ${endpoint} for app ${resolved.id}${resolved.title ? ` (${resolved.title})` : ''}...`);
    const btn = document.getElementById('apix-fetch');
    if (btn) btn.disabled = true;
    const payload = await exploreSteam(endpoint, resolved.id);
    if (btn) btn.disabled = false;
    const out = document.getElementById('apix-output');
    if (out) {
      out.hidden = false;
      // Show the upstream JSON if we got one, else the whole proxy payload.
      out.textContent = JSON.stringify(payload && 'data' in payload ? payload.data : payload, null, 2);
    }
    setStatus(
      payload.ok ? `HTTP ${payload.status || 200} — ${payload.url || ''}` : `Failed: ${payload.error || 'unknown'}`,
      !payload.ok,
    );
  };

  el.querySelector('#apix-fetch')?.addEventListener('click', doFetch);
  el.querySelector('#apix-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFetch(); }
  });
}
