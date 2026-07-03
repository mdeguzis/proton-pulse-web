// Admin API Explorer tab (issue #186).
//
// Inspect the raw JSON the stores return for a game -- handy for debugging box
// art, content descriptors, Steam Deck verdicts, and GOG / Epic catalog data.
// Store tabs switch between Steam / GOG / Epic; each has its own endpoints.
// Steam & GOG accept an app/product ID or a name (resolved against the search
// index); GOG catalog search and Epic search take a free-text term. The fetch
// goes through the steam-explore edge function because the stores are
// CORS-blocked from the browser.

import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';
import { escapeHtml } from '../utils.js?v=bd5a67c2';
import { exploreStore } from '../api/steam-explore.js?v=17281b89';

// Store -> endpoints. `arg` is 'id' (numeric app/product id, name-resolvable)
// or 'term' (free-text search). Keys match the edge function's ENDPOINTS.
const STORES = {
  steam: {
    label: 'Steam',
    placeholder: 'App ID or game name',
    endpoints: [
      { key: 'steam_appdetails', label: 'appdetails (metadata + content descriptors)', arg: 'id' },
      { key: 'steam_deck', label: 'Steam Deck compatibility', arg: 'id' },
    ],
  },
  gog: {
    label: 'GOG',
    placeholder: 'GOG product ID, game name, or search term',
    endpoints: [
      { key: 'gog_product', label: 'product details (by ID / name)', arg: 'id' },
      { key: 'gog_search', label: 'catalog search (by term)', arg: 'term' },
    ],
  },
  epic: {
    label: 'Epic',
    placeholder: 'Game name / search term',
    endpoints: [
      { key: 'epic_search', label: 'store search (by term)', arg: 'term' },
    ],
  },
};

// Reference docs per endpoint, shown in the Field descriptions popup. Keep in
// sync with the pipeline + the web wiki.
const FIELD_DOCS = {
  steam_appdetails: {
    title: 'Steam appdetails',
    rows: [
      ['content_descriptors.ids', 'Developer-set content flags. We treat 3 and 4 as adult and hide those by default. 1 = Some Nudity or Sexual Content (NOT filtered -- too broad, catches BG3 / Cyberpunk). 2 = Frequent Violence or Gore (not filtered). 3 = Adult Only Sexual Content (adult). 4 = Frequent Nudity or Sexual Content (adult). 5 = General Mature Content (not filtered).'],
      ['content_descriptors.notes', 'Free-text summary of the descriptors.'],
      ['required_age', 'Age gate on the store page. Often 0 even for adult games (Steam uses content_descriptors instead), so we do NOT use it for the adult flag.'],
      ['type', 'game / dlc / demo / music / ...'],
      ['header_image', 'The 460x215 box-art URL.'],
      ['success', 'false = app removed, region-locked, or the fetch was rate-limited.'],
    ],
  },
  steam_deck: {
    title: 'Steam Deck compatibility',
    rows: [
      ['resolved_category', "Valve's overall Deck verdict. 0 = Unknown, 1 = Unsupported, 2 = Playable, 3 = Verified."],
      ['steamos_resolved_category', 'Proton / OS-layer status, tracked separately. Often 2 even when overall Verified.'],
      ['resolved_items[].display_type', '0 = Neutral/info. 1 = Incompatible/blocked (red x). 2 = Minor issue (yellow !). 3 = System pass (internal). 4 = Full pass (green check).'],
      ['resolved_items[].loc_token', 'Criterion identifier, e.g. #SteamDeckVerified_TestResult_InterfaceTextIsLegible.'],
    ],
  },
  gog_product: {
    title: 'GOG product (api.gog.com/products/<id>)',
    rows: [
      ['id', 'Numeric GOG product id (our index stores it as gog:<id>).'],
      ['title', 'Game title.'],
      ['images.logo / .background', 'Cover / background art URLs (protocol-relative).'],
      ['links.product_card / .purchase_link', 'Store page and purchase URLs.'],
      ['content_system_compatibility', 'OS availability (windows / osx / linux booleans).'],
      ['is_secret / in_development', 'Visibility / release-state flags.'],
    ],
  },
  gog_search: {
    title: 'GOG catalog search (catalog.gog.com/v1/catalog)',
    rows: [
      ['products[]', 'Matching catalog entries.'],
      ['products[].id / .title / .slug', 'Product id, title, and URL slug.'],
      ['products[].coverHorizontal / .coverVertical', 'Cover art URLs.'],
      ['products[].price', 'Pricing (final / base / discount).'],
      ['productCount / pages', 'Total matches and pagination.'],
    ],
  },
  epic_search: {
    title: 'Epic store search (GraphQL searchStore)',
    rows: [
      ['data.Catalog.searchStore.elements[]', 'Matching store offers.'],
      ['elements[].title / .namespace / .productSlug', 'Title, catalog namespace, and store slug (our index stores epic:<namespace>).'],
      ['elements[].keyImages[]', 'Art assets by type (DieselStoreFrontWide, OfferImageWide, ...).'],
      ['elements[].offerType', 'BASE_GAME / DLC / ADD_ON / ...'],
      ['elements[].price.totalPrice', 'discountPrice / originalPrice (in cents).'],
    ],
  },
};

function _showFieldDocs(endpointKey) {
  const doc = FIELD_DOCS[endpointKey] || FIELD_DOCS.steam_appdetails;
  const existing = document.getElementById('apix-fields-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'apix-fields-modal';
  modal.className = 'apix-modal-overlay';
  const rows = doc.rows
    .map((r) => `<tr><th>${escapeHtml(r[0])}</th><td>${escapeHtml(r[1])}</td></tr>`)
    .join('');
  modal.innerHTML = `
    <div class="apix-modal">
      <div class="apix-modal-head">
        <h3>Field descriptions — ${escapeHtml(doc.title)}</h3>
        <button class="apix-modal-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="apix-modal-body">
        <table class="apix-fields-table">${rows}</table>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.apix-modal-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

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

// Resolve the input for the current store + endpoint arg. 'term' endpoints pass
// the text straight through. 'id' endpoints take a numeric id, or a name that we
// match against the search index (scoped to the store; GOG/Epic ids are stored
// prefixed, so we strip the prefix to get the store-native id).
async function _resolveArg(store, endpointArg, input) {
  const q = String(input || '').trim();
  if (!q) return { error: 'Enter an ID, name, or search term.' };
  if (endpointArg === 'term') return { term: q };
  if (/^\d+$/.test(q)) return { id: q };
  const idx = await _loadIndex();
  const ql = q.toLowerCase();
  const prefix = store === 'gog' ? 'gog:' : store === 'epic' ? 'epic:' : '';
  const inStore = (r) => {
    if (!Array.isArray(r)) return false;
    const sid = String(r[0]);
    if (store === 'steam') return r[5] === 'steam' || /^\d+$/.test(sid);
    return sid.startsWith(prefix);
  };
  const exact = idx.find((r) => inStore(r) && String(r[1] || '').toLowerCase() === ql);
  const match = exact || idx.find((r) => inStore(r) && String(r[1] || '').toLowerCase().includes(ql));
  if (!match) return { error: `No ${store} game matched "${q}".` };
  let id = String(match[0]);
  if (prefix && id.startsWith(prefix)) id = id.slice(prefix.length);
  return { id, title: String(match[1] || '') };
}

export function renderApiExplorer() {
  const el = document.getElementById('api-explorer-content');
  if (!el) return;

  let store = 'steam';
  let lastJson = '';
  let lastName = 'store';

  const storeTabs = Object.entries(STORES)
    .map(([k, s]) => `<button class="apix-store-tab${k === store ? ' active' : ''}" data-store="${k}" type="button">${escapeHtml(s.label)}</button>`)
    .join('');

  el.innerHTML = `
    <div class="admin-card" style="padding:14px 16px; margin-bottom:16px">
      <div class="admin-subhead">Store API Explorer</div>
      <p class="admin-hint" style="margin:6px 0 10px">Inspect the raw JSON a store endpoint returns. Fetched server-side because the stores are CORS-blocked from the browser.</p>
      <div class="apix-store-tabs">${storeTabs}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px">
        <input id="apix-input" class="admin-input" type="text" placeholder="${escapeHtml(STORES[store].placeholder)}" style="flex:0 1 300px; min-width:0">
        <select id="apix-endpoint" class="admin-select" title="Which endpoint to fetch"></select>
        <button id="apix-fetch" class="admin-btn admin-btn--primary">Fetch</button>
        <button id="apix-fields" class="admin-btn" type="button" title="What the JSON fields mean">Field descriptions</button>
      </div>
      <p id="apix-status" class="admin-hint" style="margin:10px 0 0" hidden></p>
      <div id="apix-toolbar" class="apix-toolbar" hidden>
        <label class="apix-wrap-toggle"><input type="checkbox" id="apix-wrap"> Word wrap</label>
        <button id="apix-copy" class="admin-btn" type="button">Copy JSON</button>
        <button id="apix-download" class="admin-btn" type="button">Download JSON</button>
      </div>
      <pre id="apix-output" class="apix-output" hidden></pre>
    </div>`;

  const endpointSel = el.querySelector('#apix-endpoint');
  const inputEl = el.querySelector('#apix-input');

  const populateEndpoints = () => {
    endpointSel.innerHTML = STORES[store].endpoints
      .map((e) => `<option value="${e.key}" data-arg="${e.arg}">${escapeHtml(e.label)}</option>`)
      .join('');
    inputEl.placeholder = STORES[store].placeholder;
  };
  populateEndpoints();

  const setStatus = (text, isError) => {
    const s = document.getElementById('apix-status');
    if (!s) return;
    s.hidden = false;
    s.textContent = text;
    s.className = 'admin-hint' + (isError ? ' admin-error' : '');
  };

  const doFetch = async () => {
    const opt = endpointSel.options[endpointSel.selectedIndex];
    const endpoint = opt?.value;
    const arg = opt?.dataset.arg || 'id';
    setStatus('Resolving...');
    const resolved = await _resolveArg(store, arg, inputEl.value);
    if (resolved.error) { setStatus(resolved.error, true); return; }
    const label = resolved.id ? `app ${resolved.id}${resolved.title ? ` (${resolved.title})` : ''}` : `"${resolved.term}"`;
    setStatus(`Fetching ${endpoint} for ${label}...`);
    const btn = document.getElementById('apix-fetch');
    if (btn) btn.disabled = true;
    const payload = await exploreStore(endpoint, { id: resolved.id, term: resolved.term });
    if (btn) btn.disabled = false;
    lastJson = JSON.stringify(payload && 'data' in payload ? payload.data : payload, null, 2);
    lastName = `${endpoint}-${resolved.id || (resolved.term || '').replace(/\W+/g, '-').slice(0, 40)}`;
    const out = document.getElementById('apix-output');
    if (out) { out.hidden = false; out.textContent = lastJson; }
    document.getElementById('apix-toolbar').hidden = false;
    setStatus(
      payload.ok ? `HTTP ${payload.status || 200} — ${payload.url || ''}` : `Failed: ${payload.error || 'unknown'}`,
      !payload.ok,
    );
  };

  el.querySelectorAll('.apix-store-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      store = tab.dataset.store;
      el.querySelectorAll('.apix-store-tab').forEach((t) => t.classList.toggle('active', t === tab));
      populateEndpoints();
    });
  });

  el.querySelector('#apix-fetch')?.addEventListener('click', doFetch);
  inputEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doFetch(); } });
  el.querySelector('#apix-fields')?.addEventListener('click', () => {
    _showFieldDocs(endpointSel.value || 'steam_appdetails');
  });
  el.querySelector('#apix-wrap')?.addEventListener('change', (e) => {
    document.getElementById('apix-output')?.classList.toggle('apix-wrap', e.target.checked);
  });
  el.querySelector('#apix-copy')?.addEventListener('click', async () => {
    if (!lastJson) return;
    try { await navigator.clipboard.writeText(lastJson); setStatus('Copied JSON to clipboard.'); }
    catch { setStatus('Copy failed -- select the text and copy manually.', true); }
  });
  el.querySelector('#apix-download')?.addEventListener('click', () => {
    if (!lastJson) return;
    const blob = new Blob([lastJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${lastName}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}
