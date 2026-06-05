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
// Logging helpers
// ---------------------------------------------------------------------------

function log(msg, data) {
  if (data !== undefined) {
    console.log(`[${ts()}] ${msg}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${ts()}] ${msg}`);
  }
}

function warn(msg, data) {
  if (data !== undefined) {
    console.warn(`[${ts()}] WARN ${msg}`, JSON.stringify(data, null, 2));
  } else {
    console.warn(`[${ts()}] WARN ${msg}`);
  }
}

function err(msg, data) {
  if (data !== undefined) {
    console.error(`[${ts()}] ERROR ${msg}`, JSON.stringify(data, null, 2));
  } else {
    console.error(`[${ts()}] ERROR ${msg}`);
  }
}

function ts() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Layer 1: naughty-words wordlist (multilingual, offline)
// ---------------------------------------------------------------------------

let wordlistFilter = null;

async function buildWordlistFilter() {
  log('Loading naughty-words wordlist...');
  const mod = await import('naughty-words');
  const naughtyWords = mod.default ?? mod;

  const terms = new Set();
  for (const lang of Object.values(naughtyWords)) {
    if (Array.isArray(lang)) {
      for (const w of lang) terms.add(w.toLowerCase());
    }
  }

  log(`Wordlist ready.`, { termCount: terms.size });

  return {
    check(text) {
      const lower = text.toLowerCase();
      for (const term of terms) {
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

async function moderateWithOpenAI(text, rowId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    log(`OpenAI request`, { rowId, attempt, url: OPENAI_MOD_URL, inputLength: text.length });

    const res = await fetch(OPENAI_MOD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text }),
    });

    log(`OpenAI response`, { rowId, attempt, status: res.status, headers: Object.fromEntries(res.headers) });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 2000, 30000);
      warn(`Rate limited by OpenAI`, { rowId, attempt, retries, waitMs: wait });
      if (attempt === retries) throw new Error(`OpenAI moderation rate-limited after ${retries} attempts`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI moderation failed: ${res.status} ${body}`);
    }

    const data = await res.json();
    const result = data.results?.[0];
    if (!result) throw new Error('Unexpected OpenAI moderation response shape');

    const flaggedCategories = Object.entries(result.categories ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);

    log(`OpenAI result`, {
      rowId,
      flagged: result.flagged,
      categories: flaggedCategories,
      scores: result.category_scores,
    });

    return { flagged: result.flagged, categories: flaggedCategories };
  }
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function fetchRecentRows() {
  const since = new Date(Date.now() - LOOKBACK_H * 3600 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?select=id,notes,title,launch_options,form_responses,proton_pulse_user_id,client_id`
    + `&or=(created_at.gte.${since},updated_at.gte.${since})`
    + `&is_hidden=eq.false`
    + `&order=id.asc`
    + (APP_ID ? `&app_id=eq.${APP_ID}` : '');

  log(`Supabase fetch request`, { url: url.replace(SUPABASE_URL, '<SUPABASE_URL>'), since });

  const res = await fetch(url, { headers: SUPABASE_HEADERS });
  log(`Supabase fetch response`, { status: res.status });

  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);

  const rows = await res.json();
  log(`Supabase rows returned`, { count: rows.length, ids: rows.map(r => r.id) });
  return rows;
}

async function flagRow(id, reason) {
  const payload = {
    is_flagged: true,
    is_hidden: true,
    flagged_reason: reason,
    flagged_at: new Date().toISOString(),
  };

  if (DRY_RUN) {
    log(`[DRY RUN] would PATCH row`, { id, payload });
    return;
  }

  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${id}`;
  log(`Supabase PATCH request`, { id, url: url.replace(SUPABASE_URL, '<SUPABASE_URL>'), payload });

  const res = await fetch(url, {
    method: 'PATCH',
    headers: SUPABASE_HEADERS,
    body: JSON.stringify(payload),
  });

  log(`Supabase PATCH response`, { id, status: res.status });
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
  log(`Moderation scan starting`, {
    lookbackHours: LOOKBACK_H,
    appId: APP_ID || 'all',
    dryRun: DRY_RUN,
    openai: !!OPENAI_KEY,
  });

  wordlistFilter = await buildWordlistFilter();

  const rows = await fetchRecentRows();

  let scanned = 0;
  let flaggedCount = 0;
  const flaggedIds = [];

  for (const row of rows) {
    const fields = extractTextFields(row);
    log(`Scanning row`, { id: row.id, fields: fields.map(f => ({ field: f.field, length: f.text.length })) });

    if (fields.length === 0) {
      log(`Row ${row.id}: no text fields, skipping.`);
      scanned++;
      continue;
    }

    let hitReason = null;
    let hitLayer = null;

    // Layer 1: wordlist
    for (const { field, text } of fields) {
      const hit = wordlistFilter.check(text);
      log(`Wordlist check`, { id: row.id, field, flagged: hit.flagged, ...(hit.term ? { term: hit.term } : {}) });
      if (hit.flagged) {
        hitReason = `wordlist:${hit.term} in ${field}`;
        hitLayer = 'wordlist';
        break;
      }
    }

    // Layer 2: OpenAI (only if wordlist passed and key is set)
    if (!hitReason && OPENAI_KEY) {
      const combined = fields.map(f => f.text).join('\n');
      try {
        const result = await moderateWithOpenAI(combined, row.id);
        if (result.flagged) {
          hitReason = `openai:${result.categories.join(',')}`;
          hitLayer = 'openai';
        }
      } catch (e) {
        err(`OpenAI call failed for row ${row.id}`, { message: e.message });
      }
      await new Promise(r => setTimeout(r, 1050));
    }

    scanned++;

    if (hitReason) {
      log(`FLAGGED row ${row.id}`, { layer: hitLayer, reason: hitReason });
      await flagRow(row.id, hitReason);
      flaggedIds.push(row.id);
      flaggedCount++;
    } else {
      log(`Row ${row.id}: clean.`);
    }
  }

  log(`Scan complete`, { scanned, flagged: flaggedCount, flaggedIds });

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

main().catch(e => { err('Fatal error', { message: e.message, stack: e.stack }); process.exit(1); });
