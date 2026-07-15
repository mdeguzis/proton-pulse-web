#!/usr/bin/env node
/**
 * Two-layer content moderation for user-submitted text.
 *
 * Primary scan (with auto-remediation):
 *   - user_configs.notes / title / launch_options / form_responses
 *     Hits are auto-flagged: is_flagged=true, is_hidden=true, flagged_reason set.
 *
 * Aux scans (alert-only, no auto-remediation):
 *   - user_proton_configs.app_name    (#331)
 *   - user_systems.label              (#332)
 *   - user_systems.sysinfo_text       (MEDIUM followup)
 *   - flagged_reports.reason_text     (MEDIUM followup)
 *   These tables have no moderation columns, so a hit opens a GitHub
 *   issue labeled `content-moderation-review` for manual admin follow-up
 *   rather than mutating the row. Issue creation is rate-limited to
 *   MAX_NEW_ISSUES_PER_RUN so a spammer cannot flood the tracker.
 *
 * Layers used per row:
 *   0. Banned phrases (admin-managed, Supabase)
 *   1. Wordlist (naughty-words, offline)
 *   2. OpenAI Moderation API (semantic fallback, opt-in via key)
 *
 * Required env vars:
 *   SUPABASE_URL              - e.g. https://ilsgdshkaocrmibwdezk.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY - bypasses RLS so all rows are visible
 *
 * Optional env vars:
 *   OPENAI_API_KEY  - enables semantic layer; wordlist-only if absent
 *   LOOKBACK_HOURS  - scan window in hours (default: 5)
 *   APP_IDS         - restrict to a comma-separated list of Steam app IDs (#218 standard)
 *   APP_ID          - legacy singular alias for APP_IDS; still honored for backcompat
 *   DRY_RUN         - "true" to log without writing to Supabase
 *   GH_TOKEN + REPO - required for aux-scan issue alerts; scans still run without,
 *                     they just log the hits and skip issue creation
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const GH_TOKEN     = process.env.GH_TOKEN;
const GH_REPO      = process.env.REPO || process.env.GITHUB_REPOSITORY;
const LOOKBACK_H   = parseInt(process.env.LOOKBACK_HOURS ?? '5', 10);
// #218: standard env is APP_IDS (comma-separated). Fall back to the legacy
// APP_ID (singular) so an old dispatch from a saved link keeps working.
const APP_IDS      = (process.env.APP_IDS || process.env.APP_ID || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
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
// Layer 0: custom banned phrases from Supabase (admin-managed, supports regex)
// ---------------------------------------------------------------------------

let bannedPhrasesFilter = null;

async function buildBannedPhrasesFilter() {
  const url = `${SUPABASE_URL}/rest/v1/banned_phrases?select=pattern,is_regex&enabled=eq.true`;
  try {
    const res = await fetch(url, { headers: SUPABASE_HEADERS });
    if (!res.ok) {
      warn('Could not load banned_phrases from Supabase', { status: res.status });
      return { check: () => ({ flagged: false }) };
    }
    const rows = await res.json();
    log('Banned phrases loaded', { count: rows.length });

    const literals = rows.filter(r => !r.is_regex).map(r => r.pattern.toLowerCase());
    const regexes  = rows.filter(r => r.is_regex).map(r => {
      try { return { re: new RegExp(r.pattern, 'i'), pattern: r.pattern }; }
      catch { warn('Invalid regex in banned_phrases, skipping', { pattern: r.pattern }); return null; }
    }).filter(Boolean);

    return {
      check(text) {
        const lower = text.toLowerCase();
        for (const lit of literals) {
          if (lower.includes(lit)) return { flagged: true, term: lit };
        }
        for (const { re, pattern } of regexes) {
          if (re.test(text)) return { flagged: true, term: pattern };
        }
        return { flagged: false };
      },
    };
  } catch (e) {
    warn('Failed to build banned phrases filter', { error: e.message });
    return { check: () => ({ flagged: false }) };
  }
}

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
    + (APP_IDS.length === 1 ? `&app_id=eq.${encodeURIComponent(APP_IDS[0])}`
       : APP_IDS.length > 1 ? `&app_id=in.(${APP_IDS.map(encodeURIComponent).join(',')})`
       : '');

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
// Aux-table scans (#331, #332): user_proton_configs.app_name +
// user_systems.label. These tables have no is_flagged / is_hidden
// columns, so hits do not auto-remediate. Instead we open a GitHub issue
// labeled content-moderation-review + security so an admin can triage
// via Supabase directly.
// ---------------------------------------------------------------------------

async function ghIssueExists(title) {
  if (!GH_TOKEN || !GH_REPO) return false;
  const q = encodeURIComponent(`repo:${GH_REPO} is:issue is:open in:title "${title}"`);
  const res = await fetch(`https://api.github.com/search/issues?q=${q}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return false;
  const data = await res.json();
  return (data.total_count || 0) > 0;
}

// Cap the number of new issues per run so a spammer who submits N bad
// rows in one lookback window cannot force us to file N GitHub issues.
// De-dupe on existing-title still applies first; this only counts NEW
// issues we would otherwise create.
const MAX_NEW_ISSUES_PER_RUN = 10;
let _newIssuesThisRun = 0;
let _issuesSkippedByRateLimit = 0;

async function createModerationIssue(title, body) {
  if (!GH_TOKEN || !GH_REPO) {
    warn('Aux-scan hit but GH_TOKEN/REPO unset -- skipping issue creation', { title });
    return;
  }
  if (await ghIssueExists(title)) {
    log(`Moderation review issue already open`, { title });
    return;
  }
  if (DRY_RUN) {
    log(`[DRY RUN] would open GH issue`, { title, body });
    return;
  }
  if (_newIssuesThisRun >= MAX_NEW_ISSUES_PER_RUN) {
    _issuesSkippedByRateLimit++;
    warn(`Skipping issue creation -- hit MAX_NEW_ISSUES_PER_RUN cap`, {
      cap: MAX_NEW_ISSUES_PER_RUN,
      title,
    });
    return;
  }
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      body,
      labels: ['content-moderation-review', 'security'],
    }),
  });
  if (res.ok) {
    _newIssuesThisRun++;
    const issue = await res.json();
    log(`Opened moderation review issue`, { url: issue.html_url });
  } else {
    err(`Failed to open moderation issue`, { status: res.status, body: await res.text() });
  }
}

async function checkTextAgainstAllLayers(text, rowLabel) {
  const banHit = bannedPhrasesFilter.check(text);
  if (banHit.flagged) return { layer: 'banned_phrase', term: banHit.term };
  const wordHit = wordlistFilter.check(text);
  if (wordHit.flagged) return { layer: 'wordlist', term: wordHit.term };
  if (OPENAI_KEY) {
    try {
      const result = await moderateWithOpenAI(text, rowLabel);
      if (result.flagged) return { layer: 'openai', term: result.categories.join(',') };
      // Same rate-limit spacing as the user_configs loop.
      await new Promise(r => setTimeout(r, 1050));
    } catch (e) {
      err(`OpenAI call failed for aux row ${rowLabel}`, { message: e.message });
    }
  }
  return null;
}

/**
 * Scan a single aux table (proton-configs OR systems).
 *
 * @param {object} config
 * @param {string} config.table      Postgres table name (e.g. 'user_proton_configs').
 * @param {string} config.selectCols Comma-separated column list for the REST SELECT.
 * @param {string} config.timeCol    Timestamp column to filter recent rows by.
 * @param {string} config.textCol    Column whose value is scanned.
 * @param {(row: object) => string} config.rowLabel  Human-readable row identifier for logs + issue title.
 * @returns {Promise<{scanned: number, hits: number, hitIds: string[]}>}
 */
async function scanAuxTable({ table, selectCols, timeCol, textCol, rowLabel }) {
  const since = new Date(Date.now() - LOOKBACK_H * 3600 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/${table}`
    + `?select=${selectCols}`
    + `&${timeCol}=gte.${since}`
    + `&order=${timeCol}.asc`;
  log(`Aux scan fetch`, { table, url: url.replace(SUPABASE_URL, '<SUPABASE_URL>'), since });

  const res = await fetch(url, { headers: SUPABASE_HEADERS });
  if (!res.ok) {
    err(`Aux fetch failed for ${table}`, { status: res.status, body: await res.text() });
    return { scanned: 0, hits: 0, hitIds: [] };
  }
  const rows = await res.json();
  log(`Aux rows returned`, { table, count: rows.length });

  let hits = 0;
  const hitIds = [];
  for (const row of rows) {
    const text = row[textCol];
    if (!text || typeof text !== 'string' || !text.trim()) continue;
    const label = rowLabel(row);
    const hit = await checkTextAgainstAllLayers(text, `${table}:${label}`);
    if (!hit) {
      log(`Aux row clean`, { table, label });
      continue;
    }
    hits++;
    hitIds.push(label);
    warn(`Aux row FLAGGED`, { table, label, textCol, layer: hit.layer, term: hit.term, snippet: text.slice(0, 80) });

    // De-dupe issues per (table, row) so re-scans of the same row don't
    // spam. Title includes the row identifier so distinct rows get
    // distinct issues.
    const title = `[Moderation review] ${table} row ${label} matched ${hit.layer}`;
    const body = [
      `Content moderation scanner flagged **${table}.${textCol}** for row \`${label}\`.`,
      ``,
      `- Layer: **${hit.layer}**`,
      `- Match: \`${hit.term}\``,
      `- Text (first 200 chars):`,
      '```',
      text.slice(0, 200),
      '```',
      ``,
      `This table has no moderation columns, so the scanner did not modify the row.`,
      `Review the row in Supabase and remove or rename the value if the flag is genuine.`,
      ``,
      `Triggered at ${new Date().toISOString()} by \`.github/scripts/moderate-content.mjs\`.`,
    ].join('\n');
    await createModerationIssue(title, body);
  }
  return { scanned: rows.length, hits, hitIds };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Moderation scan starting`, {
    lookbackHours: LOOKBACK_H,
    appIds: APP_IDS.length ? APP_IDS : 'all',
    dryRun: DRY_RUN,
    openai: !!OPENAI_KEY,
  });

  bannedPhrasesFilter = await buildBannedPhrasesFilter();
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

    // Layer 0: custom banned phrases (admin-managed)
    for (const { field, text } of fields) {
      const hit = bannedPhrasesFilter.check(text);
      log(`Banned phrases check`, { id: row.id, field, flagged: hit.flagged, ...(hit.term ? { term: hit.term } : {}) });
      if (hit.flagged) {
        hitReason = `banned_phrase:${hit.term} in ${field}`;
        hitLayer = 'banned_phrase';
        break;
      }
    }

    // Layer 1: wordlist
    if (!hitReason) for (const { field, text } of fields) {
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

  // Aux scans (#331, #332 + MEDIUM followups). Same layer stack + lookback
  // as the primary scan; hits open a GH issue rather than mutate the row.
  const auxResults = {};
  auxResults.user_proton_configs = await scanAuxTable({
    table: 'user_proton_configs',
    selectCols: 'voter_id,app_id,app_name,updated_at',
    timeCol: 'updated_at',
    textCol: 'app_name',
    rowLabel: (r) => `${r.voter_id}:${r.app_id}`,
  });
  auxResults.user_systems_label = await scanAuxTable({
    table: 'user_systems',
    selectCols: 'proton_pulse_user_id,device_id,label,updated_at',
    timeCol: 'updated_at',
    textCol: 'label',
    rowLabel: (r) => `${r.proton_pulse_user_id || 'anon'}:${r.device_id}`,
  });
  // MEDIUM: sysinfo_text is not rendered raw but persists verbatim and
  // is admin-visible. Slur or CSAM buried in a sysinfo paste still
  // warrants a review.
  auxResults.user_systems_sysinfo = await scanAuxTable({
    table: 'user_systems',
    selectCols: 'proton_pulse_user_id,device_id,sysinfo_text,updated_at',
    timeCol: 'updated_at',
    textCol: 'sysinfo_text',
    rowLabel: (r) => `${r.proton_pulse_user_id || 'anon'}:${r.device_id}:sysinfo`,
  });
  // MEDIUM: reason_text is the user-typed reason when flagging a report.
  // Admin-visible only, but persists and is an easy vector to abuse the
  // review UI.
  auxResults.flagged_reports_reason = await scanAuxTable({
    table: 'flagged_reports',
    selectCols: 'id,reason_text,flagged_at',
    timeCol: 'flagged_at',
    textCol: 'reason_text',
    rowLabel: (r) => `${r.id}`,
  });

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [
      `## Content moderation summary`,
      `| Table.column | Scanned | Flagged |`,
      `|---|---|---|`,
      `| user_configs (auto-remediated) | ${scanned} | ${flaggedCount} |`,
      `| user_proton_configs.app_name | ${auxResults.user_proton_configs.scanned} | ${auxResults.user_proton_configs.hits} |`,
      `| user_systems.label | ${auxResults.user_systems_label.scanned} | ${auxResults.user_systems_label.hits} |`,
      `| user_systems.sysinfo_text | ${auxResults.user_systems_sysinfo.scanned} | ${auxResults.user_systems_sysinfo.hits} |`,
      `| flagged_reports.reason_text | ${auxResults.flagged_reports_reason.scanned} | ${auxResults.flagged_reports_reason.hits} |`,
      ``,
      `Lookback: ${LOOKBACK_H}h - App ID filter: ${APP_IDS.length ? APP_IDS.join(', ') : 'all'} - Dry run: ${DRY_RUN} - Layers: wordlist${OPENAI_KEY ? ' + openai' : ' only'}`,
      `Issue cap: ${MAX_NEW_ISSUES_PER_RUN}/run - New issues opened: ${_newIssuesThisRun} - Skipped by rate limit: ${_issuesSkippedByRateLimit}`,
    ];
    if (flaggedIds.length) lines.push(`\nAuto-flagged user_configs IDs: ${flaggedIds.join(', ')}`);
    for (const [key, r] of Object.entries(auxResults)) {
      if (r.hitIds.length) lines.push(`Aux hits (${key}): ${r.hitIds.join(', ')}`);
    }
    const fs = await import('fs');
    fs.appendFileSync(summary, lines.join('\n') + '\n');
  }
}

main().catch(e => { err('Fatal error', { message: e.message, stack: e.stack }); process.exit(1); });
