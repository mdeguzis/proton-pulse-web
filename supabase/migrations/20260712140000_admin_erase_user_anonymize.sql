-- GDPR right-to-erasure, anonymize-in-place edition (#283).
--
-- Supersedes the full-delete admin_erase_user (20260622020000). The old function
-- hard-deleted every community report along with the account. That destroyed
-- aggregate compatibility data other users rely on. This version instead:
--
--   1. Fully removes identity + account data:
--        auth.users, author_avatars, admins, plugin_links, claimed_client_ids,
--        site_events (telemetry), user_systems (raw sysinfo dumps that can
--        contain usernames / home paths / hostnames -- treated as PII).
--   2. Preserves the community-visible reports (user_configs,
--        user_proton_configs, config_playtime) but strips every identifier:
--        proton_pulse_user_id / installation_id -> NULL, and the NOT NULL
--        identity columns (client_id, voter_id) -> a per-erasure random token
--        so the row cannot be traced back to the person or correlated with the
--        deleted account. anonymized_at is stamped so we can tell anonymized
--        rows from originals.
--   3. Deletes report_votes -- a vote only means something tied to a voter, and
--        the aggregate score is already snapshotted on user_configs.up_votes /
--        down_votes.
--
-- Why a per-erasure random token and not a fixed 'anonymous' string:
--   user_configs has UNIQUE (client_id, app_id) and user_proton_configs has
--   PRIMARY KEY (voter_id, app_id). A shared sentinel would collide the moment
--   two erased users had both reported the same game, and the erasure would
--   fail. A fresh random token per erasure keeps each user's own rows internally
--   consistent (one report per app) while being unlinkable to the account.
--
-- The report body is intentionally preserved, INCLUDING the free-form `notes`
-- field, for posterity -- the compatibility write-up is the community value.
-- Users are told (privacy policy + about page) not to put personal info in
-- notes precisely because that text survives account erasure.
--
-- Usage:
--   SELECT admin_erase_user('uuid-here');
--   SELECT admin_erase_user('uuid-here', 'client-id-here');  -- also anon pre-login rows
--
-- Returns a JSON summary split into anonymized_* and deleted_* counts.
-- Only callable by super_admin (checked against admins table).

-- Additive columns: which rows were anonymized and when.
alter table public.user_configs        add column if not exists anonymized_at timestamptz;
alter table public.user_proton_configs  add column if not exists anonymized_at timestamptz;
alter table public.config_playtime      add column if not exists anonymized_at timestamptz;

create or replace function public.admin_erase_user(
  p_user_id  uuid,
  p_client_id text default null
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_steam_id      text;
  v_config_ids    bigint[];
  v_caller_role   text;
  v_anon          text;
  v_result        json;

  a_configs        int := 0;
  a_proton_configs int := 0;
  a_playtime       int := 0;

  d_history        int := 0;
  d_votes          int := 0;
  d_systems        int := 0;
  d_site_events    int := 0;
  d_plugin_links   int := 0;
  d_claimed        int := 0;
  d_avatars        int := 0;
  d_admins         int := 0;
  d_auth           int := 0;
begin
  -- Only super_admins may call this.
  select role into v_caller_role
  from public.admins
  where proton_pulse_user_id = auth.uid();

  if v_caller_role is distinct from 'super_admin' then
    raise exception 'admin_erase_user: caller must be super_admin';
  end if;

  -- Fresh, unguessable token for this erasure. Not derived from p_user_id, so
  -- it can't be reversed back to the account.
  v_anon := 'anon_' || replace(gen_random_uuid()::text, '-', '');

  -- Steam id is needed to clean claimed_client_ids before author_avatars goes.
  select steam_id into v_steam_id
  from public.author_avatars
  where proton_pulse_user_id = p_user_id;

  -- Config IDs, so we can drop the edit-history audit trail (identity-bearing).
  select array_agg(id) into v_config_ids
  from public.user_configs
  where proton_pulse_user_id = p_user_id
     or (p_client_id is not null and client_id = p_client_id);

  -- user_configs_history: internal edit audit, not community-visible. Delete so
  -- old versions can't re-expose the former author. Must precede any client_id
  -- rewrite is unnecessary (keyed by config_id), but keep it before the parent
  -- update for clarity.
  if v_config_ids is not null then
    delete from public.user_configs_history where config_id = any(v_config_ids);
    get diagnostics d_history = row_count;
  end if;

  -- Anonymize user_configs in place (preserve the report + notes).
  update public.user_configs
  set proton_pulse_user_id = null,
      installation_id      = null,
      client_id            = v_anon,
      anonymized_at        = now()
  where proton_pulse_user_id = p_user_id
     or (p_client_id is not null and client_id = p_client_id);
  get diagnostics a_configs = row_count;

  -- Anonymize user_proton_configs (PK is (voter_id, app_id) -> needs v_anon).
  update public.user_proton_configs
  set proton_pulse_user_id = null,
      installation_id      = null,
      voter_id             = v_anon,
      anonymized_at        = now()
  where proton_pulse_user_id = p_user_id;
  get diagnostics a_proton_configs = row_count;

  -- Anonymize config_playtime (identity is voter_id; may be uuid or client_id).
  update public.config_playtime
  set voter_id      = v_anon,
      anonymized_at = now()
  where voter_id = p_user_id::text
     or (p_client_id is not null and voter_id = p_client_id);
  get diagnostics a_playtime = row_count;

  -- report_votes: only meaningful tied to a voter; aggregate already snapshotted.
  delete from public.report_votes
  where voter_id = p_user_id::text;
  get diagnostics d_votes = row_count;

  -- user_systems: sysinfo_text is a raw dump that can carry usernames / home
  -- paths / hostnames. Delete rather than preserve -- the hardware relevant to
  -- reports is already denormalized into user_configs.
  delete from public.user_systems
  where proton_pulse_user_id = p_user_id
     or (v_steam_id is not null and steam_id = v_steam_id);
  get diagnostics d_systems = row_count;

  -- site_events: telemetry, no aggregate value. Wipe.
  delete from public.site_events
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_site_events = row_count;

  -- plugin_links: account linkage.
  delete from public.plugin_links
  where linked_user_id = p_user_id;
  get diagnostics d_plugin_links = row_count;

  -- claimed_client_ids (via steam_id from author_avatars).
  if v_steam_id is not null then
    delete from public.claimed_client_ids
    where steam_id = v_steam_id;
    get diagnostics d_claimed = row_count;
  end if;

  -- author_avatars: display name + avatar + steam id.
  delete from public.author_avatars
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_avatars = row_count;

  -- admins: drop any admin role.
  delete from public.admins
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_admins = row_count;

  -- auth.users: the account itself. Last.
  delete from auth.users
  where id = p_user_id;
  get diagnostics d_auth = row_count;

  v_result := json_build_object(
    'user_id',    p_user_id,
    'client_id',  p_client_id,
    'anon_token', v_anon,
    'anonymized', json_build_object(
      'user_configs',        a_configs,
      'user_proton_configs', a_proton_configs,
      'config_playtime',     a_playtime
    ),
    'deleted', json_build_object(
      'user_configs_history', d_history,
      'report_votes',         d_votes,
      'user_systems',         d_systems,
      'site_events',          d_site_events,
      'plugin_links',         d_plugin_links,
      'claimed_client_ids',   d_claimed,
      'author_avatars',       d_avatars,
      'admins',               d_admins,
      'auth_users',           d_auth
    )
  );

  raise notice 'admin_erase_user (anonymize) result: %', v_result;
  return v_result;
end;
$$;

-- Only super_admins (authenticated) can execute this. No anon access.
revoke all on function public.admin_erase_user(uuid, text) from public, anon;
grant execute on function public.admin_erase_user(uuid, text) to authenticated;
