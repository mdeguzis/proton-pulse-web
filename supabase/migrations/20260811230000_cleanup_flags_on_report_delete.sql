-- When a user_configs row is deleted (admin action, account erase, or any
-- other path), also drop matching flagged_reports rows so the flag does not
-- linger as an orphan the admin can never act on again.
--
-- Match key: the same reconstruction used by
-- sync_user_configs_is_flagged_from_flagged_reports (migration
-- 20260810160000). ProtonDB-sourced flags are unaffected -- they never map
-- to a user_configs row in the first place.
--
-- Scoped strictly to DELETE from flagged_reports; no other side effects.

create or replace function public.cleanup_flags_on_user_config_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.flagged_reports fr
  where fr.app_id = old.app_id
    and lower(coalesce(fr.source, '')) <> 'protondb'
    and fr.report_key = format('%s:%s:%s',
                               floor(extract(epoch from old.created_at))::bigint::text,
                               left(coalesce(old.gpu, ''), 20),
                               left(coalesce(old.proton_version, ''), 15));
  return old;
end;
$$;

drop trigger if exists trg_cleanup_flags_on_report_delete on public.user_configs;
create trigger trg_cleanup_flags_on_report_delete
  after delete on public.user_configs
  for each row
  execute function public.cleanup_flags_on_user_config_delete();

-- One-time backfill: any current non-protondb flagged_reports row whose
-- report_key does NOT match a live user_configs row is orphaned. Drop it.
-- This cleans up historical drift (deleted-report flags that pre-date the
-- trigger, including the Wukong test flag).
delete from public.flagged_reports fr
where lower(coalesce(fr.source, '')) <> 'protondb'
  and not exists (
    select 1 from public.user_configs uc
    where uc.app_id = fr.app_id
      and format('%s:%s:%s',
                 floor(extract(epoch from uc.created_at))::bigint::text,
                 left(coalesce(uc.gpu, ''), 20),
                 left(coalesce(uc.proton_version, ''), 15)) = fr.report_key
  );
