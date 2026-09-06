/**
 * #257: per-row moderation cursor so rows outside every scheduled lookback
 * window are never permanently skipped.
 *
 * Contract pins (same style as moderationVtUrls.test.js) since the .mjs
 * exits early without live Supabase env vars -- these keep the query and
 * write-back wiring honest without needing a live network call.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, '.github/scripts/moderate-content.mjs'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260905000000_add_user_configs_moderation_cursor.sql'),
  'utf8'
);

describe('moderation cursor (#257)', () => {
  test('migration adds a nullable last_moderated_at column', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS last_moderated_at timestamptz/);
  });

  test('migration indexes the NULL (never-scanned) case', () => {
    expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_user_configs_last_moderated_at/);
    expect(MIGRATION).toMatch(/WHERE last_moderated_at IS NULL/);
  });

  test('fetchRecentRows also selects rows that have never been scanned, regardless of age', () => {
    expect(SRC).toMatch(/or=\(created_at\.gte\.\$\{since\},updated_at\.gte\.\$\{since\},last_moderated_at\.is\.null\)/);
  });

  test('flagRow stamps the cursor when auto-remediating a hit', () => {
    expect(SRC).toMatch(/flagged_at:\s*new Date\(\)\.toISOString\(\),\s*\n\s*last_moderated_at:\s*new Date\(\)\.toISOString\(\),/);
  });

  test('markScanned exists, is DRY_RUN gated, and only writes the cursor column', () => {
    expect(SRC).toMatch(/async function markScanned\(id\)/);
    expect(SRC).toMatch(/would mark row scanned/);
    expect(SRC).toMatch(/body: JSON\.stringify\(\{ last_moderated_at: new Date\(\)\.toISOString\(\) \}\)/);
  });

  test('markScanned raises on a failed PATCH rather than swallowing it', () => {
    const fnBody = SRC.slice(SRC.indexOf('async function markScanned'), SRC.indexOf('// ---', SRC.indexOf('async function markScanned')));
    expect(fnBody).toMatch(/if \(!res\.ok\) throw new Error/);
  });

  test('the main loop marks both the empty-fields branch and the clean branch as scanned', () => {
    const noFieldsBranch = SRC.slice(SRC.indexOf('no text fields, skipping'), SRC.indexOf('no text fields, skipping') + 200);
    expect(noFieldsBranch).toMatch(/await markScanned\(row\.id\)/);

    const cleanBranch = SRC.slice(SRC.indexOf('Row ${row.id}: clean.`'), SRC.indexOf('Row ${row.id}: clean.`') + 100);
    expect(cleanBranch).toMatch(/await markScanned\(row\.id\)/);
  });
});
