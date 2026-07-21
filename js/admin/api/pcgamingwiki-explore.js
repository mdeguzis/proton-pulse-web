// Admin API Explorer -- PCGamingWiki Cargo tab (#377).
//
// Client-side fetch direct to pcgamingwiki.com. PCGW is CORS-enabled and
// public, so we skip the steam-explore edge fn for faster iteration on
// Cargo query shapes. Returns the same envelope shape as
// api/steam-explore.js so the Explorer UI does not need to branch:
//   { ok, status, url, method, data, error? }
//
// Endpoint keys:
//   pcgw_by_appid       args: { id }    -- Cargo Infobox_game WHERE Steam_AppID HOLDS "<id>"
//   pcgw_by_title       args: { term }  -- Cargo Infobox_game WHERE _pageName LIKE "%<term>%"
//   pcgw_table_fields   args: { term }  -- cargofields introspection for one table

const CARGO_URL = 'https://www.pcgamingwiki.com/w/api.php';

// Common projection used by the two Infobox_game endpoints. Field aliases
// mirror scripts/pipeline/pcgamingwiki.py so what the admin sees here is
// exactly what the pipeline sees. Aliases MUST NOT start with underscore
// -- Cargo's cargoquery-invalidfieldalias error blocks that.
const INFOBOX_FIELDS = [
  '_pageName=page',
  'Steam_AppID=appId',
  'GOGcom_ID=gogId',
  'Engines=engines',
  'Available_on=available',
  'Released_Windows=relWin',
  'Released_Linux=relLin',
  'Released_OS_X=relMac',
  'Released_DOS=relDos',
  'Developers=developers',
  'Publishers=publishers',
].join(',');

const CARGO_LIMIT = 20;

/**
 * Fetch PCGamingWiki data. Returns the exploreStore-shaped envelope so the
 * Explorer UI's request/response rendering works without branching.
 */
export async function exploreCargoPCGamingWiki(endpoint, { id, term } = {}) {
  const built = _buildQuery(endpoint, { id, term });
  if (built.error) {
    return { ok: false, status: 0, url: '', method: 'GET', data: null, error: built.error };
  }
  const url = `${CARGO_URL}?${new URLSearchParams(built.params).toString()}`;
  try {
    // globalThis.fetch (not bare `fetch`) so a test can `jest.spyOn(globalThis, 'fetch')`
    // and intercept calls without the module needing an injectable dep.
    const res = await globalThis.fetch(url, { headers: { 'Accept': 'application/json' } });
    let data = null;
    try { data = await res.json(); } catch { /* leave data null; error path below */ }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        url,
        method: 'GET',
        data,
        error: `HTTP ${res.status}`,
      };
    }
    // PCGW returns an "error" object on MWException instead of a proper 4xx.
    if (data && typeof data === 'object' && data.error) {
      return {
        ok: false,
        status: 200,
        url,
        method: 'GET',
        data,
        error: String(data.error.info || data.error.code || 'MWException'),
      };
    }
    return { ok: true, status: res.status, url, method: 'GET', data };
  } catch (e) {
    return { ok: false, status: 0, url, method: 'GET', data: null, error: String(e?.message || e) };
  }
}

function _buildQuery(endpoint, { id, term }) {
  if (endpoint === 'pcgw_by_appid') {
    const n = String(id || '').trim();
    if (!/^\d+$/.test(n)) return { error: 'Steam App ID must be numeric.' };
    return {
      params: {
        action: 'cargoquery',
        format: 'json',
        tables: 'Infobox_game',
        fields: INFOBOX_FIELDS,
        // Steam_AppID is a virtual list field; HOLDS is the operator that
        // matches when the given value appears in the list. Quotes required.
        where: `Steam_AppID HOLDS "${n}"`,
        limit: CARGO_LIMIT,
      },
    };
  }
  if (endpoint === 'pcgw_by_title') {
    const t = String(term || '').trim();
    if (!t) return { error: 'Enter a game title fragment to search for.' };
    return {
      params: {
        action: 'cargoquery',
        format: 'json',
        tables: 'Infobox_game',
        fields: INFOBOX_FIELDS,
        // Case-insensitive substring match on the wiki page title.
        // PCGW pages are named after the canonical game title.
        where: `_pageName LIKE "%${_escapeLike(t)}%"`,
        order_by: '_pageName',
        limit: CARGO_LIMIT,
      },
    };
  }
  if (endpoint === 'pcgw_table_fields') {
    const table = String(term || '').trim() || 'Infobox_game';
    // Table names on PCGW are conservative identifiers; still validate to keep
    // the URL clean and reject anything obviously wrong.
    if (!/^[A-Za-z0-9_]+$/.test(table)) {
      return { error: 'Cargo table name must match [A-Za-z0-9_]+.' };
    }
    return {
      params: {
        action: 'cargofields',
        format: 'json',
        table,
      },
    };
  }
  return { error: `Unknown PCGamingWiki endpoint "${endpoint}".` };
}

// Escape LIKE metacharacters that would otherwise let a stray % / _ / " turn
// the query into something unintended. Backslash-escapes both wildcards and
// the double-quote that closes the WHERE string literal.
function _escapeLike(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}
