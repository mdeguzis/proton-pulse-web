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

// Every fixture key is unique to this run (#543). The suite runs against
// the live project, and when several CI runs overlap, fixed ids let one
// run's cleanup delete another run's users and seed rows mid-test. That
// showed up as FK violations on whichever table was running at the time.
// The users and seed keys below are what each run creates and cleans up;
// emails keep a ci-rls- prefix so leftovers from crashed runs are easy to
// find and are swept by the top-level beforeAll.
const RUN_ID = globalThis.crypto.randomUUID().slice(0, 8);
const USER_A = globalThis.crypto.randomUUID();
const USER_B = globalThis.crypto.randomUUID();
const seedKey = (name) => `ci-rls-${name}-${RUN_ID}`;

// 5xx and 429 are retried. 429 is the Management API's rate limiter, which
// overlapping CI runs trip easily since each run makes ~40 queries (#543).
async function queryDB(sql, retries = 5) {
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
    const transient = res.status >= 500 || res.status === 429;
    if (transient && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 3000 * attempt;
      await new Promise(r => setTimeout(r, waitMs));
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
    // Sweep users left behind by runs that crashed before afterAll. The
    // one-hour cutoff keeps this from touching a run that is still going.
    await cleanup(`
      DELETE FROM auth.users
      WHERE email LIKE 'ci-rls-%@example.invalid'
        AND created_at < now() - interval '1 hour';
    `);
    await cleanup(`
      INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
      VALUES
        ('${USER_A}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'ci-rls-a-${RUN_ID}@example.invalid', 'noop', now(), now()),
        ('${USER_B}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'ci-rls-b-${RUN_ID}@example.invalid', 'noop', now(), now())
      ON CONFLICT (id) DO NOTHING;
    `);
  }, 90000);

  afterAll(async () => {
    // ON DELETE CASCADE on the FK columns cleans dependent rows.
    await cleanup(`
      DELETE FROM auth.users WHERE id IN ('${USER_A}', '${USER_B}');
    `);
  }, 90000);

  // ---- user_configs (public read, owner-only DELETE) --------------------

  describe('user_configs', () => {
    const seedAppId = seedKey('uc');

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
    }, 90000);

    afterAll(async () => {
      await cleanup(`DELETE FROM public.user_configs WHERE app_id = '${seedAppId}';`);
    }, 90000);

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
    }, 90000);
  });

  // ---- user_proton_configs (public read, owner-only DELETE via UUID) ----

  describe('user_proton_configs', () => {
    // app_id is an integer here, so derive a per-run number instead.
    const seedApp = 900000000 + parseInt(RUN_ID.slice(0, 7), 16) % 100000000;
    const seedVoter = seedKey('upc');

    beforeAll(async () => {
      await cleanup(`
        DELETE FROM public.user_proton_configs
        WHERE voter_id = '${seedVoter}' AND app_id = ${seedApp};
      `);
      await cleanup(`
        INSERT INTO public.user_proton_configs (voter_id, proton_pulse_user_id, app_id, app_name, config)
        VALUES ('${seedVoter}', '${USER_A}', ${seedApp}, 'CI RLS', '{}'::jsonb);
      `);
    }, 90000);

    afterAll(async () => {
      await cleanup(`
        DELETE FROM public.user_proton_configs
        WHERE voter_id = '${seedVoter}' AND app_id = ${seedApp};
      `);
    }, 90000);

    test('USER_B DELETE affects 0 rows (owner-only DELETE via UUID)', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_proton_configs
        WHERE app_id = ${seedApp}
        RETURNING app_id;
      `);
      expect(rows).toHaveLength(0);
      const verify = await cleanup(`SELECT app_id FROM public.user_proton_configs WHERE app_id = ${seedApp};`);
      expect(verify).toHaveLength(1);
    }, 90000);
  });

  // ---- user_systems (fully owner-scoped) --------------------------------

  describe('user_systems', () => {
    const seedLabel = seedKey('user_systems');
    const seedDevice = seedKey('device');

    beforeAll(async () => {
      await cleanup(`DELETE FROM public.user_systems WHERE label = '${seedLabel}';`);
      await cleanup(`
        INSERT INTO public.user_systems (proton_pulse_user_id, device_id, label, sysinfo_text)
        VALUES ('${USER_A}', '${seedDevice}', '${seedLabel}', 'ci sysinfo');
      `);
    }, 90000);

    afterAll(async () => {
      await cleanup(`DELETE FROM public.user_systems WHERE label = '${seedLabel}';`);
    }, 90000);

    test('USER_B cannot SELECT USER_A row', async () => {
      const rows = await asUser(USER_B, `
        SELECT proton_pulse_user_id FROM public.user_systems
        WHERE label = '${seedLabel}';
      `);
      expect(rows).toHaveLength(0);
    }, 90000);

    test('USER_B DELETE affects 0 rows', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_systems
        WHERE label = '${seedLabel}'
        RETURNING proton_pulse_user_id;
      `);
      expect(rows).toHaveLength(0);
    }, 90000);
  });

  // ---- user_report_drafts (fully owner-scoped) --------------------------

  describe('user_report_drafts', () => {
    const seedApp = seedKey('drafts');

    beforeAll(async () => {
      await cleanup(`
        DELETE FROM public.user_report_drafts
        WHERE user_id = '${USER_A}' AND app_id = '${seedApp}';
      `);
      await cleanup(`
        INSERT INTO public.user_report_drafts (user_id, app_id, form_data)
        VALUES ('${USER_A}', '${seedApp}', '{"note":"ci"}'::jsonb);
      `);
    }, 90000);

    afterAll(async () => {
      await cleanup(`
        DELETE FROM public.user_report_drafts
        WHERE user_id = '${USER_A}' AND app_id = '${seedApp}';
      `);
    }, 90000);

    test('USER_B cannot SELECT USER_A row', async () => {
      const rows = await asUser(USER_B, `
        SELECT user_id FROM public.user_report_drafts
        WHERE app_id = '${seedApp}';
      `);
      expect(rows).toHaveLength(0);
    }, 90000);

    test('USER_B UPDATE affects 0 rows', async () => {
      const rows = await asUser(USER_B, `
        UPDATE public.user_report_drafts SET form_data = '{"note":"pwn"}'::jsonb
        WHERE app_id = '${seedApp}'
        RETURNING user_id;
      `);
      expect(rows).toHaveLength(0);
    }, 90000);

    test('USER_B DELETE affects 0 rows', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_report_drafts
        WHERE app_id = '${seedApp}'
        RETURNING user_id;
      `);
      expect(rows).toHaveLength(0);
    }, 90000);
  });

  // ---- user_steam_library / user_steam_wishlist (SELECT owner-only) -----

  describe('user_steam_library', () => {
    beforeAll(async () => {
      await cleanup(`DELETE FROM public.user_steam_library WHERE user_id = '${USER_A}';`);
      await cleanup(`
        INSERT INTO public.user_steam_library (user_id, steam_id, game_count, appids)
        VALUES ('${USER_A}', '76561000000000000', 3, '[1,2,3]'::jsonb);
      `);
    }, 90000);

    afterAll(async () => {
      await cleanup(`DELETE FROM public.user_steam_library WHERE user_id = '${USER_A}';`);
    }, 90000);

    test('USER_B cannot SELECT USER_A row', async () => {
      const rows = await asUser(USER_B, `
        SELECT user_id FROM public.user_steam_library
        WHERE user_id = '${USER_A}';
      `);
      expect(rows).toHaveLength(0);
    }, 90000);
  });

  describe('user_steam_wishlist', () => {
    beforeAll(async () => {
      await cleanup(`DELETE FROM public.user_steam_wishlist WHERE user_id = '${USER_A}';`);
      await cleanup(`
        INSERT INTO public.user_steam_wishlist (user_id, steam_id, item_count, appids)
        VALUES ('${USER_A}', '76561000000000000', 3, ARRAY[10,20,30]);
      `);
    }, 90000);

    afterAll(async () => {
      await cleanup(`DELETE FROM public.user_steam_wishlist WHERE user_id = '${USER_A}';`);
    }, 90000);

    test('USER_B cannot SELECT USER_A row', async () => {
      const rows = await asUser(USER_B, `
        SELECT user_id FROM public.user_steam_wishlist
        WHERE user_id = '${USER_A}';
      `);
      expect(rows).toHaveLength(0);
    }, 90000);

    test('USER_B DELETE affects 0 rows', async () => {
      const rows = await asUser(USER_B, `
        DELETE FROM public.user_steam_wishlist
        WHERE user_id = '${USER_A}'
        RETURNING user_id;
      `);
      expect(rows).toHaveLength(0);
    }, 90000);
  });
});
