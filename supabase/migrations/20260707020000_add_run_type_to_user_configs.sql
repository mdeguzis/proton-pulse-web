-- Report "run type": did the reporter play the native Linux build, or the
-- Windows build via Proton? This is the axis that lets us split every
-- future stat into Native vs Proton (FPS deltas, tier distribution, fault
-- rate). Nullable so existing rows carry no assumption; readers treat null
-- as unknown (safer than backfilling every legacy row as 'proton').

alter table public.user_configs
  add column if not exists run_type text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_configs_run_type_chk'
  ) then
    alter table public.user_configs
      add constraint user_configs_run_type_chk check (
        run_type is null or run_type in ('native', 'proton')
      );
  end if;
end $$;

create index if not exists idx_user_configs_run_type
  on public.user_configs (run_type)
  where run_type is not null;

-- Mirror in history so snapshots preserve the value.
alter table public.user_configs_history
  add column if not exists run_type text;

-- Refresh the snapshot trigger so it copies the new column on UPDATE.
create or replace function public.snapshot_user_configs_before_update()
returns trigger language plpgsql as $$
declare
  table_size_mb float;
begin
  insert into public.user_configs_history
    (config_id, app_id, rating, proton_version, os, notes, config_key,
     fps_min, fps_avg, fps_max, run_type, recorded_at)
  values
    (old.id, old.app_id, old.rating, old.proton_version, old.os, old.notes, old.config_key,
     old.fps_min, old.fps_avg, old.fps_max, old.run_type, now());

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
$$;
