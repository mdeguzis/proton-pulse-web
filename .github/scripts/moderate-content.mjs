#!/usr/bin/env node
/**
 * Two-layer content moderation for user_configs:
 *   1. Wordlist (naughty-words) - offline, multilingual, fast primary filter
 *   2. OpenAI Moderation API    - semantic fallback for anything the wordlist misses
 *
 * Required env vars:
 *   SUPABASE_URL              - e.g. https://ilsgdshkaocrmibwdezk.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY - bypasses RLS so all rows are visible
 *
 * Optional env vars:
 *   OPENAI_API_KEY  - enables semantic layer; wordlist-only if absent
 *   LOOKBACK_HOURS  - scan window in hours (default: 5)
 *   APP_ID          - restrict to a single Steam app ID
 *   DRY_RUN         - "true" to log without writing to Supabase
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const LOOKBACK_H   = parseInt(process.env.LOOKBACK_HOURS ?? '5', 10);
const APP_ID       = process.env.APP_ID ?? '';
const DRY_RUN      = process.env.DRY_RUN === 'true';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

if (!OPENAI_KEY) {
  console.warn('OPENAI_API_KEY not set - running wordlist-only mode.');
}

const SUPABASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

// ---------------------------------------------------------------------------
// Layer 1: naughty-words wordlist (multilingual, offline)
// ---------------------------------------------------------------------------

let wordlistFilter = null;

async function buildWordlistFilter() {
  const mod = await import('naughty-words');
  const naughtyWords = mod.default ?? mod;

  // Flatten all language arrays into a single Set of lowercase terms.
  const terms = new Set();
  for (const lang of Object.values(naughtyWords)) {
    if (Array.isArray(lang)) {
      for (const w of lang) terms.add(w.toLowerCase());
    }
  }

  return {
    check(text) {
      const lower = text.toLowerCase();
      for (const term of terms) {
        // Whole-word match to reduce false positives on substrings.
        const re = new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i');
        if (re.test(lower)) return { flagged: true, term };
      }
      return { flagged: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Layer 2: OpenAI Moderation API (semantic, multilingual)
// ---------------------------------------------------------------------------

const OPENAI_MOD_URL = 'https://api.openai.com/v1/moderations';

async function moderateWithOpenAI(text, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(OPENAI_MOD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text }),
    });

    if (res.status === 429) {
      // Respect Retry-After if present, otherwise exponential backoff.
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 2000, 30000);
      console.warn(`OpenAI 429 rate limit (attempt ${attempt}/${retries}), waiting ${wait}ms...`);
      if (attempt === retries) throw new Error(`OpenAI moderation rate-limited after ${retries} attempts`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) throw new Error(`OpenAI moderation failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) throw new Error('Unexpected OpenAI moderation response shape');

    return {
      flagged: result.flagged,
      categories: Object.entries(result.categories ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k),
    };
  }
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function fetchRecentRows() {
  const since = new Date(Date.now() - LOOKBACK_H * 3600 * 1000).toISOString();
  let url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?select=id,notes,title,launch_options,form_responses,proton_pulse_user_id,client_id`
    + `&or=(created_at.gte.${since},updated_at.gte.${since})`
    + `&is_hidden=eq.false`
    + `&order=id.asc`;

  if (APP_ID) url += `&app_id=eq.${APP_ID}`;

  const res = await fetch(url, { headers: SUPABASE_HEADERS });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function flagRow(id, reason) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] would flag row ${id}: ${reason}`);
    return;
  }
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${id}`;
  const body = JSON.stringify({
    is_flagged: true,
    is_hidden: true,
    flagged_reason: reason,
    flagged_at: new Date().toISOString(),
  });
  const res = await fetch(url, { method: 'PATCH', headers: SUPABASE_HEADERS, body });
  if (!res.ok) throw new Error(`Supabase PATCH failed for id=${id}: ${res.status} ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function extractTextFields(row) {
  const fields = [];
  if (row.notes)          fields.push({ field: 'notes',          text: row.notes });
  if (row.title)          fields.push({ field: 'title',          text: row.title });
  if (row.launch_options) fields.push({ field: 'launch_options', text: row.launch_options });

  if (row.form_responses && typeof row.form_responses === 'object') {
    for (const [key, val] of Object.entries(row.form_responses)) {
      if (key.endsWith('Notes') && typeof val === 'string' && val.trim()) {
        fields.push({ field: `form_responses.${key}`, text: val });
      }
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Moderation scan started. lookback=${LOOKBACK_H}h app_id=${APP_ID || 'all'} dry_run=${DRY_RUN} openai=${!!OPENAI_KEY}`);

  wordlistFilter = await buildWordlistFilter();
  console.log('Wordlist filter ready.');

  const rows = await fetchRecentRows();
  console.log(`Fetched ${rows.length} rows to scan.`);

  let scanned = 0;
  let flaggedCount = 0;
  const flaggedIds = [];

  for (const row of rows) {
    const fields = extractTextFields(row);
    if (fields.length === 0) { scanned++; continue; }

    let hitReason = null;
    let hitLayer = null;

    // Layer 1: wordlist (fast, offline, no rate limits)
    for (const { field, text } of fields) {
      const hit = wordlistFilter.check(text);
      if (hit.flagged) {
        hitReason = `wordlist:${hit.term} in ${field}`;
        hitLayer = 'wordlist';
        break;
      }
    }

    // Layer 2: OpenAI semantic check (only if wordlist passed and key is available)
    if (!hitReason && OPENAI_KEY) {
      const combined = fields.map(f => f.text).join('\n');
      try {
        const result = await moderateWithOpenAI(combined);
        if (result.flagged) {
          hitReason = `openai:${result.categories.join(',')}`;
          hitLayer = 'openai';
        }
      } catch (err) {
        console.error(`ERROR calling OpenAI for row ${row.id}: ${err.message}`);
      }
      // Respect OpenAI free-tier: ~60 req/min
      await new Promise(r => setTimeout(r, 1050));
    }

    scanned++;

    if (hitReason) {
      console.log(`FLAGGED row ${row.id} via ${hitLayer}: ${hitReason}`);
      await flagRow(row.id, hitReason);
      flaggedIds.push(row.id);
      flaggedCount++;
    }
  }

  console.log(`\nScan complete. scanned=${scanned} flagged=${flaggedCount}`);
  if (flaggedIds.length) console.log(`Flagged IDs: ${flaggedIds.join(', ')}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [
      `## Content moderation summary`,
      `| | |`,
      `|---|---|`,
      `| Rows scanned | ${scanned} |`,
      `| Rows flagged | ${flaggedCount} |`,
      `| Lookback | ${LOOKBACK_H}h |`,
      `| App ID filter | ${APP_ID || 'all'} |`,
      `| Dry run | ${DRY_RUN} |`,
      `| Layers | wordlist${OPENAI_KEY ? ' + openai' : ' only'} |`,
    ];
    if (flaggedIds.length) lines.push(`\nFlagged row IDs: ${flaggedIds.join(', ')}`);
    const fs = await import('fs');
    fs.appendFileSync(summary, lines.join('\n') + '\n');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
