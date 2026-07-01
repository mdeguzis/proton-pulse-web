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
