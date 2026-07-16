/**
 * @jest-environment node
 *
 * RLS regression suite (#318).
 *
 * Per-table boundary tests: for every user-scoped table, prove that a
 * signed-in user CANNOT reach through to another user's row via the
 * privileged paths (DELETE, UPDATE, private SELECT).
 *
 * Not every table blocks SELECT -- `user_configs` (reports) and
 * `user_proton_configs` (uploaded configs) are intentionally public
 * because the site displays them to anonymous visitors. For those tables
 * we only assert the writes are locked to the owner. Tables that hold
 * private per-user data (drafts, systems, library/wishlist caches) get
 * the full boundary check.
 *
 * Simulated via the Management API: SET LOCAL ROLE authenticated + a
 * fake JWT claims block. Same pattern supabaseSchema.test.js uses to
 * prove RLS evaluation without a real user JWT.
 *
 * Skipped without SUPABASE_TOKEN / SUPABASE_URL; required in CI.
 */

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_TOKEN = process.env.SUPABASE_TOKEN;
const PROJECT_REF    = SUPABASE_URL
  ? new URL(SUPABASE_URL).hostname.split('.')[0]
  : null;

const MGMT_QUERY_URL = PROJECT_REF
  ? `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`
  : null;

// Throwaway user UUIDs inserted into auth.users by the top-level
// beforeAll. Suffix chosen so ci-rls leftovers are easy to grep for.
const USER_A = '00000000-0000-0000-0000-0000000000aa';
const USER_B = '00000000-0000-0000-0000-0000000000bb';

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

function jwtClaims(userId) {
  return JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' });
}

async function asUser(userId, sql) {
  return queryDB(
    `SET LOCAL ROLE authenticated;
     SET LOCAL "request.jwt.claims" = '${jwtClaims(userId)}';
     ${sql}`,
  );
}

// Cleanup helper -- runs as service role (no SET LOCAL) so RLS does not
// interfere with row removal.
async function cleanup(sql) {
  return queryDB(sql);
}

const describeIfCreds = SUPABASE_TOKEN && MGMT_QUERY_URL ? describe : describe.skip;

describeIfCreds('RLS: user-scoped tables (per-user boundary)', () => {

  beforeAll(async () => {
    // Throwaway users. Several user-scoped tables FK to auth.users so
    // we need real rows there; the Management API runs as the service
    // role so a direct auth.users insert is allowed.
    await cleanup(`
      INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
      VALUES
        ('${USER_A}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'ci-rls-a@example.invalid', 'noop', now(), now()),
        ('${USER_B}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'ci-rls-b@example.invalid', 'noop', now(), now())
      ON CONFLICT (id) DO NOTHING;
    `);
  }, 30000);

  afterAll(async () => {
    // ON DELETE CASCADE on the FK columns cleans dependent rows.
    await cleanup(`
      DELETE FROM auth.users WHERE id IN ('${USER_A}', '${USER_B}');
    `);
  }, 30000);

  // ---- user_configs (public read, owner-only DELETE) --------------------

  describe('user_configs', () => {
    const seedAppId = 'ci-rls-uc';

    beforeAll(async () => {
      await cleanup(`DELETE FROM public.user_configs WHERE app_id = '${seedAppId}';`);
      await cleanup(`
        INSERT INTO public.user_configs (
          proton_pulse_user_id, app_id, title, source, client_id,
          cpu, gpu, gpu_driver, ram, os, kernel, proton_version,
          duration, rating, notes, gpu_vendor, launch_options
        )
        VALUES (
          '${USER_A}', '${seedAppId}', 'ci rls regression', 'ci', 'ci-rls-client-a',
          'ci', 'ci', 'ci', 'ci', 'ci', 'ci', 'ci',
          'ci', 'gold', '', 'other', ''
        );
      `);
    }, 30000);

    afterAll(async () => {
      await cleanup(`DELETE FROM public.user_configs WHERE app_id = '${seedAppId}';`);
    }, 30000);

    test('USER_B DELETE affects 0 rows (owner-only DELETE policy)', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_configs
        WHERE app_id = '${seedAppId}'
        RETURNING id;
      `);
      expect(rows).toHaveLength(0);
      // Verify the seed still exists via service role.
      const verify = await cleanup(`SELECT id FROM public.user_configs WHERE app_id = '${seedAppId}';`);
      expect(verify).toHaveLength(1);
    }, 30000);
  });

  // ---- user_proton_configs (public read, owner-only DELETE via UUID) ----

  describe('user_proton_configs', () => {
    const seedApp = 987654321;
    const seedVoter = 'ci-rls-upc';

    beforeAll(async () => {
      await cleanup(`
        DELETE FROM public.user_proton_configs
        WHERE voter_id = '${seedVoter}' AND app_id = ${seedApp};
      `);
      await cleanup(`
        INSERT INTO public.user_proton_configs (voter_id, proton_pulse_user_id, app_id, app_name, config)
        VALUES ('${seedVoter}', '${USER_A}', ${seedApp}, 'CI RLS', '{}'::jsonb);
      `);
    }, 30000);

    afterAll(async () => {
      await cleanup(`
        DELETE FROM public.user_proton_configs
        WHERE voter_id = '${seedVoter}' AND app_id = ${seedApp};
      `);
    }, 30000);

    test('USER_B DELETE affects 0 rows (owner-only DELETE via UUID)', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_proton_configs
        WHERE app_id = ${seedApp}
        RETURNING app_id;
      `);
      expect(rows).toHaveLength(0);
      const verify = await cleanup(`SELECT app_id FROM public.user_proton_configs WHERE app_id = ${seedApp};`);
      expect(verify).toHaveLength(1);
    }, 30000);
  });

  // ---- user_systems (fully owner-scoped) --------------------------------

  describe('user_systems', () => {
    const seedLabel = 'ci-rls-user_systems';
    const seedDevice = 'ci-rls-device';

    beforeAll(async () => {
      await cleanup(`DELETE FROM public.user_systems WHERE label = '${seedLabel}';`);
      await cleanup(`
        INSERT INTO public.user_systems (proton_pulse_user_id, device_id, label, sysinfo_text)
        VALUES ('${USER_A}', '${seedDevice}', '${seedLabel}', 'ci sysinfo');
      `);
    }, 30000);

    afterAll(async () => {
      await cleanup(`DELETE FROM public.user_systems WHERE label = '${seedLabel}';`);
    }, 30000);

    test('USER_B cannot SELECT USER_A row', async () => {
      const rows = await asUser(USER_B, `
        SELECT proton_pulse_user_id FROM public.user_systems
        WHERE label = '${seedLabel}';
      `);
      expect(rows).toHaveLength(0);
    }, 30000);

    test('USER_B DELETE affects 0 rows', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_systems
        WHERE label = '${seedLabel}'
        RETURNING proton_pulse_user_id;
      `);
      expect(rows).toHaveLength(0);
    }, 30000);
  });

  // ---- user_report_drafts (fully owner-scoped) --------------------------

  describe('user_report_drafts', () => {
    const seedApp = 'ci-rls-drafts';

    beforeAll(async () => {
      await cleanup(`
        DELETE FROM public.user_report_drafts
        WHERE user_id = '${USER_A}' AND app_id = '${seedApp}';
      `);
      await cleanup(`
        INSERT INTO public.user_report_drafts (user_id, app_id, form_data)
        VALUES ('${USER_A}', '${seedApp}', '{"note":"ci"}'::jsonb);
      `);
    }, 30000);

    afterAll(async () => {
      await cleanup(`
        DELETE FROM public.user_report_drafts
        WHERE user_id = '${USER_A}' AND app_id = '${seedApp}';
      `);
    }, 30000);

    test('USER_B cannot SELECT USER_A row', async () => {
      const rows = await asUser(USER_B, `
        SELECT user_id FROM public.user_report_drafts
        WHERE app_id = '${seedApp}';
      `);
      expect(rows).toHaveLength(0);
    }, 30000);

    test('USER_B UPDATE affects 0 rows', async () => {
      const rows = await asUser(USER_B, `
        UPDATE public.user_report_drafts SET form_data = '{"note":"pwn"}'::jsonb
        WHERE app_id = '${seedApp}'
        RETURNING user_id;
      `);
      expect(rows).toHaveLength(0);
    }, 30000);

    test('USER_B DELETE affects 0 rows', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_report_drafts
        WHERE app_id = '${seedApp}'
        RETURNING user_id;
      `);
      expect(rows).toHaveLength(0);
    }, 30000);
  });

  // ---- user_steam_library / user_steam_wishlist (SELECT owner-only) -----

  describe('user_steam_library', () => {
    beforeAll(async () => {
      await cleanup(`DELETE FROM public.user_steam_library WHERE user_id = '${USER_A}';`);
      await cleanup(`
        INSERT INTO public.user_steam_library (user_id, steam_id, game_count, appids)
        VALUES ('${USER_A}', '76561000000000000', 3, '[1,2,3]'::jsonb);
      `);
    }, 30000);

    afterAll(async () => {
      await cleanup(`DELETE FROM public.user_steam_library WHERE user_id = '${USER_A}';`);
    }, 30000);

    test('USER_B cannot SELECT USER_A row', async () => {
      const rows = await asUser(USER_B, `
        SELECT user_id FROM public.user_steam_library
        WHERE user_id = '${USER_A}';
      `);
      expect(rows).toHaveLength(0);
    }, 30000);
  });

  describe('user_steam_wishlist', () => {
    beforeAll(async () => {
      await cleanup(`DELETE FROM public.user_steam_wishlist WHERE user_id = '${USER_A}';`);
      await cleanup(`
        INSERT INTO public.user_steam_wishlist (user_id, steam_id, item_count, appids)
        VALUES ('${USER_A}', '76561000000000000', 3, ARRAY[10,20,30]);
      `);
    }, 30000);

    afterAll(async () => {
      await cleanup(`DELETE FROM public.user_steam_wishlist WHERE user_id = '${USER_A}';`);
    }, 30000);

    test('USER_B cannot SELECT USER_A row', async () => {
      const rows = await asUser(USER_B, `
        SELECT user_id FROM public.user_steam_wishlist
        WHERE user_id = '${USER_A}';
      `);
      expect(rows).toHaveLength(0);
    }, 30000);

    test('USER_B DELETE affects 0 rows', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_steam_wishlist
        WHERE user_id = '${USER_A}'
        RETURNING user_id;
      `);
      expect(rows).toHaveLength(0);
    }, 30000);
  });
});
