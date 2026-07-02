// scoring (shared) module. Used across multiple pages. Relocated from app-scoring.js.

// Scoring logic and report tiering -- factored out of app.js to keep things
// navigable. Loaded as a classic script BEFORE app.js so its globals
// (loadScoringInfo, FAULT_KEYS_WEB, deriveRatingFromState, inferProtonType,
// populateScoringTooltip, tierFromReports, pulseTierFromReports,
// estimateScore, scoringInfo state) are available when app.js runs.
//
// All public scoring concepts derive from scoring-info.json, which is itself
// exported from the plugin's src/lib/scoring.ts. Single source of truth.

// --- scoringInfo state ---
/** Cached scoring config loaded from scoring-info.json. Null until loadScoringInfo resolves. */
export let scoringInfo     = null;   // loaded from scoring-info.json

// --- loadScoringInfo ---
/**
 * Fetches and caches the scoring config from scoring-info.json.
 * Returns the parsed object on success, or null if the fetch fails.
 * Subsequent calls return the cached value without re-fetching.
 * @returns {Promise<object|null>}
 */
export async function loadScoringInfo() {
  if (scoringInfo) return scoringInfo;
  try {
    const r = await fetch('scoring-info.json');
    scoringInfo = r.ok ? await r.json() : null;
  } catch { scoringInfo = null; }
  return scoringInfo;
}

// --- FAULT_KEYS_WEB ---
/** Form field keys that represent fault questions in a Pulse report. */
export const FAULT_KEYS_WEB = [
  'performanceFaults', 'graphicalFaults', 'windowingFaults', 'audioFaults',
  'inputFaults', 'stabilityFaults', 'saveGameFaults', 'significantBugs',
];

// --- deriveRatingFromState ---
/**
 * Derives a Pulse tier string from a report form state object.
 * Counts active fault keys to pick between bronze/silver/gold, then
 * uses tinkering method presence to distinguish gold from platinum.
 * Returns null if the state has no verdict yet.
 * @param {object} s - Form state with canInstall, canStart, canPlay, verdict, faults, tinkeringMethods, verdictOob.
 * @returns {'platinum'|'gold'|'silver'|'bronze'|'borked'|null}
 */
export function deriveRatingFromState(s) {
  if (s.canInstall === 'no' || s.canStart === 'no' || s.canPlay === 'no') return 'borked';
  if (!s.verdict) return null;
  if (s.verdict === 'no') return 'borked';
  const faultCount = FAULT_KEYS_WEB.reduce((n, k) => (s.faults[k] === 'yes' ? n + 1 : n), 0);
  if (faultCount >= 3) return 'bronze';
  if (faultCount === 2) return 'silver';
  if (faultCount === 1) return 'gold';
  // Out-of-box = no tinkering methods selected. Used to be a separate yes/no
  // question but it was redundant with the tinkering checkboxes (any method
  // checked == not OOB). Legacy form_responses might still carry an explicit
  // verdictOob='yes' from older clients, so honor that as a fallback
  const tinkered = (s.tinkeringMethods && s.tinkeringMethods.size > 0)
    || (Array.isArray(s.tinkeringMethods) && s.tinkeringMethods.length > 0);
  if (!tinkered) return 'platinum';
  if (s.verdictOob === 'yes') return 'platinum';
  return 'gold';
}

// --- inferProtonType ---
/**
 * Classifies a Proton version string as 'ge', 'native', 'current', or null.
 * @param {string} version - Raw Proton version string from a report.
 * @returns {'ge'|'native'|'current'|null}
 */
export function inferProtonType(version) {
  const v = (version || '').toLowerCase();
  if (v.includes('ge-proton') || v.includes('proton-ge')) return 'ge';
  if (v === 'native' || v === 'no proton') return 'native';
  if (v.includes('proton')) return 'current';
  return null;
}

// --- populateScoringTooltip ---
/**
 * Populates the #rating-info-content element inside el with scoring methodology HTML.
 * Fetches scoring-info.json once (idempotent via dataset.loaded flag).
 * @param {HTMLElement} el - Container element that holds #rating-info-content.
 * @returns {Promise<void>}
 */
export async function populateScoringTooltip(el) {
  const container = el.querySelector('#rating-info-content');
  if (!container || container.dataset.loaded) return;
  const s = await loadScoringInfo();
  if (!s) { container.textContent = 'Could not load scoring-info.json'; return; }
  const w = s.weights;
  const rs = s.ratingScores;
  const t = s.scoreTiers;
  const ratingLine = Object.entries(rs).map(([k,v]) => `${k[0].toUpperCase()+k.slice(1)}=${Math.round(v*w.BASE_MAX)}`).join(', ');
  const tierLine = Object.entries(t).map(([k,v]) => `>=${v}: ${k[0].toUpperCase()+k.slice(1)}`).join(' | ') + ' | <' + t.bronze + ': Borked';
  const osFams = Object.entries(s.osFamilies).map(([parent, kids]) => `${parent}: ${kids.join(', ')}`).join(' | ');
  const TIER_BG = { platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0', bronze: '#b07040', borked: '#c85050' };
  const TIER_FG = { platinum: '#111', gold: '#111', silver: '#111', bronze: '#fff', borked: '#fff' };
  const tierRows = (s.tiers || []).map(({ name, rule }) =>
    `<div style="display:flex;gap:8px;align-items:flex-start"><span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;background:${TIER_BG[name]||'#555'};color:${TIER_FG[name]||'#fff'};flex-shrink:0;text-transform:uppercase">${name}</span><span>${rule}</span></div>`
  ).join('');
  container.innerHTML = `
    <h3 style="margin:0 0 10px">How Pulse Ratings Are Determined</h3>
    Your Yes/No answers in the report form determine the rating automatically based on fault count:<br><br>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px">${tierRows}</div>

    <h4 style="margin:0 0 6px">Fault questions</h4>
    Each "Yes" to a fault question counts as 1 fault. Faults: ${(s.faultQuestionsDisplay || []).join(', ')}.<br><br>

    <h4 style="margin:0 0 6px">Out-of-the-box question</h4>
    ${s.outOfBoxNote || ''}<br><br>

    <h4 style="margin:0 0 6px">Quick reference</h4>
    <code>${(s.quickReference || []).join(' &nbsp;|&nbsp; ')}</code><br><br>

    <h3 style="margin:10px 0 10px">Report Ranking Score</h3>
    Each report gets a relevance score (0-100) based on how closely it matches <em>your</em> hardware in the Decky plugin. On this website an estimate is shown without local system info.<br><br>

    <h4 style="margin:0 0 6px">1. Base Rating (0-${w.BASE_MAX} pts)</h4>
    <code>${ratingLine}</code><br>
    Borked reports older than ${w.BORKED_DECAY_DAYS} days are treated as Bronze.<br><br>

    <h4 style="margin:0 0 6px">2. Recency Bonus</h4>
    <code>&lt;90 days: +${w.RECENCY_RECENT} | 90-365 days: +${w.RECENCY_MID} | &gt;1 year: ${w.RECENCY_OLD}</code><br><br>

    <h4 style="margin:0 0 6px">3. Custom Proton Bonus (+${w.CUSTOM_PROTON})</h4>
    Reports using ${s.customProtonMarkers.join(', ')} builds get +${w.CUSTOM_PROTON}.<br><br>

    <h4 style="margin:0 0 6px">4. Proton Version Match</h4>
    <code>Same major: +${w.PROTON_MATCH} | Adjacent: +${w.PROTON_CLOSE}</code><br><br>

    <h4 style="margin:0 0 6px">5. Playtime Confidence Bonus</h4>
    Applied inside the GPU/OS/kernel multiplier so it scales with system match.<br>
    <code>&lt;1h: +${w.PLAYTIME_UNDER_ONE_HOUR} | 1-4h: +${w.PLAYTIME_ONE_TO_FOUR_HOURS} | 4-10h: +${w.PLAYTIME_FOUR_TO_TEN_HOURS} | 10h+: +${w.PLAYTIME_OVER_TEN_HOURS}</code><br>
    Reports with no playtime declared receive no bonus.<br><br>

    <h4 style="margin:0 0 6px">6. GPU / OS / Kernel Multipliers</h4>
    GPU: <code>Same vendor: ${w.GPU_MATCH}x | Different: ${w.GPU_MISMATCH}x | Unknown: ${w.GPU_UNKNOWN}x</code><br>
    Driver: <code>Same major: ${w.GPU_DRIVER_EXACT}x | Close: ${w.GPU_DRIVER_CLOSE}x</code><br>
    OS: <code>Exact: ${w.OS_EXACT}x | Same family: ${w.OS_FAMILY_MATCH}x</code> &mdash; Families: ${osFams}<br>
    Kernel: <code>Exact: ${w.KERNEL_EXACT}x | Same minor: ${w.KERNEL_PATCH_CLOSE}x | Same major: ${w.KERNEL_MINOR_CLOSE}x</code><br>
    Valve/SteamOS kernels compare build numbers instead of upstream versions.<br><br>

    <h4 style="margin:0 0 6px">7. Notes Sentiment (-${w.NOTES_MAX} to +${w.NOTES_MAX})</h4>
    Negative keywords: <code>${s.negativeKeywords.join(', ')}</code> (-3 each)<br>
    Positive keywords: <code>${s.positiveKeywords.join(', ')}</code> (+2 each)<br>
    Negation-aware: "no crash" does NOT count as negative.<br><br>

    <h4 style="margin:0 0 6px">Duration auto-fill (Decky plugin)</h4>
    ${s.durationAutoFillNote || ''}<br><br>

    <h4 style="margin:0 0 6px">Final Formula</h4>
    <code>${s.formula}</code><br><br>

    <h4 style="margin:0 0 6px">Score-to-Tier Mapping</h4>
    <code>${tierLine}</code><br><br>

    <a href="${s._source}" target="_blank" rel="noopener" style="color:var(--accent)">View full scoring source on GitHub</a>
  `;
  container.dataset.loaded = '1';
}

// --- tierFromReports ---
/**
 * Returns the highest tier present in a set of reports using the canonical
 * platinum > gold > silver > bronze > borked order. Returns 'pending' if empty.
 * @param {Array<{rating: string}>} reports
 * @returns {'platinum'|'gold'|'silver'|'bronze'|'borked'|'pending'}
 */
export function tierFromReports(reports) {
  const order = ['platinum','gold','silver','bronze','borked'];
  const counts = {};
  for (const r of reports) counts[r.rating] = (counts[r.rating] || 0) + 1;
  for (const t of order) if (counts[t]) return t;
  return 'pending';
}

// --- pulseTierFromReports ---
/**
 * Computes a weighted aggregate tier and confidence level for a game.
 * Pulse reports are recency-weighted (full weight) and ProtonDB report count
 * contributes fractionally (0.2x) to the confidence calculation only.
 * @param {Array<{rating: string, timestamp: number}>} nativeReports - Pulse reports for the game.
 * @param {number} [protonDbCount=0] - Number of ProtonDB reports for the game (count only, no detail).
 * @returns {{ tier: string, count: number, confidence: string, confidencePct?: number, confidenceNote: string }}
 */
export function pulseTierFromReports(nativeReports, protonDbCount = 0) {
  if (!nativeReports.length) {
    return { tier: 'pending', count: 0, confidence: 'none', confidenceNote: protonDbCount > 0 ? 'No Pulse reports yet' : 'No Pulse data yet' };
  }
  const SCORE = { platinum: 1.0, gold: 0.8, silver: 0.6, bronze: 0.4, borked: 0.0 };
  const now = Date.now() / 1000;
  let wSum = 0, wTotal = 0;
  for (const r of nativeReports) {
    const days = (now - (r.timestamp || 0)) / 86400;
    const recency = days < 30 ? 1.0 : days < 90 ? 0.85 : days < 180 ? 0.65 : days < 365 ? 0.40 : 0.15;
    const s = SCORE[r.rating] ?? 0.5;
    wSum += s * recency;
    wTotal += recency;
  }
  const avg = wTotal > 0 ? wSum / wTotal : 0;
  const tier = avg >= 0.85 ? 'platinum' : avg >= 0.65 ? 'gold' : avg >= 0.40 ? 'silver' : avg >= 0.15 ? 'bronze' : 'borked';
  const count = nativeReports.length;
  const weightedEvidence = count + (protonDbCount * 0.2);
  const confidence = weightedEvidence >= 6 ? 'high' : weightedEvidence >= 3 ? 'medium' : 'low';
  // Numeric per-game confidence on a 0-100 scale, log-curve over total evidence.
  // ProtonDB reports count at 0.4x Pulse weight (less structured data) so the
  // combined pool drives confidence up without over-inflating it.
  const totalForPct = count + Math.round(protonDbCount * 0.4);
  const confidencePct = Math.min(95, Math.round(30 + Math.log2(Math.max(1, totalForPct)) * 18));
  // Note phrases confidence in terms of TOTAL reports - the system is meant
  // to read as one homogeneous community view (Pulse + ProtonDB combined),
  // so we don't attribute "low confidence" to a thin Pulse count when the
  // ProtonDB pool fills it out
  const totalReports = count + protonDbCount;
  const confidenceNote = `${confidence} confidence (based on ${totalReports} total report${totalReports !== 1 ? 's' : ''})`;
  return { tier, count, confidence, confidencePct, confidenceNote };
}

// --- estimateScore ---
/**
 * Returns a single numeric relevance score (0-100) for a report.
 * Convenience wrapper around estimateScoreBreakdown.
 * @param {object} r - Report object with at least .rating and .timestamp.
 * @returns {number}
 */
export function estimateScore(r) {
  return estimateScoreBreakdown(r).total;
}

/**
 * Same math as estimateScore but also returns per-factor contributions.
 * Used by the confidence-breakdown page to explain why a report scored as it did.
 * Runs a simplified subset of the plugin's computeConfidence (no GPU/OS/kernel match,
 * since the web viewer lacks local hardware info).
 * @param {object} r - Report object with at least .rating and .timestamp.
 * @returns {{ total: number, factors: Array<{label: string, detail: string, value: number}>, meta: object }}
 */
export function estimateScoreBreakdown(r) {
  const RATING_BASE = { platinum: 60, gold: 48, silver: 36, bronze: 24, borked: 0 };
  const base = RATING_BASE[r.rating] ?? 30;
  const days = Math.round((Date.now() / 1000 - (r.timestamp || 0)) / 86400);
  const recencyLabel = days < 90 ? 'fresh (<90d)' : days < 365 ? 'mid (90-365d)' : 'old (>1yr)';
  const recencyVal = days < 90 ? 15 : days < 365 ? 5 : -5;
  const total = Math.max(0, base + recencyVal);
  return {
    total,
    factors: [
      { label: 'Rating baseline',  detail: `rating=${r.rating || 'unknown'}`, value: base },
      { label: 'Recency',          detail: `${days} days old (${recencyLabel})`, value: recencyVal },
    ],
    meta: {
      cappedAtZero: (base + recencyVal) < 0,
      raw: base + recencyVal,
      days,
    },
  };
}
