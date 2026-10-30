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

// #570: game_hides / game_remaps are publicly readable (the frontend filters
// hides and follows remaps without a session), but the admin user id columns
// are not. Column grants, not RLS, enforce this, so query as anon directly.
describeIfCreds('Column grants: admin ids on game_hides / game_remaps (#570)', () => {
  async function asAnon(sql) {
    return queryDB(`SET LOCAL ROLE anon; ${sql}`);
  }

  test('anon can read the public columns', async () => {
    await expect(asAnon('SELECT app_id, reason, hidden_at FROM public.game_hides LIMIT 1;')).resolves.toBeDefined();
    await expect(asAnon('SELECT from_app_id, to_app_id, reason, created_at, updated_at FROM public.game_remaps LIMIT 1;')).resolves.toBeDefined();
  }, 90000);

  test('anon cannot read hidden_by or remapped_by', async () => {
    await expect(asAnon('SELECT hidden_by FROM public.game_hides LIMIT 1;')).rejects.toThrow(/permission denied/);
    await expect(asAnon('SELECT remapped_by FROM public.game_remaps LIMIT 1;')).rejects.toThrow(/permission denied/);
  }, 90000);

  test('a signed-in user cannot read the id columns either', async () => {
    await expect(asUser(USER_A, 'SELECT hidden_by FROM public.game_hides LIMIT 1;')).rejects.toThrow(/permission denied/);
  }, 90000);

  test('clients cannot write the id columns; the server fills them', async () => {
    await expect(asUser(USER_A, `
      INSERT INTO public.game_hides (app_id, reason, hidden_by)
      VALUES ('${seedKey('hide')}', 'probe', '${USER_A}');
    `)).rejects.toThrow(/permission denied/);
    const defaults = await queryDB(`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'game_hides' AND column_name = 'hidden_by')
          OR (table_name = 'game_remaps' AND column_name = 'remapped_by'))
      ORDER BY column_name;
    `);
    expect(defaults.map((r) => r.column_default)).toEqual(['auth.uid()', 'auth.uid()']);
  }, 90000);
});

// Security fix 2026-10-29: user_configs had an UPDATE policy "Anyone can flag
// a report" with USING (true) / WITH CHECK (is_flagged = true), so any anon
// caller could rewrite every column of any report while setting is_flagged.
// Dropped in 20261029230000; flagging goes through submit_flag + a trigger.
describeIfCreds('RLS: reports cannot be rewritten by other callers', () => {
  test('anon cannot update another report, even while setting is_flagged', async () => {
    const rows = await queryDB(`
      SET LOCAL ROLE anon;
      SET LOCAL "request.jwt.claims" = '{"role":"anon"}';
      UPDATE public.user_configs SET notes = notes, is_flagged = true
      WHERE id = (SELECT min(id) FROM public.user_configs)
      RETURNING id;
    `);
    expect(rows).toHaveLength(0);
  }, 90000);

  test('a signed-in non-owner cannot update another report either', async () => {
    const rows = await asUser(USER_B, `
      UPDATE public.user_configs SET is_flagged = true
      WHERE id = (SELECT min(id) FROM public.user_configs)
        AND proton_pulse_user_id IS DISTINCT FROM '${USER_B}'
      RETURNING id;
    `);
    expect(rows).toHaveLength(0);
  }, 90000);

  test('the permissive flag UPDATE policy is gone from user_configs', async () => {
    const rows = await queryDB(`
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'user_configs'
        AND cmd = 'UPDATE' AND qual = 'true';
    `);
    expect(rows).toEqual([]);
  }, 90000);
});


// Security fix 2026-10-30: report_approvals had "Service role can manage
// approvals" FOR ALL TO public USING (true) WITH CHECK (true), so anyone with
// the anon key could approve their own report and skip moderation. Replaced
// in 20261030010000: manage_reports writes, the signed-in report owner may
// delete (edit re-review), anon has no write grant. The UPDATEs below set a
// column to itself, so a regression cannot change data.
describeIfCreds('RLS: report_approvals writes are moderator-only', () => {
  test('anon has no write grant on report_approvals', async () => {
    await expect(queryDB(`
      SET LOCAL ROLE anon;
      SET LOCAL "request.jwt.claims" = '{"role":"anon"}';
      UPDATE public.report_approvals SET approved_by = approved_by RETURNING report_id;
    `)).rejects.toThrow(/permission denied/);
  }, 90000);

  test('anon can still read approvals (pending badges)', async () => {
    const rows = await queryDB(`
      SET LOCAL ROLE anon;
      SELECT count(*)::int AS n FROM public.report_approvals;
    `);
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  }, 90000);

  test('a signed-in non-moderator updates and deletes nothing', async () => {
    const updated = await asUser(USER_B, `
      UPDATE public.report_approvals SET approved_by = approved_by RETURNING report_id;
    `);
    expect(updated).toHaveLength(0);
    // Rolled back so a regression cannot delete real approvals.
    const deleted = await queryDB(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL "request.jwt.claims" = '${jwtClaims(USER_B)}';
      WITH d AS (DELETE FROM public.report_approvals RETURNING report_id)
      SELECT count(*)::int AS n FROM d;
      ROLLBACK;
    `);
    expect(deleted[0].n).toBe(0);
  }, 90000);

  test('no permissive write policy remains on report_approvals', async () => {
    const rows = await queryDB(`
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'report_approvals'
        AND cmd <> 'SELECT' AND (qual = 'true' OR with_check = 'true');
    `);
    expect(rows).toEqual([]);
  }, 90000);
});

// #62: anonymous writers prove ownership with a per-client secret (hash in
// client_secrets) through the client_* RPCs, which also enforce bans.
// Migration 20261030020000. Every case runs in a transaction that is rolled
// back, so nothing persists.
describeIfCreds('Client secret RPCs (anon writers)', () => {
  const CLIENT = `ci-rls-client-${RUN_ID}`;
  const SECRET = `ci-secret-${'a'.repeat(32)}`;
  const OTHER_SECRET = `ci-secret-${'b'.repeat(32)}`;
  const anonTx = (sql) => queryDB(`
    BEGIN;
    SET LOCAL ROLE anon;
    SET LOCAL "request.jwt.claims" = '{"role":"anon"}';
    ${sql};
    ROLLBACK;
  `);
  const vote = (secret, v = 1) =>
    `SELECT public.client_cast_vote('${CLIENT}', '${secret}', '730', 'ci-key', ${v}::smallint)`;

  test('first call registers the secret and the vote lands', async () => {
    const rows = await anonTx(`${vote(SECRET)};
      SELECT count(*)::int AS n FROM public.report_votes WHERE voter_id = '${CLIENT}'`);
    expect(rows[0].n).toBe(1);
  }, 90000);

  test('a different secret for the same client id is refused', async () => {
    await expect(anonTx(`${vote(SECRET)}; ${vote(OTHER_SECRET, -1)}`))
      .rejects.toThrow(/client secret mismatch/);
  }, 90000);

  test('a voter id used by a linked install cannot be claimed with another secret', async () => {
    const linked = await queryDB(`
      SELECT upc.voter_id FROM public.plugin_links pl
      JOIN public.user_proton_configs upc ON upc.installation_id = pl.installation_id
      WHERE pl.installation_secret_hash IS NOT NULL LIMIT 1;
    `);
    if (!linked.length) return; // no linked installs in this project
    await expect(anonTx(
      `SELECT public.client_cast_vote('${linked[0].voter_id}', '${OTHER_SECRET}', '730', 'ci-key', 1::smallint)`,
    )).rejects.toThrow(/client secret mismatch/);
  }, 90000);

  test('a banned client is refused, an expired timed ban is not', async () => {
    await expect(queryDB(`
      BEGIN;
      INSERT INTO public.banned_users (client_id, banned_reason) VALUES ('${CLIENT}', 'ci');
      SET LOCAL ROLE anon;
      ${vote(SECRET)};
      ROLLBACK;
    `)).rejects.toThrow(/client is banned/);
    const rows = await queryDB(`
      BEGIN;
      INSERT INTO public.banned_users (client_id, banned_reason, banned_until)
        VALUES ('${CLIENT}', 'ci', now() - interval '1 day');
      SET LOCAL ROLE anon;
      ${vote(SECRET)};
      SELECT count(*)::int AS n FROM public.report_votes WHERE voter_id = '${CLIENT}';
      ROLLBACK;
    `);
    expect(rows[0].n).toBe(1);
  }, 90000);

  test('anon cannot call the helpers or read client_secrets', async () => {
    await expect(anonTx(`SELECT public.client_verify('${CLIENT}', '${SECRET}')`))
      .rejects.toThrow(/permission denied/);
    await expect(anonTx('SELECT count(*) FROM public.client_secrets'))
      .rejects.toThrow(/permission denied/);
  }, 90000);

  test('submit_report ignores ownership and moderation fields from the caller', async () => {
    const report = JSON.stringify({
      app_id: '999999', title: 't', cpu: 'c', gpu: 'g', ram: '16', os: 'SteamOS',
      proton_version: '9', rating: 'gold',
      client_id: 'someone-else', proton_pulse_user_id: USER_A,
      is_hidden: true, is_flagged: true, owner_verified: true,
    });
    const rows = await anonTx(`
      SELECT public.client_submit_report('${CLIENT}', '${SECRET}', NULL, '${report}'::jsonb);
      RESET ROLE;
      SELECT client_id, proton_pulse_user_id, is_hidden, is_flagged, owner_verified
      FROM public.user_configs WHERE client_id IN ('${CLIENT}', 'someone-else')`);
    expect(rows).toEqual([{
      client_id: CLIENT, proton_pulse_user_id: null,
      is_hidden: false, is_flagged: false, owner_verified: false,
    }]);
  }, 90000);

  test('cloud configs and plugin settings round-trip only for the owner', async () => {
    const rows = await anonTx(`
      SELECT public.client_save_cloud_config('${CLIENT}', '${SECRET}', NULL, 730, 'CS', '', '{"a":1}'::jsonb);
      SELECT public.client_save_plugin_settings('${CLIENT}', '${SECRET}', 'ci', '{"x":1}'::jsonb);
      SELECT (SELECT count(*)::int FROM public.client_my_cloud_configs('${CLIENT}', '${SECRET}', NULL)) AS configs,
             (SELECT count(*)::int FROM public.client_my_plugin_settings('${CLIENT}', '${SECRET}', 'ci')) AS settings`);
    expect(rows[0]).toEqual({ configs: 1, settings: 1 });
    await expect(anonTx(`
      SELECT public.client_save_cloud_config('${CLIENT}', '${SECRET}', NULL, 730, 'CS', '', '{}'::jsonb);
      SELECT * FROM public.client_my_cloud_configs('${CLIENT}', '${OTHER_SECRET}', NULL)`))
      .rejects.toThrow(/client secret mismatch/);
  }, 90000);

  test('finish_playtime only closes sessions this client started', async () => {
    const rows = await anonTx(`
      SELECT public.client_finish_playtime('${CLIENT}', '${SECRET}',
        public.client_start_playtime('${CLIENT}', '${SECRET}', '730', 'ck', '9', 'pulse', now()),
        now(), 5) AS mine,
      public.client_finish_playtime('${CLIENT}', '${SECRET}',
        (SELECT min(id) FROM public.config_playtime WHERE voter_id <> '${CLIENT}'), now(), 5) AS theirs`);
    expect(rows[0]).toEqual({ mine: true, theirs: false });
  }, 90000);
});

// #62: the web client's signed writes. client-write (edge fn) verifies the
// ECDSA signature, then calls client_web_key / client_web_write with the
// service role. Migration 20261031010000. Rolled back, nothing persists.
describeIfCreds('Web client signed writes (service-role functions)', () => {
  const CLIENT = `ci-rls-web-${RUN_ID}`;
  const KEY = '{"kty":"EC","crv":"P-256","x":"ci-x","y":"ci-y"}';
  const asService = (sql) => queryDB(`BEGIN; SET LOCAL ROLE service_role; ${sql}; ROLLBACK;`);
  const write = (ts, vote = 1) =>
    `SELECT public.client_web_write('${CLIENT}', ${ts}, 'cast_vote', '{"app_id":"730","report_key":"ci","vote":${vote}}'::jsonb)`;

  test('registers a key on first use and writes the vote', async () => {
    const rows = await asService(`
      SELECT public.client_web_key('${CLIENT}', '${KEY}'::jsonb);
      ${write(100)};
      SELECT count(*)::int AS n FROM public.report_votes WHERE voter_id = '${CLIENT}'`);
    expect(rows[0].n).toBe(1);
  }, 90000);

  test('a replayed or older timestamp is refused', async () => {
    await expect(asService(`
      SELECT public.client_web_key('${CLIENT}', '${KEY}'::jsonb);
      ${write(100)}; ${write(100, -1)}`)).rejects.toThrow(/stale or replayed/);
  }, 90000);

  test('a JWK carrying a private part is refused', async () => {
    await expect(asService(`SELECT public.client_web_key('${CLIENT}',
      '{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"secret"}'::jsonb)`)).rejects.toThrow(/public key is required/);
  }, 90000);

  test('a plugin client id cannot be claimed as a web key', async () => {
    const plugin = await queryDB('SELECT voter_id FROM public.user_proton_configs LIMIT 1;');
    if (!plugin.length) return;
    await expect(asService(`SELECT public.client_web_key('${plugin[0].voter_id}', '${KEY}'::jsonb)`))
      .rejects.toThrow(/not available for a web key/);
  }, 90000);

  test('the secret RPCs refuse an id that holds a web key', async () => {
    await expect(queryDB(`
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT public.client_web_key('${CLIENT}', '${KEY}'::jsonb);
      SET LOCAL ROLE anon;
      SELECT public.client_cast_vote('${CLIENT}', 'ci-secret-${'a'.repeat(32)}', '730', 'ci', 1::smallint);
      ROLLBACK;
    `)).rejects.toThrow(/client secret mismatch/);
  }, 90000);

  test('a banned web client is refused', async () => {
    await expect(queryDB(`
      BEGIN;
      INSERT INTO public.banned_users (client_id, banned_reason) VALUES ('${CLIENT}', 'ci');
      SET LOCAL ROLE service_role;
      SELECT public.client_web_key('${CLIENT}', '${KEY}'::jsonb);
      ${write(5)};
      ROLLBACK;
    `)).rejects.toThrow(/client is banned/);
  }, 90000);

  test('anon and signed-in users cannot call the service-role functions', async () => {
    await expect(queryDB(`BEGIN; SET LOCAL ROLE anon; SELECT public.client_web_key('${CLIENT}', '${KEY}'::jsonb); ROLLBACK;`))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(USER_B, `${write(1)}`)).rejects.toThrow(/permission denied/);
  }, 90000);

  test('admin_erase_user removes the client secret and web key for the erased client id', async () => {
    const admin = await queryDB("SELECT proton_pulse_user_id FROM public.admins WHERE role = 'super_admin' LIMIT 1;");
    if (!admin.length) return;
    const rows = await queryDB(`
      BEGIN;
      INSERT INTO public.client_secrets (client_id, secret_hash) VALUES ('${CLIENT}', 'ci');
      INSERT INTO public.client_public_keys (client_id, public_key) VALUES ('${CLIENT}', '${KEY}'::jsonb);
      SET LOCAL ROLE authenticated;
      SET LOCAL "request.jwt.claims" = '${jwtClaims(admin[0].proton_pulse_user_id)}';
      SELECT public.admin_erase_user('${globalThis.crypto.randomUUID()}', '${CLIENT}');
      RESET ROLE;
      SELECT (SELECT count(*)::int FROM public.client_secrets WHERE client_id = '${CLIENT}') AS secrets,
             (SELECT count(*)::int FROM public.client_public_keys WHERE client_id = '${CLIENT}') AS keys;
      ROLLBACK;
    `);
    expect(rows[0]).toEqual({ secrets: 0, keys: 0 });
  }, 90000);
});
