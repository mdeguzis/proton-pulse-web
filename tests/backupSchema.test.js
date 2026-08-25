/**
 * Schema backup must contain a schema.
 *
 * The previous fetchSchema shipped a 523-byte file of comments and nothing
 * else, in every backup release, for months (#495). Two silent failures:
 *
 *  - it read column definitions out of a `content-range` response header,
 *    which does not carry them, so every table recorded an empty range
 *  - it fetched RLS policies from /rest/v1/rpc/query, an RPC that does not
 *    exist (PGRST202). The call was `.catch(() => null)` and the write was
 *    gated on `res?.ok`, so the 404 was swallowed and the section omitted
 *
 * The workflow went green and the release asset looked right. These tests pin
 * the two properties that were missing: real structure, and loud failure.
 */

const {
  summarizeOpenApiSchema,
  renderSchemaReference,
} = require('../.github/scripts/backup.mjs');

const SPEC = {
  definitions: {
    user_configs: {
      required: ['id', 'app_id'],
      properties: {
        id: { type: 'integer', format: 'bigint', description: 'Note: PK' },
        app_id: { type: 'string', format: 'text' },
        created_at: { type: 'string', format: 'timestamp with time zone' },
      },
    },
    admins: {
      required: [],
      properties: { proton_pulse_user_id: { type: 'string', format: 'uuid' } },
    },
  },
};

describe('summarizeOpenApiSchema', () => {
  test('extracts every table with its columns', () => {
    const out = summarizeOpenApiSchema(SPEC);
    expect(out.map(t => t.table)).toEqual(['admins', 'user_configs']); // sorted
    const uc = out.find(t => t.table === 'user_configs');
    expect(uc.columns.map(c => c.name)).toEqual(['id', 'app_id', 'created_at']);
    expect(uc.required).toEqual(['id', 'app_id']);
  });

  test('keeps the Postgres type, not just the JSON supertype', () => {
    // `type` collapses bigint/int/numeric to "integer"/"number"; a restore
    // needs `format`, which carries the real column type.
    const uc = summarizeOpenApiSchema(SPEC).find(t => t.table === 'user_configs');
    expect(uc.columns.find(c => c.name === 'id').format).toBe('bigint');
    expect(uc.columns.find(c => c.name === 'created_at').format).toBe('timestamp with time zone');
  });

  test('reads OpenAPI 3 components.schemas as well as Swagger 2 definitions', () => {
    const v3 = { components: { schemas: SPEC.definitions } };
    expect(summarizeOpenApiSchema(v3).map(t => t.table)).toEqual(['admins', 'user_configs']);
  });

  test('returns empty for a response carrying no schema at all', () => {
    // This is the shape the old code silently accepted: the endpoint answers,
    // but says nothing. fetchSchema now throws on this rather than writing it.
    expect(summarizeOpenApiSchema({ message: 'Secret API key required' })).toEqual([]);
    expect(summarizeOpenApiSchema(null)).toEqual([]);
  });
});

describe('renderSchemaReference', () => {
  const out = renderSchemaReference(summarizeOpenApiSchema(SPEC), '2026-08-24');

  test('lists real columns and types, not content-range placeholders', () => {
    expect(out).toContain('id bigint NOT NULL');
    expect(out).toContain('created_at timestamp with time zone');
    expect(out).not.toContain('Content-Range');
    expect(out).not.toContain('columns from API response headers');
  });

  test('says plainly that it is not the restorable artifact', () => {
    // The old file read like a schema dump while being nothing of the sort.
    // Whatever replaces it must not invite the same misreading.
    expect(out).toMatch(/not restorable DDL/i);
    expect(out).toMatch(/migrations/i);
  });
});

describe('the failure modes that made #495 invisible', () => {
  const SRC = require('fs').readFileSync(
    require.resolve('../.github/scripts/backup.mjs'), 'utf8');

  test('no longer calls the nonexistent rpc/query endpoint', () => {
    expect(SRC).not.toContain('rpc/query');
  });

  test('does not derive columns from response headers', () => {
    expect(SRC).not.toContain('content-range');
    expect(SRC).not.toContain('columns from API response headers');
  });

  test('schema failures throw instead of being swallowed', () => {
    // The specific construct that hid the 404: a catch returning null feeding
    // an optional-chained ok check.
    expect(SRC).not.toMatch(/\.catch\(\(\)\s*=>\s*null\)/);
    expect(SRC).toMatch(/throw new Error\(`Schema introspection failed/);
    expect(SRC).toMatch(/refusing to write an empty schema backup/);
    expect(SRC).toMatch(/refusing to write a schema backup with no DDL/);
  });

  test('the schema archive bundles the migrations that hold RLS and triggers', () => {
    expect(SRC).toMatch(/mkdirSync\(migDir/);
    expect(SRC).toMatch(/readMigrations/);
  });
});
