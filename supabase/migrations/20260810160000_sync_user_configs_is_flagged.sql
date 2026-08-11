-- Sync user_configs.is_flagged with flagged_reports state so the admin
-- Reports panel's "Flagged" filter + status counts (which query
-- user_configs.is_flagged) reflect every flag, not just owner self-flags.
--
-- Problem: js/app/api/supabase.js::flagReport posts to submit_flag (a
-- SECURITY DEFINER RPC that anyone can hit) AND best-effort PATCHes
-- user_configs.is_flagged. The PATCH is blocked by RLS for non-owners,
-- which is basically every third-party flag, so is_flagged stays false
-- on the underlying row. Admin panel then shows 0 flagged even when the
-- flagged_reports queue is populated. See issue tied to #474 -- surfaced
-- while testing a Wukong flag that never appeared in the admin view.
--
-- Fix: DB trigger fires on flagged_reports INSERT and on UPDATE of
-- status. SECURITY DEFINER so it can flip the bit on any user's row.
-- Match is by reconstructing the JS reportKey() format from user_configs
-- columns: "<int(epoch(created_at))>:<gpu[:20]>:<proton_version[:15]>".
-- Only pulse-sourced flags map to a user_configs row; protondb-sourced
-- flags mirror archive data and have no matching row, so the trigger
-- no-ops for them.
--
-- Column scope: the trigger touches ONLY user_configs.is_flagged. No
-- other column is read or written by the sync path.

create or replace function public.sync_user_configs_is_flagged_from_flagged_reports()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id bigint;
  is_open   boolean := coalesce(new.status, 'open') = 'open';
begin
  -- Only pulse flags map back to a user_configs row. ProtonDB-sourced
  -- flags stay in flagged_reports alone.
  -- The flag button carries whatever `source` the report object had at
  -- render time. CDN-mirrored pulse rows come through as 'pulse' (from
  -- pulse.py's merge); native-fetched pulse rows carry the raw
  -- user_configs.source ('plugin', 'web-linux', 'proton-pulse', ...).
  -- Anything not 'protondb' is a candidate for a user_configs match.
  if lower(coalesce(new.source, '')) = 'protondb' then
    return new;
  end if;

  select id into target_id
    from public.user_configs
   where app_id = new.app_id
     and format('%s:%s:%s',
                floor(extract(epoch from created_at))::bigint::text,
                left(coalesce(gpu, ''), 20),
                left(coalesce(proton_version, ''), 15)) = new.report_key
   limit 1;

  if target_id is null then
    return new;
  end if;

  update public.user_configs
     set is_flagged = is_open
   where id = target_id
     and is_flagged is distinct from is_open;

  return new;
end;
$$;

drop trigger if exists trg_sync_user_configs_is_flagged on public.flagged_reports;
create trigger trg_sync_user_configs_is_flagged
  after insert or update of status on public.flagged_reports
  for each row
  execute function public.sync_user_configs_is_flagged_from_flagged_reports();

-- Backfill: for every currently-open non-protondb flag, set is_flagged
-- on the matching user_configs row. Same match logic as the trigger.
update public.user_configs uc
   set is_flagged = true
  from public.flagged_reports fr
 where lower(coalesce(fr.source, '')) <> 'protondb'
   and coalesce(fr.status, 'open') = 'open'
   and fr.app_id = uc.app_id
   and format('%s:%s:%s',
              floor(extract(epoch from uc.created_at))::bigint::text,
              left(coalesce(uc.gpu, ''), 20),
              left(coalesce(uc.proton_version, ''), 15)) = fr.report_key
   and uc.is_flagged is distinct from true;
