-- Exact per-status report counts for the admin Reports panel.
--
-- Replaces the frontend's clean-minus-approvals approximation (which drifts
-- when a previously-approved report is later flagged/hidden). Does the join in
-- one query. SECURITY DEFINER so it counts across RLS; guarded to admins with
-- the view_analytics permission (the Reports tab's permission).

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
  )
  select
    count(*)::bigint                                                                     as total,
    count(*) filter (where is_flagged)::bigint                                           as flagged,
    count(*) filter (where is_hidden)::bigint                                            as hidden,
    count(*) filter (where not is_flagged and not is_hidden and is_approved)::bigint     as approved,
    count(*) filter (where not is_flagged and not is_hidden and not is_approved)::bigint as pending
  from base;
end;
$$;

grant execute on function public.get_report_status_counts() to authenticated;
