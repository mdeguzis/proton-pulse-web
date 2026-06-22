-- GDPR / right-to-erasure function for admins.
--
-- Completely removes all data for a given user across every table, including
-- the auth.users row. Runs as security definer so it can reach auth schema.
--
-- Usage (from admin panel or Supabase SQL editor):
--   SELECT admin_erase_user('uuid-here');
--   SELECT admin_erase_user('uuid-here', 'client-id-here');  -- also wipes anon data
--
-- Returns a JSON summary of rows deleted per table.
-- Only callable by super_admin role (checked against admins table).

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
  v_steam_id        text;
  v_config_ids      bigint[];
  v_caller_role     text;
  v_deleted         json;

  d_configs         int := 0;
  d_history         int := 0;
  d_proton_configs  int := 0;
  d_systems         int := 0;
  d_votes           int := 0;
  d_playtime        int := 0;
  d_site_events     int := 0;
  d_plugin_links    int := 0;
  d_claimed         int := 0;
  d_avatars         int := 0;
  d_admins          int := 0;
  d_auth            int := 0;
begin
  -- Only super_admins may call this.
  select role into v_caller_role
  from public.admins
  where proton_pulse_user_id = auth.uid();

  if v_caller_role is distinct from 'super_admin' then
    raise exception 'admin_erase_user: caller must be super_admin';
  end if;

  -- Grab steam_id before deleting author_avatars (needed for claimed_client_ids).
  select steam_id into v_steam_id
  from public.author_avatars
  where proton_pulse_user_id = p_user_id;

  -- Collect config IDs so we can delete history rows (FK child).
  select array_agg(id) into v_config_ids
  from public.user_configs
  where proton_pulse_user_id = p_user_id
     or (p_client_id is not null and client_id = p_client_id);

  -- user_configs_history (must go before user_configs)
  if v_config_ids is not null then
    delete from public.user_configs_history where config_id = any(v_config_ids);
    get diagnostics d_history = row_count;
  end if;

  -- user_configs
  delete from public.user_configs
  where proton_pulse_user_id = p_user_id
     or (p_client_id is not null and client_id = p_client_id);
  get diagnostics d_configs = row_count;

  -- user_proton_configs
  delete from public.user_proton_configs
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_proton_configs = row_count;

  -- user_systems
  delete from public.user_systems
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_systems = row_count;

  -- report_votes (voter_id stores proton_pulse_user_id as text)
  delete from public.report_votes
  where voter_id = p_user_id::text;
  get diagnostics d_votes = row_count;

  -- config_playtime
  delete from public.config_playtime
  where voter_id = p_user_id::text
     or (p_client_id is not null and voter_id = p_client_id);
  get diagnostics d_playtime = row_count;

  -- site_events
  delete from public.site_events
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_site_events = row_count;

  -- plugin_links
  delete from public.plugin_links
  where linked_user_id = p_user_id;
  get diagnostics d_plugin_links = row_count;

  -- claimed_client_ids (linked via steam_id from author_avatars)
  if v_steam_id is not null then
    delete from public.claimed_client_ids
    where steam_id = v_steam_id;
    get diagnostics d_claimed = row_count;
  end if;

  -- author_avatars
  delete from public.author_avatars
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_avatars = row_count;

  -- admins (remove any admin role)
  delete from public.admins
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_admins = row_count;

  -- auth.users (the actual account -- must be last)
  delete from auth.users
  where id = p_user_id;
  get diagnostics d_auth = row_count;

  v_deleted := json_build_object(
    'user_id',            p_user_id,
    'client_id',          p_client_id,
    'user_configs',       d_configs,
    'user_configs_history', d_history,
    'user_proton_configs', d_proton_configs,
    'user_systems',       d_systems,
    'report_votes',       d_votes,
    'config_playtime',    d_playtime,
    'site_events',        d_site_events,
    'plugin_links',       d_plugin_links,
    'claimed_client_ids', d_claimed,
    'author_avatars',     d_avatars,
    'admins',             d_admins,
    'auth_users',         d_auth
  );

  raise notice 'admin_erase_user result: %', v_deleted;
  return v_deleted;
end;
$$;

-- Only super_admins (authenticated) can execute this. No anon access.
revoke all on function public.admin_erase_user(uuid, text) from public, anon;
grant execute on function public.admin_erase_user(uuid, text) to authenticated;
