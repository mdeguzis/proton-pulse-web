// Single source of truth for how the admin UI interprets a user_configs
// row's origin. Two consumers:
//
//   - api/analytics.js uses classifyReportSource() to group rows into
//     the Web / Plugin / Other buckets on the Report Submissions chart.
//   - components/allReports.js uses formatReportSourceLabel() to render
//     the SOURCE cell in the All Reports table.
//
// Signature detection, not source-string trust
// --------------------------------------------
// Earlier passes tried to auto-classify by the raw `source` field, which
// the client controls. That misclassified rows that carry source='user'
// (or 'protondb', 'protondb-local') but were NOT actually submitted from
// the Deck plugin -- for example an old browser submit path or an
// imported ProtonDB mirror row. Anyone can put any string in `source`.
//
// The real discriminator is installation_id: the decky-proton-pulse
// plugin's submit path (src/lib/userConfigs.ts) always populates it, and
// the web submit path (js/shared/submit.js) never sets it. So we only
// call a row 'plugin' when we have a positive signature: installation_id
// is present, OR the source string starts with the forward-looking
// 'plugin' prefix. Everything else falls to 'web' or 'other' based on
// the source string alone -- no more guessing.

// Positive plugin signature. Callers pass the whole row so we can check
// installation_id, not just the client-controlled source string.
function _hasPluginSignature(row) {
  if (!row) return false;
  if (row.installation_id) return true;
  const s = String(row.source || '').toLowerCase();
  return s.startsWith('plugin');
}

// Bucket a row into 'web' | 'plugin' | 'other'. Web submissions have
// source starting with 'web'; plugin submissions have a positive
// signature (installation_id set or explicit 'plugin' prefix); anything
// else is 'other' so admins can spot weird traffic.
//
// Accepts either a full row object or a bare source string for
// convenience -- when given a string, only the 'plugin'/'web' prefix
// branches can fire, so a bare 'user' string that ISN'T from a plugin
// (say an imported ProtonDB mirror row) will fall to 'other', not a
// false-positive 'plugin'.
export function classifyReportSource(rowOrSrc) {
  const row = (rowOrSrc && typeof rowOrSrc === 'object') ? rowOrSrc : { source: rowOrSrc };
  if (_hasPluginSignature(row)) return 'plugin';
  const s = String(row.source || '').toLowerCase();
  if (s.startsWith('web')) return 'web';
  return 'other';
}

// Format the row's source for display in an admin table cell. Rows with
// a positive plugin signature render as bare 'plugin' so the SOURCE
// column reads consistently. Everything else renders its raw source
// string unchanged (do NOT lie about origin: an imported row with
// source='user' but no installation_id is not from the plugin).
export function formatReportSourceLabel(rowOrSrc) {
  const row = (rowOrSrc && typeof rowOrSrc === 'object') ? rowOrSrc : { source: rowOrSrc };
  const raw = String(row.source || '').trim();
  if (_hasPluginSignature(row)) return 'plugin';
  return raw;
}
