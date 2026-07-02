// Adult-content visibility gate.
//
// The pipeline flags games as adult when Steam's appdetails endpoint
// returns content-descriptor ids 1, 4, or 5 (nudity / sexual content /
// adult-only sexual content). Every game row on Popular / Recent /
// Search lists carries an optional `adult: true` field; when the pref
// is off (default) those rows are hidden from browse views.
//
// The user opt-in lives on the site options page under "Show adult
// games", written to localStorage as pp:show-adult=on|off.

const KEY = 'pp:show-adult';

export function showAdultAllowed() {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

// Filter a list of game rows by the current pref. Rows without an
// explicit adult=true flag pass through unchanged (backwards compat
// with data files that predate the field).
export function filterAdult(rows) {
  if (showAdultAllowed()) return rows;
  return rows.filter(r => !r || r.adult !== true);
}

// search-index.json rows are arrays, not objects. The adult flag lives
// at ADULT_COL_SEARCH_INDEX. Rows that don't yet have the column pass
// through so pre-pipeline-run data stays visible.
export const ADULT_COL_SEARCH_INDEX = 8;

export function isAdultEntry(entry, col = ADULT_COL_SEARCH_INDEX) {
  return Array.isArray(entry) && entry[col] === true;
}

export function filterAdultEntries(entries, col = ADULT_COL_SEARCH_INDEX) {
  if (showAdultAllowed()) return entries;
  return entries.filter(e => !isAdultEntry(e, col));
}
