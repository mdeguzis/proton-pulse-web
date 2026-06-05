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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HMAC_SECRET  = process.env.BACKUP_HMAC_SECRET;
const DATE         = process.env.BACKUP_DATE;
const TYPE         = process.env.BACKUP_TYPE || 'all';
const SITE_DIR     = process.env.SITE_DIR || '';
const OUT_DIR      = process.env.OUT_DIR || '.';

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

function hmac(value) {
  if (!value) return null;
  return createHmac('sha256', HMAC_SECRET).update(String(value)).digest('hex');
}

async function fetchAll(table, select = '*') {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=${limit}&offset=${offset}&order=id.asc`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Fetch ${table} failed: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return rows;
}

async function fetchSchema() {
  const tables = ['user_configs', 'author_avatars', 'user_proton_configs', 'user_systems', 'admins', 'banned_users'];
  const lines = [`-- Schema export ${DATE}\n`];
  for (const table of tables) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?limit=0`, { headers: HEADERS });
    lines.push(`-- Table: ${table} (columns from API response headers)\n`);
    lines.push(`-- Content-Range: ${res.headers.get('content-range') || 'n/a'}\n\n`);
  }

  // Fetch RLS policies via management API (requires service role introspection).
  const policyQuery = `
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname;
  `;
  const queryRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/query`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query: policyQuery }),
  }).catch(() => null);

  if (queryRes?.ok) {
    const policies = await queryRes.json();
    lines.push('-- RLS Policies\n');
    lines.push(JSON.stringify(policies, null, 2));
  }

  return lines.join('');
}

function sanitizeUserConfig(row) {
  return {
    id: row.id,
    app_id: row.app_id,
    title: row.title,
    rating: row.rating,
    proton_version: row.proton_version,
    launch_options: row.launch_options,
    cpu: row.cpu,
    gpu: row.gpu,
    gpu_driver: row.gpu_driver,
    gpu_vendor: row.gpu_vendor,
    ram: row.ram,
    vram_mb: row.vram_mb,
    os: row.os,
    kernel: row.kernel,
    notes: row.notes,
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
    proton_pulse_user_id: hmac(row.proton_pulse_user_id),
    client_id: hmac(row.client_id),
  };
}

function sanitizeAuthorAvatar(row) {
  return {
    proton_pulse_user_id: hmac(row.proton_pulse_user_id),
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    cached_at: row.cached_at,
    // steam_id excluded - directly linkable PII
  };
}

function makeTarball(srcDir, outPath) {
  execSync(`tar -czf "${outPath}" -C "${srcDir}" .`, { stdio: 'inherit' });
}

async function run(type) {
  const workDir = join(tmpdir(), `backup-${DATE}-${type}`);
  mkdirSync(workDir, { recursive: true });

  console.log(`[${type}] exporting...`);

  if (type === 'schema') {
    const schema = await fetchSchema();
    writeFileSync(join(workDir, `schema-${DATE}.sql`), schema);
  }

  if (type === 'user_configs') {
    const rows = await fetchAll('user_configs');
    const sanitized = rows.map(sanitizeUserConfig);
    writeFileSync(join(workDir, `user_configs-${DATE}.json`), JSON.stringify(sanitized, null, 2));
    console.log(`[user_configs] exported ${sanitized.length} rows`);
  }

  if (type === 'author_avatars') {
    const rows = await fetchAll('author_avatars', 'proton_pulse_user_id,display_name,avatar_url,cached_at');
    const sanitized = rows.map(sanitizeAuthorAvatar);
    writeFileSync(join(workDir, `author_avatars-${DATE}.json`), JSON.stringify(sanitized, null, 2));
    console.log(`[author_avatars] exported ${sanitized.length} rows`);
  }

  if (type === 'site') {
    if (!SITE_DIR) throw new Error('SITE_DIR is required for site backup');
    const siteOut = join(workDir, 'site');
    mkdirSync(siteOut, { recursive: true });
    const allowed = ['.html', '.js', '.css', '.svg', '.png', '.ico'];
    for (const f of readdirSync(SITE_DIR)) {
      if (allowed.some(ext => f.endsWith(ext))) {
        const src = join(SITE_DIR, f);
        if (statSync(src).isFile()) {
          execSync(`cp "${src}" "${siteOut}/"`);
        }
      }
    }
  }

  const outPath = join(OUT_DIR, `backup-${DATE}-${type}.tar.gz`);
  makeTarball(workDir, outPath);
  console.log(`[${type}] wrote ${outPath}`);
  execSync(`rm -rf "${workDir}"`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const types = TYPE === 'all'
    ? ['schema', 'user_configs', 'author_avatars', 'site']
    : [TYPE];

  for (const t of types) {
    await run(t);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
