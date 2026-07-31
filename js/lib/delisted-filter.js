// Delisted-game visibility gate (#434).
//
// The pipeline flags games as delisted when either:
//   (a) Steam's appdetails endpoint returns success=false AND the store
//       page 302s to the homepage (game_images.py delisted detection), OR
//   (b) PCGW knows a Steam appid for the title but our Steam catalog no
//       longer contains it, OR contains it under a substantially different
//       title (pcgwiki_catalog.py cross-check -- the SLA / SLA:O case where
//       Netmarble repurposed an appid for a remake).
//
// Rows carry the flag at column 7 of search-index.json. Default is to
// hide delisted rows from browse views + search; the user can opt in
// via the site options "Show delisted games" toggle
// (pp:show-delisted=on).
//
// KEEP IN SYNC with the topbar dropdown mirror in js/lib/topbar.js
// (adult filter has the same mirror pattern -- topbar is a classic
// script and cannot import ES modules).

const KEY = 'pp:show-delisted';

export function showDelistedAllowed() {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

// Filter a list of game rows (object shape used by card.js / home.js).
// Rows without an explicit delisted=true field pass through unchanged
// (backwards compat with data files predating the flag).
export function filterDelisted(rows) {
  if (showDelistedAllowed()) return rows;
  return rows.filter(r => !r || r.delisted !== true);
}

// search-index.json rows are arrays. Column 7 = delisted flag.
export const DELISTED_COL_SEARCH_INDEX = 7;

export function isDelistedEntry(entry, col = DELISTED_COL_SEARCH_INDEX) {
  return Array.isArray(entry) && entry[col] === true;
}

export function filterDelistedEntries(entries, col = DELISTED_COL_SEARCH_INDEX) {
  if (showDelistedAllowed()) return entries;
  return entries.filter(e => !isDelistedEntry(e, col));
}

// Convenience for the search page notice: how many delisted rows would
// have shown but were hidden by the current pref. Callers pass the RAW
// match result; this returns 0 when the pref is on (nothing hidden).
export function countHiddenDelisted(entries, col = DELISTED_COL_SEARCH_INDEX) {
  if (showDelistedAllowed()) return 0;
  let n = 0;
  for (const e of entries) if (isDelistedEntry(e, col)) n++;
  return n;
}
