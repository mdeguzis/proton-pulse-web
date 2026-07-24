// wordlist (api) for the admin page.

// Cached flat Set of naughty-words terms (all languages, lowercase).
export let _wordlistCache = null;

export async function loadWordlist() {
  if (_wordlistCache) return _wordlistCache;
  const res = await fetch('https://cdn.jsdelivr.net/npm/naughty-words@1.2.0/index.json');
  if (!res.ok) return null;
  const data = await res.json();
  const terms = new Set();
  for (const lang of Object.values(data)) {
    if (Array.isArray(lang)) for (const w of lang) terms.add(w.toLowerCase());
  }
  _wordlistCache = terms;
  return terms;
}

export function checkAgainstWordlist(pattern, isRegex, terms) {
  if (!terms) return null;
  if (isRegex) {
    try {
      const re = new RegExp(pattern, 'i');
      const hits = [...terms].filter(t => re.test(t));
      return hits.length ? hits.slice(0, 3) : null;
    } catch { return null; }
  }
  return terms.has(pattern.toLowerCase()) ? [pattern.toLowerCase()] : null;
}
