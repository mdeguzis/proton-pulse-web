create or replace function public.admin_analytics(days_back int default 30)
returns json
language plpgsql
security definer
as $$
declare
  v_is_admin boolean;
  v_daily json;
  v_top_pages json;
  v_top_games json;
  v_event_types json;
  v_totals json;
begin
  select exists (
    select 1 from public.admins where proton_pulse_user_id = auth.uid()
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'Not authorized';
  end if;

  -- Daily breakdown: events, sessions, unique authenticated users
  select json_agg(r order by r.day)
  into v_daily
  from (
    select
      date_trunc('day', created_at)::date as day,
      count(*)                            as events,
      count(distinct session_id)          as sessions,
      count(distinct proton_pulse_user_id)
        filter (where proton_pulse_user_id is not null) as unique_users
    from public.site_events
    where created_at >= now() - (days_back || ' days')::interval
    group by 1
  ) r;

  -- Top pages by page_view count
  select json_agg(r order by r.views desc)
  into v_top_pages
  from (
    select page, count(*) as views
    from public.site_events
    where event_type = 'page_view'
      and created_at >= now() - (days_back || ' days')::interval
    group by page
    order by views desc
    limit 10
  ) r;

  -- Top games by game_view event (metadata->>'app_id')
  select json_agg(r order by r.views desc)
  into v_top_games
  from (
    select
      metadata->>'app_id'   as app_id,
      metadata->>'title'    as title,
      count(*)              as views
    from public.site_events
    where event_type = 'game_view'
      and metadata->>'app_id' is not null
      and created_at >= now() - (days_back || ' days')::interval
    group by metadata->>'app_id', metadata->>'title'
    order by views desc
    limit 10
  ) r;

  -- Event type breakdown
  select json_agg(r order by r.total desc)
  into v_event_types
  from (
    select event_type, count(*) as total
    from public.site_events
    where created_at >= now() - (days_back || ' days')::interval
    group by event_type
  ) r;

  -- Summary totals including new users and reports submitted
  select json_build_object(
    'total_events',      count(*),
    'total_sessions',    count(distinct session_id),
    'authed_users',      count(distinct proton_pulse_user_id)
                           filter (where proton_pulse_user_id is not null),
    'auth_success',      count(*) filter (where event_type = 'auth_success'),
    'auth_failure',      count(*) filter (where event_type = 'auth_failure'),
    'reports_submitted', count(*) filter (where event_type = 'report_submit'),
    'new_users', (
      select count(distinct e2.proton_pulse_user_id)
      from public.site_events e2
      where e2.proton_pulse_user_id is not null
        and e2.created_at >= now() - (days_back || ' days')::interval
        and not exists (
          select 1 from public.site_events e3
          where e3.proton_pulse_user_id = e2.proton_pulse_user_id
            and e3.created_at < now() - (days_back || ' days')::interval
        )
    )
  )
  into v_totals
  from public.site_events
  where created_at >= now() - (days_back || ' days')::interval;

  return json_build_object(
    'daily',       coalesce(v_daily, '[]'::json),
    'top_pages',   coalesce(v_top_pages, '[]'::json),
    'top_games',   coalesce(v_top_games, '[]'::json),
    'event_types', coalesce(v_event_types, '[]'::json),
    'totals',      v_totals
  );
end;
$$;
