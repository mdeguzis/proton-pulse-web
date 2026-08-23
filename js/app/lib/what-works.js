// Per-game "What Works?" aggregation (#440).
//
// Pure function: takes the merged report list the game page already has and
// returns three ranked lists that answer "what actually helps for THIS game".
//
// - notesTerms:     curated term-list frequency in free-text notes, with the
//                   share of matches that came from positive-rating reports.
// - protonVersions: normalized proton version buckets, count + positive_ratio.
// - launchOptions:  tokens from the launchOptions field of positive reports,
//                   surfaced in frequency order.
//
// "Positive" = gold or platinum. Silver is common on Linux native ports where
// scoring is inflated and produces noisy signal, so we hold the bar at gold+
// for the correlation number even though we count silver-and-up as valid
// launch-option evidence.

export const POSITIVE_RATINGS = new Set(['gold', 'platinum']);
export const LAUNCH_OPT_RATINGS = new Set(['silver', 'gold', 'platinum']);

// Curated seed list of terms worth surfacing when they show up in notes.
// Kept flat and simple; grow from what shows up in real data rather than
// try to be exhaustive up front. Each entry: [display, regex]. Regex uses
// case-insensitive word boundaries where possible.
export const CURATED_NOTE_TERMS = [
  ['Proton-GE',        /\b(proton[- ]?ge|glorious[- ]eggroll|ge[- ]proton)\b/i],
  ['Proton Experimental', /\bproton[- ]?experimental\b/i],
  ['MangoHud',         /\bmangohud\b/i],
  ['GameMode',         /\bgamemode(?:run)?\b/i],
  ['DXVK',             /\bdxvk\b/i],
  ['DXVK_ASYNC',       /\bdxvk[_-]?async\b/i],
  ['VKD3D',            /\bvkd3d(?:[-_]proton)?\b/i],
  ['NVAPI',            /\b(?:proton[_-]enable[_-])?nvapi\b/i],
  ['FSR',              /\b(?:wine[_-]fullscreen[_-])?fsr\b/i],
  ['DLSS',             /\bdlss\b/i],
  ['Reflex',           /\breflex\b/i],
  ['VRR',              /\bvrr\b/i],
  ['HDR',              /\bhdr\b/i],
  ['dgVoodoo2',        /\bdgvoodoo2?\b/i],
  ['Wine staging',     /\bwine[- ]staging\b/i],
  ['Lutris',           /\blutris\b/i],
  ['Bottles',          /\bbottles\b/i],
  ['gamescope',        /\bgamescope\b/i],
  ['nvidia driver',    /\bnvidia[- ]driver\b/i],
  ['mesa',             /\bmesa\b/i],
  ['fsync',            /\bf(?:u|)?sync\b/i],
  ['esync',            /\besync\b/i],
  ['winetricks',       /\bwinetricks\b/i],
  ['dotnet',           /\b(?:dotnet|\.net)\s?\d/i],
  ['vcredist',         /\bvcredist\b/i],
  ['media foundation', /\bmedia[- ]foundation\b/i],
  ['DXVK_HUD',         /\bdxvk[_-]hud\b/i],
  ['dxvk-nvapi',       /\bdxvk[- ]nvapi\b/i],
  ['EAC',              /\b(?:easy[- ]anti[- ]cheat|eac)\b/i],
  ['BattlEye',         /\bbattl?eye\b/i],
];

// Normalize a proton version string to a coarse bucket so noisy variants
// (e.g. "GE-Proton8-32", "Proton-GE 8.32", "GE 8-32") count together.
export function normalizeProtonVersion(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const lc = s.toLowerCase();
  // GE-Proton family. Try to keep the major-minor tag so trend-over-time
  // stays legible; if we can't parse one out, fold to a single "GE-Proton" bucket.
  // No trailing \b -- raw strings like "GE-Proton8-32" have no word boundary
  // between "Proton" and "8", so a trailing \b false-negatives the family.
  if (/\b(?:ge[- ]?proton|proton[- ]?ge|glorious[- ]?eggroll)/i.test(s)) {
    const m = s.match(/\b(?:ge[- ]?proton|proton[- ]?ge)[- ]?(\d+[-.]?\d*)/i);
    return m ? `GE-Proton ${m[1].replace('-', '.')}` : 'GE-Proton';
  }
  if (/\bexperimental\b/i.test(s)) return 'Proton Experimental';
  if (/\bhotfix\b/i.test(s)) return 'Proton Hotfix';
  const m = s.match(/\bproton\b[^\d]*(\d+(?:\.\d+)?)/i);
  if (m) return `Proton ${m[1]}`;
  // Bare numeric like "8.0-5" from ProtonDB
  const m2 = s.match(/^(\d+\.\d+)/);
  if (m2) return `Proton ${m2[1]}`;
  if (lc === 'default' || lc === 'valve' || lc === 'proton') return 'Proton (default)';
  // Fallback: keep the raw string trimmed to 30 chars so it does not blow up UI.
  return s.length > 30 ? s.slice(0, 30) + '...' : s;
}

// Split a launchOptions string into meaningful tokens. Handles the two common
// shapes ProtonDB reports use:
//   - "MANGOHUD=1 gamemoderun %command% -novid"
//   - "gamescope -w 1280 -h 800 -- %command%"
// We keep NAME=value pairs, known-good wrapper names, and CLI flags that begin
// with "-" or "+" and look like game args (not just single letters).
export function tokenizeLaunchOptions(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const tokens = s.split(/\s+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    // Skip the placeholder itself; it's noise.
    if (tok === '%command%' || tok === '$command') continue;
    // Skip bare shell operators
    if (tok === '--' || tok === '|' || tok === '&&') continue;
    // NAME=value env vars (single-quoted values collapsed to bare form)
    if (/^[A-Z][A-Z0-9_]{1,}=/.test(tok)) {
      out.push(tok.replace(/^([A-Z0-9_]+)=(['"]?)(.*)\2$/, '$1=$3'));
      continue;
    }
    // Known wrappers / commands
    if (/^(gamemoderun|mangohud|gamescope|obs-vkcapture|obs-glcapture|primusrun|optirun|env)$/i.test(tok)) {
      out.push(tok.toLowerCase());
      continue;
    }
    // Long flags -foo / --foo / +foo (not single-letter, not just numbers)
    if (/^[-+][a-zA-Z][a-zA-Z0-9_-]{1,}$/.test(tok)) {
      out.push(tok);
    }
  }
  return out;
}

// Extract the free-text notes field, tolerant of the two common shapes.
export function noteText(report) {
  return String(report?.notes || report?.note || '').trim();
}

export function protonVersionOf(report) {
  return normalizeProtonVersion(report?.protonVersion || report?.proton_version || '');
}

export function launchOptionsOf(report) {
  return String(report?.launchOptions || report?.launch_options || '').trim();
}

export function ratingOf(report) {
  return String(report?.rating || '').trim().toLowerCase();
}

function positiveRatio(counts) {
  const total = counts.total;
  if (!total) return 0;
  return counts.positive / total;
}

// Main entry point. Returns three ranked lists.
// Options:
//   - noteTerms: override the curated list (mostly for tests)
//   - topN:      number of entries to return per section (default 10)
export function computeWhatWorks(reports, { noteTerms = CURATED_NOTE_TERMS, topN = 10 } = {}) {
  const list = Array.isArray(reports) ? reports : [];

  const noteAgg = new Map();       // term -> { total, positive, sampleGames: Map<appId, title> }
  const protonAgg = new Map();     // bucket -> { total, positive, topGames }
  const launchAgg = new Map();     // token -> { total, positive, topGames }

  for (const r of list) {
    const rating = ratingOf(r);
    const isPositive = POSITIVE_RATINGS.has(rating);
    const isLaunchEvidence = LAUNCH_OPT_RATINGS.has(rating);
    const appId = String(r?.appId ?? r?.app_id ?? '');
    const title = String(r?.title || '');

    const notes = noteText(r);
    if (notes) {
      for (const [display, re] of noteTerms) {
        if (re.test(notes)) {
          const rec = noteAgg.get(display) || { total: 0, positive: 0, sampleGames: new Map() };
          rec.total += 1;
          if (isPositive) rec.positive += 1;
          if (appId && !rec.sampleGames.has(appId)) rec.sampleGames.set(appId, title);
          noteAgg.set(display, rec);
        }
      }
    }

    const proton = protonVersionOf(r);
    if (proton) {
      const rec = protonAgg.get(proton) || { total: 0, positive: 0, topGames: new Map() };
      rec.total += 1;
      if (isPositive) rec.positive += 1;
      if (appId && !rec.topGames.has(appId)) rec.topGames.set(appId, title);
      protonAgg.set(proton, rec);
    }

    if (isLaunchEvidence) {
      const opts = launchOptionsOf(r);
      if (opts) {
        const seen = new Set();  // dedupe within the same report
        for (const tok of tokenizeLaunchOptions(opts)) {
          if (seen.has(tok)) continue;
          seen.add(tok);
          const rec = launchAgg.get(tok) || { total: 0, positive: 0, topGames: new Map() };
          rec.total += 1;
          if (isPositive) rec.positive += 1;
          if (appId && !rec.topGames.has(appId)) rec.topGames.set(appId, title);
          launchAgg.set(tok, rec);
        }
      }
    }
  }

  const notesTerms = [...noteAgg.entries()]
    .map(([term, c]) => ({
      term,
      count: c.total,
      positive_ratio: positiveRatio(c),
      sample_games: [...c.sampleGames.entries()].slice(0, 5).map(([appId, title]) => ({ appId, title })),
    }))
    .sort((a, b) => b.count - a.count || b.positive_ratio - a.positive_ratio)
    .slice(0, topN);

  const protonVersions = [...protonAgg.entries()]
    .map(([version, c]) => ({
      version,
      count: c.total,
      positive_ratio: positiveRatio(c),
      top_games: [...c.topGames.entries()].slice(0, 5).map(([appId, title]) => ({ appId, title })),
    }))
    .sort((a, b) => b.count - a.count || b.positive_ratio - a.positive_ratio)
    .slice(0, topN);

  const launchOptions = [...launchAgg.entries()]
    .map(([token, c]) => ({
      token,
      count: c.total,
      positive_ratio: positiveRatio(c),
      top_games: [...c.topGames.entries()].slice(0, 5).map(([appId, title]) => ({ appId, title })),
    }))
    .sort((a, b) => b.count - a.count || b.positive_ratio - a.positive_ratio)
    .slice(0, topN);

  return {
    notesTerms,
    protonVersions,
    launchOptions,
    totals: {
      reports: list.length,
      positive: list.filter(r => POSITIVE_RATINGS.has(ratingOf(r))).length,
    },
  };
}
