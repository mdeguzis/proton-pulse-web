-- admin_erase_user: also delete the client write credentials (#62).
--
-- 20261030020000 (client_secrets) and 20261031010000 (client_public_keys)
-- added per-client tables. When an erase names a client id, both rows go.
-- The rest of the function is unchanged from the live definition.

CREATE OR REPLACE FUNCTION public.admin_erase_user(p_user_id uuid, p_client_id text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
  d_client_secrets int := 0;
  d_client_keys    int := 0;
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

  delete from public.report_votes
  where voter_id = p_user_id::text;
  get diagnostics d_votes = row_count;

  -- user_systems: private, owner-only prefill data. Deleted outright.
  delete from public.user_systems
  where proton_pulse_user_id = p_user_id
     or (v_steam_id is not null and steam_id = v_steam_id);
  get diagnostics d_systems = row_count;

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

  -- Write credentials for the erased client id (#62): the plugin secret
  -- hash and the web public key. Nothing else references them.
  if p_client_id is not null then
    delete from public.client_secrets where client_id = p_client_id;
    get diagnostics d_client_secrets = row_count;
    delete from public.client_public_keys where client_id = p_client_id;
    get diagnostics d_client_keys = row_count;
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
      'auth_users',           d_auth,
      'client_secrets',       d_client_secrets,
      'client_public_keys',   d_client_keys
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
$function$;
