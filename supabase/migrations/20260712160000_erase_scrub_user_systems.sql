-- Erasure: scrub-and-preserve user_systems instead of deleting it (#283).
--
-- Earlier (20260712140000) admin_erase_user deleted user_systems outright, on
-- the assumption sysinfo_text carried usernames / home paths. A probe of the
-- live table found that untrue: every row is the structured Steam "copy system
-- info" format (CPU / GPU / RAM / OS / driver / kernel), no paths, IPs, MACs, or
-- hostnames. user_systems also has a public read policy, so an anonymized row is
-- still reachable, not orphaned. So we now treat it like the other community
-- rows: keep it, strip the identity, and scrub sysinfo_text as a safety net for
-- any future free-form pasted dump.
--
-- What the scrub redacts (belt and suspenders; current data has none of these):
--   /home/<user> and /Users/<user> paths, IPv4 addresses, MAC addresses.
-- Identity columns (proton_pulse_user_id, installation_id, steam_id) are nulled,
-- device_id and label are replaced so a device handle or a "Mike's Deck" label
-- cannot identify the former owner.

alter table public.user_systems add column if not exists anonymized_at timestamptz;

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
  a_systems        int := 0;

  d_history        int := 0;
  d_votes          int := 0;
  d_site_events    int := 0;
  d_plugin_links   int := 0;
  d_claimed        int := 0;
  d_avatars        int := 0;
  d_admins         int := 0;
  d_auth           int := 0;
begin
  select role into v_caller_role
  from public.admins
  where proton_pulse_user_id = auth.uid();

  if v_caller_role is distinct from 'super_admin' then
    raise exception 'admin_erase_user: caller must be super_admin';
  end if;

  v_anon := 'anon_' || replace(gen_random_uuid()::text, '-', '');

  select steam_id into v_steam_id
  from public.author_avatars
  where proton_pulse_user_id = p_user_id;

  select array_agg(id) into v_config_ids
  from public.user_configs
  where proton_pulse_user_id = p_user_id
     or (p_client_id is not null and client_id = p_client_id);

  if v_config_ids is not null then
    delete from public.user_configs_history where config_id = any(v_config_ids);
    get diagnostics d_history = row_count;
  end if;

  update public.user_configs
  set proton_pulse_user_id = null,
      installation_id      = null,
      client_id            = v_anon,
      anonymized_at        = now()
  where proton_pulse_user_id = p_user_id
     or (p_client_id is not null and client_id = p_client_id);
  get diagnostics a_configs = row_count;

  update public.user_proton_configs
  set proton_pulse_user_id = null,
      installation_id      = null,
      voter_id             = v_anon,
      anonymized_at        = now()
  where proton_pulse_user_id = p_user_id;
  get diagnostics a_proton_configs = row_count;

  update public.config_playtime
  set voter_id      = v_anon,
      anonymized_at = now()
  where voter_id = p_user_id::text
     or (p_client_id is not null and voter_id = p_client_id);
  get diagnostics a_playtime = row_count;

  -- user_systems: keep the hardware, strip identity, scrub any PII in the dump.
  update public.user_systems
  set proton_pulse_user_id = null,
      installation_id      = null,
      steam_id             = null,
      device_id            = v_anon,
      label                = 'Anonymized system',
      is_default           = false,
      sysinfo_text = regexp_replace(
                       regexp_replace(
                         regexp_replace(
                           regexp_replace(sysinfo_text,
                             '/home/[A-Za-z0-9._-]+', '/home/[redacted]', 'g'),
                           '/Users/[A-Za-z0-9._-]+', '/Users/[redacted]', 'gi'),
                         '(\d{1,3}\.){3}\d{1,3}', '[redacted-ip]', 'g'),
                       '([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', '[redacted-mac]', 'g'),
      anonymized_at = now()
  where proton_pulse_user_id = p_user_id
     or (v_steam_id is not null and steam_id = v_steam_id);
  get diagnostics a_systems = row_count;

  delete from public.report_votes
  where voter_id = p_user_id::text;
  get diagnostics d_votes = row_count;

  delete from public.site_events
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_site_events = row_count;

  delete from public.plugin_links
  where linked_user_id = p_user_id;
  get diagnostics d_plugin_links = row_count;

  if v_steam_id is not null then
    delete from public.claimed_client_ids
    where steam_id = v_steam_id;
    get diagnostics d_claimed = row_count;
  end if;

  delete from public.author_avatars
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_avatars = row_count;

  delete from public.admins
  where proton_pulse_user_id = p_user_id;
  get diagnostics d_admins = row_count;

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
      'config_playtime',     a_playtime,
      'user_systems',        a_systems
    ),
    'deleted', json_build_object(
      'user_configs_history', d_history,
      'report_votes',         d_votes,
      'site_events',          d_site_events,
      'plugin_links',         d_plugin_links,
      'claimed_client_ids',   d_claimed,
      'author_avatars',       d_avatars,
      'admins',               d_admins,
      'auth_users',           d_auth
    )
  );

  insert into public.admin_audit_log(action, actor_user_id, target_hash, anon_token, details)
  values (
    'erase_user',
    auth.uid(),
    md5(p_user_id::text),
    v_anon,
    json_build_object('anonymized', v_result->'anonymized', 'deleted', v_result->'deleted')::jsonb
  );

  raise notice 'admin_erase_user (anonymize) result: %', v_result;
  return v_result;
end;
$$;

revoke all on function public.admin_erase_user(uuid, text) from public, anon;
grant execute on function public.admin_erase_user(uuid, text) to authenticated;
