#!/usr/bin/env node
/**
 * Scans user_configs rows for toxic content using the OpenAI Moderation API.
 * Supports any language the API handles (English, Spanish, French, German, etc.).
 *
 * Required env vars:
 *   SUPABASE_URL            - e.g. https://ilsgdshkaocrmibwdezk.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY - bypasses RLS so all rows are visible
 *   OPENAI_API_KEY          - used only for the free /v1/moderations endpoint
 *
 * Optional env vars:
 *   LOOKBACK_HOURS  - only scan rows updated within this window (default: 25)
 *   APP_ID          - restrict scan to a single Steam app ID
 *   DRY_RUN         - set to "true" to log without writing back to Supabase
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const LOOKBACK_H   = parseInt(process.env.LOOKBACK_HOURS ?? '25', 10);
const APP_ID       = process.env.APP_ID ?? '';
const DRY_RUN      = process.env.DRY_RUN === 'true';

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) {
  console.error('ERROR: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OPENAI_API_KEY are required.');
  process.exit(1);
}

const SUPABASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

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

  if (row.notes)         fields.push({ field: 'notes',         text: row.notes });
  if (row.title)         fields.push({ field: 'title',         text: row.title });
  if (row.launch_options) fields.push({ field: 'launch_options', text: row.launch_options });

  if (row.form_responses && typeof row.form_responses === 'object') {
    const fr = row.form_responses;
    const noteKeys = [
      'onlineMultiplayerNotes', 'localMultiplayerNotes', 'framegenNotes',
      'offlineNotes', 'generalNotes',
    ];
    for (const key of noteKeys) {
      if (fr[key]) fields.push({ field: `form_responses.${key}`, text: fr[key] });
    }
    // scan any *Notes key we don't know about yet
    for (const [key, val] of Object.entries(fr)) {
      if (key.endsWith('Notes') && val && !noteKeys.includes(key)) {
        fields.push({ field: `form_responses.${key}`, text: val });
      }
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// OpenAI Moderation API
// ---------------------------------------------------------------------------

const OPENAI_MOD_URL = 'https://api.openai.com/v1/moderations';

async function moderateText(text) {
  const res = await fetch(OPENAI_MOD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: text }),
  });

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Moderation scan started. lookback=${LOOKBACK_H}h app_id=${APP_ID || 'all'} dry_run=${DRY_RUN}`);

  const rows = await fetchRecentRows();
  console.log(`Fetched ${rows.length} rows to scan.`);

  let scanned = 0;
  let flagged = 0;
  const flaggedIds = [];

  for (const row of rows) {
    const fields = extractTextFields(row);
    if (fields.length === 0) { scanned++; continue; }

    // Concatenate all text for a single API call per row to minimise rate-limit exposure.
    const combined = fields.map(f => f.text).join('\n');

    let result;
    try {
      result = await moderateText(combined);
    } catch (err) {
      console.error(`ERROR moderating row ${row.id}: ${err.message}`);
      continue;
    }

    scanned++;

    if (result.flagged) {
      const reason = result.categories.join(', ');
      console.log(`FLAGGED row ${row.id} [${reason}]`);
      await flagRow(row.id, reason);
      flaggedIds.push(row.id);
      flagged++;
    }

    // Respect OpenAI free-tier rate limits: ~60 req/min.
    await new Promise(r => setTimeout(r, 1050));
  }

  console.log(`\nScan complete. scanned=${scanned} flagged=${flagged}`);
  if (flaggedIds.length) console.log(`Flagged IDs: ${flaggedIds.join(', ')}`);

  // Emit summary for GitHub Actions job summary.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [
      `## Content moderation summary`,
      `| | |`,
      `|---|---|`,
      `| Rows scanned | ${scanned} |`,
      `| Rows flagged | ${flagged} |`,
      `| Lookback | ${LOOKBACK_H}h |`,
      `| App ID filter | ${APP_ID || 'all'} |`,
      `| Dry run | ${DRY_RUN} |`,
    ];
    if (flaggedIds.length) lines.push(`\nFlagged row IDs: ${flaggedIds.join(', ')}`);
    const fs = await import('fs');
    fs.appendFileSync(summary, lines.join('\n') + '\n');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
