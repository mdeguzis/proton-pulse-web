/**
 * @jest-environment node
 *
 * Supabase schema/RLS integration tests.
 *
 * Runs in the node environment (not jsdom) because it makes live HTTPS calls
 * to the Supabase Management API and needs Node's global `fetch`; jsdom does
 * not provide one. There is no DOM in this suite.
 *
 * These tests require SUPABASE_TOKEN (Supabase personal access token) and
 * SUPABASE_URL to be set. In CI they are injected as secrets. Locally they
 * are sourced from ~/.supabase. Tests are skipped automatically when the
 * credentials are absent (e.g. forked PRs).
 *
 * What we protect against
 * -----------------------
 * SELECT policies on public-facing tables must NOT contain cross-table
 * subqueries (EXISTS / IN / FROM <other_table>). When they do, PostgreSQL
 * evaluates nested RLS chains at query time. For authenticated users this
 * produces HTTP 500; anon users are unaffected because auth.uid() is null,
 * allowing the engine to short-circuit early.
 *
 * This pattern burned us: "hide banned user configs" and "admins read all
 * configs" on user_configs triggered a 3-level chain
 * (user_configs -> banned_users -> admins -> admins self-ref) that errored
 * for every signed-in user trying to load their reports.
 */

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_TOKEN = process.env.SUPABASE_TOKEN;
const PROJECT_REF    = SUPABASE_URL
  ? new URL(SUPABASE_URL).hostname.split('.')[0]
  : null;

const MGMT_QUERY_URL = PROJECT_REF
  ? `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`
  : null;

const ANON_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';

// User-facing tables: queried by authenticated regular users via the profile + app pages.
// Their SELECT/ALL policies must not contain cross-table subqueries because nested
// RLS chains cause HTTP 500 for authenticated users (anon bypasses via null auth.uid()).
//
// Admin-only tables (admins, banned_users, banned_phrases) are excluded: they are
// only accessed by admins or the service role, so cross-table admin checks in their
// policies are acceptable.
const USER_FACING_TABLES = [
  'user_configs',
  'user_proton_configs',
  'user_systems',
];

async function queryDB(sql, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(MGMT_QUERY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    if (res.ok) return res.json();
    const body = await res.text();
    if (res.status >= 500 && attempt < retries) {
      await new Promise(r => setTimeout(r, 3000 * attempt));
      continue;
    }
    throw new Error(`Management API error: ${res.status} ${body}`);
  }
}

const describeIfCreds = SUPABASE_TOKEN && MGMT_QUERY_URL ? describe : describe.skip;

describeIfCreds('Supabase RLS policy linter', () => {
  let policies;

  beforeAll(async () => {
    const tableList = USER_FACING_TABLES.map(t => `'${t}'`).join(',');
    policies = await queryDB(`
      SELECT tablename, policyname, cmd, qual
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN (${tableList})
        AND cmd IN ('SELECT', 'ALL')
        AND qual IS NOT NULL
      ORDER BY tablename, policyname
    `);
  }, 15000);

  test('SELECT/ALL policies on user-facing tables contain no cross-table subqueries', () => {
    // Detect FROM <other_table> in policy qual. Self-references (same table) are
    // allowed because PostgreSQL handles self-referential RLS via a recursion guard.
    const violations = policies.filter(p => {
      const fromMatches = [...p.qual.matchAll(/\bFROM\s+(?:public\s*\.\s*)?(\w+)/gi)];
      return fromMatches.some(m => m[1].toLowerCase() !== p.tablename.toLowerCase());
    });
    if (violations.length > 0) {
      const detail = violations
        .map(p => `  [${p.tablename}] "${p.policyname}": ${p.qual}`)
        .join('\n');
      throw new Error(
        `${violations.length} SELECT/ALL polic${violations.length === 1 ? 'y' : 'ies'} ` +
        `contain cross-table subqueries (causes HTTP 500 for authenticated users):\n${detail}\n\n` +
        `Fix: use a SECURITY DEFINER function or a trigger instead of a subquery in the policy.`
      );
    }
  });
});

describeIfCreds('Supabase admin table RLS smoke', () => {
  // The admins table previously caused PostgreSQL 42P17 (infinite recursion) for
  // authenticated users due to a self-referential SELECT policy. These tests verify
  // that SECURITY DEFINER functions broke the cycle and all admin tables are queryable.

  const FAKE_JWT = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","aud":"authenticated"}';

  async function queryAsAuth(sql) {
    return queryDB(
      `SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claims" = '${FAKE_JWT}'; ${sql}`
    );
  }

  test('admins SELECT returns results without error for authenticated user', async () => {
    const rows = await queryAsAuth('SELECT proton_pulse_user_id FROM public.admins LIMIT 1;');
    expect(Array.isArray(rows)).toBe(true);
  }, 30000);

  test('is_current_user_admin() is callable and returns a boolean', async () => {
    const rows = await queryAsAuth('SELECT public.is_current_user_admin() AS result;');
    expect(Array.isArray(rows)).toBe(true);
    expect(typeof rows[0].result).toBe('boolean');
  }, 30000);

  test('is_current_user_super_admin() is callable and returns a boolean', async () => {
    const rows = await queryAsAuth('SELECT public.is_current_user_super_admin() AS result;');
    expect(Array.isArray(rows)).toBe(true);
    expect(typeof rows[0].result).toBe('boolean');
  }, 30000);

  test('banned_users has no_self_ban CHECK constraint', async () => {
    const rows = await queryDB(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.banned_users'::regclass
        AND contype = 'c'
        AND conname = 'no_self_ban';
    `);
    expect(rows).toHaveLength(1);
  }, 30000);

  test('self-ban insert is rejected by no_self_ban constraint', async () => {
    // proton_pulse_user_id = banned_by violates the constraint.
    await expect(queryDB(`
      INSERT INTO public.banned_users (proton_pulse_user_id, banned_by, steam_username)
      VALUES (
        '00000000-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000099',
        'ci-self-ban-test'
      );
    `)).rejects.toThrow(/no_self_ban/);
  }, 30000);
});

describeIfCreds('Supabase live endpoint smoke', () => {
  // Verify the queries the profile page makes return 200 for anon and authenticated users.
  // For authenticated we simulate via a Management API transaction that sets
  // request.jwt.claims and role before running the SELECT.

  const headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
    'Content-Type': 'application/json',
  };

  test('user_configs SELECT returns 200 for anon', async () => {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_configs` +
      `?or=(proton_pulse_user_id.eq.00000000-0000-0000-0000-000000000001,client_id.eq.test-ci)` +
      `&select=id,app_id,is_flagged,is_hidden,flagged_reason&order=created_at.desc&limit=1`,
      { headers },
    );
    expect(res.status).toBe(200);
  }, 30000);

  test('user_proton_configs SELECT returns 200 for anon', async () => {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_proton_configs` +
      `?proton_pulse_user_id=eq.00000000-0000-0000-0000-000000000001` +
      `&select=app_id,app_name,updated_at,config,is_published&order=updated_at.desc&limit=1`,
      { headers },
    );
    expect(res.status).toBe(200);
  }, 30000);

  test('user_configs SELECT returns 200 for authenticated user (simulated via DB)', async () => {
    // Run the SELECT as the `authenticated` role with fake-but-valid-format JWT
    // claims to trigger full RLS evaluation without needing a real user JWT.
    const rows = await queryDB(`
      SET LOCAL ROLE authenticated;
      SET LOCAL "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","aud":"authenticated"}';
      SELECT id FROM public.user_configs LIMIT 1;
    `);
    // If RLS evaluation errored, queryDB would have thrown. Reaching here means 200.
    expect(Array.isArray(rows)).toBe(true);
  }, 30000);

  test('user_proton_configs SELECT returns 200 for authenticated user (simulated via DB)', async () => {
    const rows = await queryDB(`
      SET LOCAL ROLE authenticated;
      SET LOCAL "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","aud":"authenticated"}';
      SELECT app_id FROM public.user_proton_configs LIMIT 1;
    `);
    expect(Array.isArray(rows)).toBe(true);
  }, 30000);
});
