-- Fix: the 2026-07-07 migrations (add_fps_metrics, add_run_type) redefined
-- snapshot_user_configs_before_update() to copy the new columns but dropped
-- the SECURITY DEFINER + search_path hardening that 20260616000100 added.
-- Regression symptom: any owner UPDATE on user_configs 403s, because the
-- trigger's INSERT into user_configs_history runs as the calling role and
-- that table's RLS only has a SELECT policy. This re-broke report edits and
-- broke the new is_hidden unpublish flow (#408).
--
-- Same fix as 20260616000100, now with the full current column list. Rule
-- for future column additions: keep SECURITY DEFINER + SET search_path = ''
-- when redefining this function.
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
    (config_id, app_id, rating, proton_version, os, notes, config_key,
     fps_min, fps_avg, fps_max, run_type, recorded_at)
  values
    (old.id, old.app_id, old.rating, old.proton_version, old.os, old.notes, old.config_key,
     old.fps_min, old.fps_avg, old.fps_max, old.run_type, now());

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
