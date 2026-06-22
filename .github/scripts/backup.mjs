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
 */

import { createHmac } from 'crypto';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
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
    .replace(/\/root/g, '/root');
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

async function fetchSchema(headers, date) {
  const tables = ['user_configs', 'author_avatars', 'user_proton_configs', 'user_systems', 'admins', 'banned_users'];
  const lines = [`-- Schema export ${date}\n`];
  for (const table of tables) {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?limit=0`, { headers });
    lines.push(`-- Table: ${table} (columns from API response headers)\n`);
    lines.push(`-- Content-Range: ${res.headers.get('content-range') || 'n/a'}\n\n`);
  }

  const policyQuery = `
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname;
  `;
  const queryRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: policyQuery }),
  }).catch(() => null);

  if (queryRes?.ok) {
    const policies = await queryRes.json();
    lines.push('-- RLS Policies\n');
    lines.push(JSON.stringify(policies, null, 2));
  }

  return lines.join('');
}

function makeTarball(srcDir, outPath) {
  execSync(`tar -czf "${outPath}" -C "${srcDir}" .`, { stdio: 'inherit' });
}

async function run(type, { headers, date, outDir, siteDir, secret }) {
  const workDir = join(tmpdir(), `backup-${date}-${type}`);
  mkdirSync(workDir, { recursive: true });

  console.log(`[${type}] exporting...`);

  let rowCount = null;

  if (type === 'schema') {
    const schema = await fetchSchema(headers, date);
    writeFileSync(join(workDir, `schema-${date}.sql`), schema);
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
          execSync(`cp "${src}" "${siteOut}/"`);
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
  execSync(`rm -rf "${workDir}"`);

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

  mkdirSync(outDir, { recursive: true });
  const types = type === 'all'
    ? ['schema', 'user_configs', 'author_avatars', 'site']
    : [type];

  const results = [];
  for (const t of types) {
    results.push(await run(t, { headers, date, outDir, siteDir, secret }));
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
