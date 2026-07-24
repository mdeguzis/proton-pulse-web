// Pure tokenized fuzzy match for the search index (#used-by search.js).
// Split out so unit tests can exercise it without pulling the whole search
// component + its DOM / Supabase transitive imports.
//
// Match rule: normalize both sides (lowercase + non-alphanumeric -> space),
// tokenize the query on whitespace, require EVERY token to appear
// somewhere in the normalized title. Order-independent. Numeric queries
// short-circuit to id.startsWith so an app-id lookup skips the title fuzz.

export function normalizeSearchable(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function titleMatchesTokens(title, tokens) {
  if (!tokens.length) return false;
  const norm = normalizeSearchable(title);
  for (const t of tokens) {
    if (!norm.includes(t)) return false;
  }
  return true;
}

// entries: Array<[appId, title, tier, protondbCount, pulseCount, appType, ...]>
// query:   raw user input
// limit:   max rows to return
export function matchEntries(entries, query, limit) {
  if (!entries || !entries.length) return [];
  const isNum = /^\d+$/.test(query);
  if (isNum) {
    return entries.filter(([id]) => String(id).startsWith(query)).slice(0, limit);
  }
  const tokens = normalizeSearchable(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return entries.filter(([id, title]) =>
    titleMatchesTokens(title, tokens) || String(id).startsWith(query)
  ).slice(0, limit);
}
