-- Fix: snapshot_user_configs_before_update() ran as SECURITY INVOKER, so its
-- INSERT into user_configs_history executed as the calling role (e.g. an
-- authenticated admin). user_configs_history has RLS enabled with only a SELECT
-- policy and no INSERT policy, so the audit insert was rejected:
--   ERROR: 42501: new row violates row-level security policy for table
--          "user_configs_history"
-- That error aborts the parent UPDATE on user_configs, which is why banning a
-- user (and report edits/hides) returned 403.
--
-- Audit triggers must write their history regardless of who triggered them, so
-- the function should be SECURITY DEFINER (matching hide_configs_on_ban). The
-- body already fully-qualifies every object, so search_path is locked to '' to
-- keep the definer-context function from being hijacked.
CREATE OR REPLACE FUNCTION public.snapshot_user_configs_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
declare
  table_size_mb float;
begin
  insert into public.user_configs_history
    (config_id, app_id, rating, proton_version, os, notes, config_key, recorded_at)
  values
    (old.id, old.app_id, old.rating, old.proton_version, old.os, old.notes, old.config_key, now());

  -- Prune oldest rows when table exceeds 50 MB
  select pg_total_relation_size('public.user_configs_history') / 1048576.0 into table_size_mb;
  if table_size_mb > 50 then
    delete from public.user_configs_history
    where id in (
      select id from public.user_configs_history
      order by recorded_at asc
      limit 200
    );
  end if;

  return new;
end;
$function$;
