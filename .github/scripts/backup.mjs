#!/usr/bin/env node
/**
 * Pulls sanitized data from Supabase, writes dated tar.gz archives.
 *
 * Required env vars:
 *   SUPABASE_URL              - project URL
 *   SUPABASE_SERVICE_ROLE_KEY - bypasses RLS
 *   BACKUP_HMAC_SECRET        - consistent pseudonymization key
 *   BACKUP_DATE               - YYYY-MM-DD (set by workflow)
 *   BACKUP_TYPE               - schema | user_configs | author_avatars | site | all
 *   SITE_DIR                  - path to checked-out gh-pages files (for site type)
 *   OUT_DIR                   - directory to write .tar.gz files into
 *
 * Optional env vars:
 *   MIGRATIONS_DIR            - DDL source bundled into the schema archive
 *                               (default: supabase/migrations)
 */

import { createHmac } from 'crypto';
import { execSync } from 'child_process'; // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process — Trusted CI script; commands from hardcoded constants, not user input
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export const MANIFEST_FILE = 'backup-manifest.json';

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

// Tables that don't have an `id` column and need a different order key.
export const TABLE_ORDER_KEY = { author_avatars: 'proton_pulse_user_id' };

export function buildFetchUrl(baseUrl, table, select, extraFilter, offset, limit) {
  const orderKey = TABLE_ORDER_KEY[table] || 'id';
  return `${baseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}${extraFilter}&limit=${limit}&offset=${offset}&order=${orderKey}.asc`;
}

export function hmac(value, secret) {
  if (!value) return null;
  return createHmac('sha256', secret).update(String(value)).digest('hex');
}

// Strip common PII patterns from free-text fields (email, URLs, file paths, Steam IDs).
export function sanitizeNotes(str) {
  if (!str) return str;
  return str
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url redacted]')
    .replace(/\b7656119\d{10}\b/g, '[steamid redacted]')
    .replace(/\/home\/[^/\s]+/g, '/home/[redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]')
    .replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[redacted]');
}

// Redact anything that looks like an absolute file path to avoid leaking OS usernames.
export function redactPaths(str) {
  if (!str) return str;
  return str
    .replace(/\/home\/[^/\s]+/g, '/home/[redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]')
    .replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[redacted]')
    .replace(/\/root(?=\/|\s|$)/g, '/[redacted]');
}

export function sanitizeUserConfig(row, secret) {
  return {
    id: row.id,
    app_id: row.app_id,
    title: row.title,
    rating: row.rating,
    proton_version: row.proton_version,
    launch_options: redactPaths(row.launch_options),
    cpu: row.cpu,
    gpu: row.gpu,
    gpu_driver: row.gpu_driver,
    gpu_vendor: row.gpu_vendor,
    ram: row.ram,
    vram_mb: row.vram_mb,
    os: row.os,
    kernel: row.kernel,
    notes: sanitizeNotes(row.notes),
    form_responses: row.form_responses,
    duration: row.duration,
    duration_minutes: row.duration_minutes,
    game_owned: row.game_owned,
    config_key: row.config_key,
    source: row.source,
    is_flagged: row.is_flagged,
    is_hidden: row.is_hidden,
    // category only, no matched term
    flagged_reason: row.flagged_reason
      ? row.flagged_reason.replace(/^(wordlist|openai|admin):.*$/, '$1:redacted')
      : null,
    flagged_at: row.flagged_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // pseudonymized
    proton_pulse_user_id: hmac(row.proton_pulse_user_id, secret),
    client_id: hmac(row.client_id, secret),
  };
}

export function sanitizeAuthorAvatar(row, secret) {
  return {
    proton_pulse_user_id: hmac(row.proton_pulse_user_id, secret),
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    cached_at: row.cached_at,
    // steam_id excluded - directly linkable PII
  };
}

/**
 * Flatten a PostgREST OpenAPI document into per-table column definitions.
 *
 * PostgREST describes each exposed table under `definitions` (Swagger 2) or
 * `components.schemas` (OpenAPI 3), with a `properties` map carrying the
 * column type, format (the underlying Postgres type) and a description that
 * holds the PK/FK notes. That is everything the REST layer can tell us about
 * structure -- pg_catalog is not reachable over REST, so RLS policies,
 * triggers and functions do NOT appear here and come from the migrations.
 */
export function summarizeOpenApiSchema(spec) {
  const defs = spec?.definitions || spec?.components?.schemas || {};
  return Object.entries(defs)
    .map(([table, def]) => ({
      table,
      required: def?.required || [],
      columns: Object.entries(def?.properties || {}).map(([name, meta]) => ({
        name,
        type: meta?.type ?? null,
        // `format` is the Postgres type (e.g. "timestamp with time zone"),
        // which is what a restore actually needs -- `type` is only the JSON
        // supertype and would collapse int/bigint/numeric into "number".
        format: meta?.format ?? null,
        description: meta?.description ?? null,
      })),
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** Render the introspected tables as readable SQL-ish reference text. */
export function renderSchemaReference(tables, date) {
  const lines = [
    `-- Schema reference ${date}`,
    '-- Generated from the PostgREST OpenAPI document (live introspection).',
    '-- This is a REFERENCE, not restorable DDL. The restorable definition is',
    '-- the migrations/ directory in this archive, replayed in filename order.',
    '-- RLS policies, triggers and functions are not visible to introspection',
    '-- and exist only in those migration files.',
    '',
  ];
  for (const t of tables) {
    lines.push(`-- Table: ${t.table} (${t.columns.length} columns)`);
    for (const c of t.columns) {
      const req = t.required.includes(c.name) ? ' NOT NULL' : '';
      lines.push(`--   ${c.name} ${c.format || c.type || 'unknown'}${req}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// I/O (not exported; depends on env + network)
// ---------------------------------------------------------------------------

async function fetchAll(table, select = '*', extraFilter = '', headers) {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const url = buildFetchUrl(process.env.SUPABASE_URL, table, select, extraFilter, offset, limit);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Fetch ${table} failed: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return rows;
}

async function fetchSchema(headers, date, migrationsDir) {
  // Live introspection. PostgREST serves an OpenAPI document at the API root
  // describing every exposed table and column with its type -- this is the
  // only structural view the service-role key can reach, since pg_catalog is
  // not exposed over REST. Requires the secret key; the publishable key gets
  // "Only secret API keys can be used for this endpoint".
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
    headers: { ...headers, Accept: 'application/openapi+json' },
  });
  if (!res.ok) {
    throw new Error(`Schema introspection failed: ${res.status} ${await res.text()}`);
  }
  const spec = await res.json();
  const tables = summarizeOpenApiSchema(spec);
  // An empty result means the endpoint answered but told us nothing, which is
  // what the previous implementation shipped for months. Treat it as failure.
  if (!tables.length) {
    throw new Error('Schema introspection returned no tables -- refusing to write an empty schema backup');
  }

  // The DDL itself. Migrations are the authoritative definition of the schema
  // (tables, RLS policies, triggers, functions) and replaying them in filename
  // order reconstructs the database. Introspection cannot see any of that, so
  // without these the backup is structurally useless.
  const migrations = readMigrations(migrationsDir);
  if (!migrations.length) {
    throw new Error(`No migrations found in ${migrationsDir} -- refusing to write a schema backup with no DDL`);
  }

  return { spec, tables, migrations };
}

// Read the migration files that define the schema. Sorted by filename, which
// is the timestamp-prefixed order they must be replayed in.
function readMigrations(dir) {
  let names;
  try {
    names = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  } catch (err) {
    throw new Error(`Cannot read migrations from ${dir}: ${err.message}`);
  }
  return names.map(name => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

function makeTarball(srcDir, outPath) {
  execSync(`tar -czf "${outPath}" -C "${srcDir}" .`, { stdio: 'inherit' }); // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process — Trusted CI script; commands from hardcoded constants, not user input
}

async function run(type, { headers, date, outDir, siteDir, secret, migrationsDir }) {
  const workDir = join(tmpdir(), `backup-${date}-${type}`);
  mkdirSync(workDir, { recursive: true });

  console.log(`[${type}] exporting...`);

  let rowCount = null;

  if (type === 'schema') {
    const { spec, tables, migrations } = await fetchSchema(headers, date, migrationsDir);

    // Restorable DDL: the migrations, replayed in filename order. This is the
    // part that actually rebuilds the database, RLS and triggers included.
    const migDir = join(workDir, 'migrations');
    mkdirSync(migDir, { recursive: true });
    for (const m of migrations) writeFileSync(join(migDir, m.name), m.sql);

    // Live introspection, kept alongside so a restore can be diffed against
    // what prod actually had. Catches drift where the live schema and the
    // migration history disagree.
    writeFileSync(join(workDir, `schema-${date}.json`), JSON.stringify({ tables, openapi: spec }, null, 2));
    writeFileSync(join(workDir, `schema-${date}.sql`), renderSchemaReference(tables, date));

    rowCount = tables.length;
    console.log(`[schema] introspected ${tables.length} tables, bundled ${migrations.length} migrations`);
  }

  if (type === 'user_configs') {
    const rows = await fetchAll('user_configs', '*', '&is_hidden=eq.false', headers);
    const sanitized = rows.map(r => sanitizeUserConfig(r, secret));
    writeFileSync(join(workDir, `user_configs-${date}.json`), JSON.stringify(sanitized, null, 2));
    rowCount = sanitized.length;
    console.log(`[user_configs] exported ${sanitized.length} rows`);
  }

  if (type === 'author_avatars') {
    const rows = await fetchAll('author_avatars', 'proton_pulse_user_id,display_name,avatar_url,cached_at', '', headers);
    const sanitized = rows.map(r => sanitizeAuthorAvatar(r, secret));
    writeFileSync(join(workDir, `author_avatars-${date}.json`), JSON.stringify(sanitized, null, 2));
    rowCount = sanitized.length;
    console.log(`[author_avatars] exported ${sanitized.length} rows`);
  }

  if (type === 'site') {
    if (!siteDir) throw new Error('SITE_DIR is required for site backup');
    const siteOut = join(workDir, 'site');
    mkdirSync(siteOut, { recursive: true });
    const allowed = ['.html', '.js', '.css', '.svg', '.png', '.ico'];
    let fileCount = 0;
    for (const f of readdirSync(siteDir)) {
      if (allowed.some(ext => f.endsWith(ext))) {
        const src = join(siteDir, f);
        if (statSync(src).isFile()) {
          execSync(`cp "${src}" "${siteOut}/"`); // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process — Trusted CI script; commands from hardcoded constants, not user input
          fileCount++;
        }
      }
    }
    rowCount = fileCount;
  }

  const outPath = join(outDir, `backup-${date}-${type}.tar.gz`);
  makeTarball(workDir, outPath);
  const sizeBytes = statSync(outPath).size;
  console.log(`[${type}] wrote ${outPath} (${sizeBytes} bytes)`);
  execSync(`rm -rf "${workDir}"`); // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process — Trusted CI script; commands from hardcoded constants, not user input

  return { type, file: `backup-${date}-${type}.tar.gz`, size_bytes: sizeBytes, row_count: rowCount };
}

async function main() {
  const secret = process.env.BACKUP_HMAC_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret) {
    console.error('FATAL: BACKUP_HMAC_SECRET is not set. Refusing to run without a pseudonymization key.');
    process.exit(1);
  }
  if (!supabaseUrl || !supabaseKey) {
    console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.');
    process.exit(1);
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };
  const date = process.env.BACKUP_DATE;
  const outDir = process.env.OUT_DIR || '.';
  const siteDir = process.env.SITE_DIR || '';
  const type = process.env.BACKUP_TYPE || 'all';
  // Migrations are the authoritative DDL and ship inside the schema archive.
  const migrationsDir = process.env.MIGRATIONS_DIR || 'supabase/migrations';

  mkdirSync(outDir, { recursive: true });
  const types = type === 'all'
    ? ['schema', 'user_configs', 'author_avatars', 'site']
    : [type];

  const results = [];
  for (const t of types) {
    results.push(await run(t, { headers, date, outDir, siteDir, secret, migrationsDir }));
  }

  // Write manifest for the workflow to append to backups.jsonl
  const manifest = {
    ts: new Date().toISOString(),
    date,
    files: results.map(r => ({ name: r.file, size_bytes: r.size_bytes, row_count: r.row_count })),
  };
  writeFileSync(join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[manifest] written to ${join(outDir, MANIFEST_FILE)}`);
}

// Only run as CLI entry point, not when imported by tests.
if (process.argv[1]?.endsWith('backup.mjs')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
