create table public.site_events (
  id                    bigint generated always as identity primary key,
  event_type            text not null,
  page                  text,
  session_id            text,
  proton_pulse_user_id  uuid,
  client_id             text,
  metadata              jsonb,
  created_at            timestamptz not null default now()
);

create index site_events_created_at_idx
  on public.site_events (created_at desc);

create index site_events_event_type_created_at_idx
  on public.site_events (event_type, created_at desc);

create index site_events_user_created_at_idx
  on public.site_events (proton_pulse_user_id, created_at desc);

alter table public.site_events enable row level security;

create policy "anyone can insert site_events"
  on public.site_events for insert
  with check (true);

create policy "admins can select site_events"
  on public.site_events for select
  using (
    exists (
      select 1 from public.admins
      where proton_pulse_user_id = auth.uid()
    )
  );

create or replace function public.admin_analytics(days_back int default 30)
returns json
language plpgsql
security definer
as $$
declare
  v_is_admin boolean;
  v_daily json;
  v_top_pages json;
  v_event_types json;
  v_totals json;
begin
  select exists (
    select 1 from public.admins where proton_pulse_user_id = auth.uid()
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'Not authorized';
  end if;

  select json_agg(r order by r.day)
  into v_daily
  from (
    select
      date_trunc('day', created_at)::date as day,
      count(*)                            as events,
      count(distinct session_id)          as sessions
    from public.site_events
    where created_at >= now() - (days_back || ' days')::interval
    group by 1
  ) r;

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

  select json_agg(r order by r.total desc)
  into v_event_types
  from (
    select event_type, count(*) as total
    from public.site_events
    where created_at >= now() - (days_back || ' days')::interval
    group by event_type
  ) r;

  select json_build_object(
    'total_events',    count(*),
    'total_sessions',  count(distinct session_id),
    'authed_users',    count(distinct proton_pulse_user_id) filter (where proton_pulse_user_id is not null),
    'auth_success',    count(*) filter (where event_type = 'auth_success'),
    'auth_failure',    count(*) filter (where event_type = 'auth_failure')
  )
  into v_totals
  from public.site_events
  where created_at >= now() - (days_back || ' days')::interval;

  return json_build_object(
    'daily',        coalesce(v_daily, '[]'::json),
    'top_pages',    coalesce(v_top_pages, '[]'::json),
    'event_types',  coalesce(v_event_types, '[]'::json),
    'totals',       v_totals
  );
end;
$$;
