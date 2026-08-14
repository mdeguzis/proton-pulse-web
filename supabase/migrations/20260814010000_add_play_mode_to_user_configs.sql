-- #246: how did the reporter actually play the game -- flatscreen or in VR?
--
-- Separate axis from run_type (native vs Proton flavour) and from the game's
-- VR capability in search_index.vr. A game can support VR while the reporter
-- played it flat, and "works great" means something very different in each
-- mode, so a VR report must never be aggregated as if it were flatscreen.
--
-- vr_runtime / vr_device are only meaningful when play_mode = 'vr'. Both are
-- nullable and unconstrained-by-play_mode at the DB level (the form enforces
-- the pairing) so a partially-filled legacy row cannot fail an upsert.
--
-- Runtime vocabulary matches VRDB (github.com/Respuit/VRDB), the community
-- VR-on-Linux database we ingest for the game-page VR panel, so their reports
-- and ours line up on the same axes.

alter table public.user_configs
  add column if not exists play_mode  text,
  add column if not exists vr_runtime text,
  add column if not exists vr_device  text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_configs_play_mode_chk'
  ) then
    alter table public.user_configs
      add constraint user_configs_play_mode_chk check (
        play_mode is null or play_mode in ('flat', 'vr')
      );
  end if;
end $$;

-- Same shape as user_configs_run_type_chk: a regex + length check rather than
-- an enum, so adding a runtime (a new OpenXR implementation lands every few
-- months) does not need a migration. Canonical values live in js/shared/vr.js.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_configs_vr_runtime_chk'
  ) then
    alter table public.user_configs
      add constraint user_configs_vr_runtime_chk check (
        vr_runtime is null
        or (
          char_length(vr_runtime) between 1 and 32
          and vr_runtime ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        )
      );
  end if;
end $$;

-- Headset is picked from a canonical list but allows "Other" free text, so
-- this is a length bound only. Trimmed and length-capped client-side too.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_configs_vr_device_chk'
  ) then
    alter table public.user_configs
      add constraint user_configs_vr_device_chk check (
        vr_device is null or char_length(vr_device) between 1 and 64
      );
  end if;
end $$;

-- Partial index: VR reports are a small minority, and every query that cares
-- about them filters play_mode = 'vr' first.
create index if not exists idx_user_configs_play_mode
  on public.user_configs (play_mode)
  where play_mode is not null;

create index if not exists idx_user_configs_vr_runtime
  on public.user_configs (vr_runtime)
  where vr_runtime is not null;

-- Mirror in history so edit snapshots preserve the values.
alter table public.user_configs_history
  add column if not exists play_mode  text,
  add column if not exists vr_runtime text,
  add column if not exists vr_device  text;

-- Refresh the snapshot trigger for the new columns. Per the rule in
-- 20260726020000: keep SECURITY DEFINER + SET search_path = '' when
-- redefining this function, or every owner UPDATE on user_configs 403s.
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
     fps_min, fps_avg, fps_max, run_type, play_mode, vr_runtime, vr_device,
     recorded_at)
  values
    (old.id, old.app_id, old.rating, old.proton_version, old.os, old.notes, old.config_key,
     old.fps_min, old.fps_avg, old.fps_max, old.run_type, old.play_mode,
     old.vr_runtime, old.vr_device, now());

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
