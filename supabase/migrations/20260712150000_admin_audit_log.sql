-- Admin audit log (#283 follow-up).
--
-- A durable record that privileged actions ran, kept for GDPR accountability.
-- The whole point of erasure is to remove identifiable data, so this log is
-- careful NOT to reintroduce it:
--
--   actor_user_id  the admin who ran the action (not the erased user).
--   target_hash    md5 of the erased user's id. Lets us answer "did you erase
--                  my account?" by hashing the id they give us and comparing,
--                  without storing the raw id in a form we can enumerate.
--   anon_token     the one-time random token the erasure assigned to the
--                  anonymized rows. Points at no identity; lets us correlate
--                  the audit entry to those rows if we ever must.
--   details        the JSON counts summary (anonymized + deleted per table).
--
-- Generic on purpose (action column) so other privileged actions can log here
-- later without another schema change.

create table if not exists public.admin_audit_log (
  id            bigint generated always as identity primary key,
  action        text not null,
  actor_user_id uuid,
  target_hash   text,
  anon_token    text,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists admin_audit_log_action_created_idx
  on public.admin_audit_log (action, created_at desc);

alter table public.admin_audit_log enable row level security;

-- Only super_admins may read the log. No anon, no public. Uses the SECURITY
-- DEFINER helper instead of an inline subquery against admins: a cross-table
-- subquery in an RLS policy 500s authenticated readers (see tests/supabaseSchema
-- RLS linter), and is_current_user_super_admin() is the established safe path.
drop policy if exists "super_admins read audit log" on public.admin_audit_log;
create policy "super_admins read audit log"
  on public.admin_audit_log for select
  to authenticated
  using (public.is_current_user_super_admin());

-- No direct client writes. Rows are inserted only by the security-definer
-- functions below, which run as owner and bypass these grants.
revoke all on public.admin_audit_log from public, anon;
grant select on public.admin_audit_log to authenticated;

-- Re-define admin_erase_user to write one audit row per erasure. Body is the
-- anonymize-in-place logic from 20260712140000 plus the log insert before return.
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

  -- Fresh, unguessable token for this erasure. Not derived from p_user_id.
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

  -- Anonymize user_configs in place (preserve the report + notes).
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

  -- user_systems: sysinfo_text can carry usernames / paths. Delete, do not keep.
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
      'auth_users',           d_auth
    )
  );

  -- Audit trail: no raw target id, only a hash. Counts are non-identifiable.
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
