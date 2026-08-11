-- Extend get_report_status_counts + expose orphan flags to the admin Reports
-- panel so a flag is never invisible just because its underlying user_configs
-- row was deleted (account cleanup, admin delete, CDN mirror row without a
-- matching pulse submission, etc.). Moderation history is a permanent record;
-- an orphan flag must still be reviewable, dismissable, and countable.
--
-- What counts as an orphan: any flagged_reports row that is NOT protondb-sourced
-- and whose report_key does not reconstruct to a live user_configs row (same
-- match key the trigger uses -- see 20260810160000_sync_user_configs_is_flagged).
-- ProtonDB-sourced flags are omitted; those live in the standalone Flagged
-- Reports tab only, per the ProtonDB decouple (#474).

-- get_report_status_counts now sums orphan flags into the `flagged` bucket and
-- adds their count to `total`. approved/pending/hidden are unchanged.
create or replace function public.get_report_status_counts()
returns table (
  total    bigint,
  flagged  bigint,
  hidden   bigint,
  approved bigint,
  pending  bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.current_user_has_permission('view_analytics') then
    raise exception 'view_analytics permission required';
  end if;

  return query
  with base as (
    select
      uc.is_flagged,
      uc.is_hidden,
      exists (select 1 from report_approvals ra where ra.report_id = uc.id) as is_approved
    from user_configs uc
  ),
  orphan_flags as (
    select count(*)::bigint as n
    from flagged_reports fr
    where lower(coalesce(fr.source, '')) <> 'protondb'
      and coalesce(fr.status, 'open') = 'open'
      and not exists (
        select 1 from user_configs uc
        where uc.app_id = fr.app_id
          and format('%s:%s:%s',
                     floor(extract(epoch from uc.created_at))::bigint::text,
                     left(coalesce(uc.gpu, ''), 20),
                     left(coalesce(uc.proton_version, ''), 15)) = fr.report_key
      )
  )
  select
    (count(*) + (select n from orphan_flags))::bigint                                    as total,
    (count(*) filter (where is_flagged) + (select n from orphan_flags))::bigint          as flagged,
    count(*) filter (where is_hidden)::bigint                                            as hidden,
    count(*) filter (where not is_flagged and not is_hidden and is_approved)::bigint     as approved,
    count(*) filter (where not is_flagged and not is_hidden and not is_approved)::bigint as pending
  from base;
end;
$$;

grant execute on function public.get_report_status_counts() to authenticated;

-- Orphan-flag list function. Returns rows shaped like fetchAllReports result
-- but synthesised from flagged_reports. Admin can review + dismiss without a
-- matching user_configs row ever existing.
create or replace function public.get_orphan_flag_reports(p_app_id text default null)
returns table (
  id                    bigint,
  app_id                text,
  source                text,
  status                text,
  reason_category       text,
  reason_text           text,
  reporter_client_id    text,
  report_key            text,
  flagged_at            timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    fr.id, fr.app_id, fr.source, fr.status, fr.reason_category, fr.reason_text,
    fr.reporter_client_id, fr.report_key, fr.flagged_at
  from flagged_reports fr
  where lower(coalesce(fr.source, '')) <> 'protondb'
    and coalesce(fr.status, 'open') = 'open'
    and (p_app_id is null or fr.app_id = p_app_id)
    and not exists (
      select 1 from user_configs uc
      where uc.app_id = fr.app_id
        and format('%s:%s:%s',
                   floor(extract(epoch from uc.created_at))::bigint::text,
                   left(coalesce(uc.gpu, ''), 20),
                   left(coalesce(uc.proton_version, ''), 15)) = fr.report_key
    )
    -- admin permission gate: same as the counts RPC. Non-admins get 0 rows.
    and public.current_user_has_permission('view_analytics')
  order by fr.flagged_at desc;
$$;

grant execute on function public.get_orphan_flag_reports(text) to authenticated;
