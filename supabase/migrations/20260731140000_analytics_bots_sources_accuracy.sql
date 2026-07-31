-- #436: analytics accuracy + bot / traffic-source identification.
--
-- Three problems this fixes in admin_analytics:
--   1. Staging polluted prod. Staging and prod share one Supabase project
--      (#264). The old GitHub Pages staging carried a /proton-pulse-web-staging
--      path prefix; the Cloudflare Pages staging (staging.proton-pulse.com)
--      serves clean paths but tags metadata.host. Both are now excluded.
--      Legacy prod rows predate the host tag and have a null host, so they are
--      kept.
--   2. Top Pages fragmented the same page. / , /index.html and /app vs
--      /app.html were counted as separate rows. norm_page collapses them.
--   3. No bot / source visibility. The tracker now tags metadata.bot and, on
--      page_view, metadata.referrer + metadata.utm. This adds a human vs bot
--      split to the totals plus top_referrers and top_sources tables.
--
-- The function builds one filtered + normalized temp set first so every
-- aggregate reads the same rows instead of repeating the where clause.

create or replace function public.admin_analytics(days_back int default 30)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_daily json;
  v_top_pages json;
  v_top_games json;
  v_event_types json;
  v_top_referrers json;
  v_top_sources json;
  v_totals json;
begin
  select exists (
    select 1 from public.admins where proton_pulse_user_id = auth.uid()
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'Not authorized';
  end if;

  drop table if exists _ev;
  create temp table _ev on commit drop as
  select
    e.event_type,
    e.session_id,
    e.proton_pulse_user_id,
    e.client_id,
    e.created_at,
    e.metadata,
    (e.metadata->>'bot') = 'true'           as is_bot,
    nullif(e.metadata->>'referrer', '')     as ref,
    nullif(e.metadata#>>'{utm,source}', '') as utm_source,
    -- Collapse the staging prefix, the .html suffix and a trailing /index so
    -- every spelling of a page maps to one canonical path. Empty -> '/'.
    coalesce(
      nullif(
        regexp_replace(
          regexp_replace(
            regexp_replace(e.page, '^/proton-pulse-web-staging', ''),
            '\.html$', ''
          ),
          '/index$', '/'
        ),
        ''
      ),
      '/'
    ) as norm_page
  from public.site_events e
  where e.created_at >= now() - (days_back || ' days')::interval
    and e.page not like '/proton-pulse-web-staging/%'
    and coalesce(e.metadata->>'host', '') <> 'staging.proton-pulse.com';

  -- Daily breakdown. bot_visitors is the distinct-visitor count restricted to
  -- rows the tracker flagged as automated, so the chart can show the human vs
  -- bot split over time.
  select json_agg(r order by r.day)
  into v_daily
  from (
    select
      date_trunc('day', created_at)::date as day,
      count(*)                            as events,
      count(distinct session_id)          as sessions,
      count(distinct coalesce(proton_pulse_user_id::text, client_id))
        filter (where proton_pulse_user_id is not null or client_id is not null)
                                          as unique_visitors,
      count(distinct proton_pulse_user_id)
        filter (where proton_pulse_user_id is not null) as unique_users,
      count(distinct coalesce(proton_pulse_user_id::text, client_id))
        filter (where (proton_pulse_user_id is not null or client_id is not null) and is_bot)
                                          as bot_visitors
    from _ev
    group by 1
  ) r;

  select json_agg(r order by r.views desc)
  into v_top_pages
  from (
    select norm_page as page, count(*) as views
    from _ev
    where event_type = 'page_view'
    group by norm_page
    order by views desc
    limit 10
  ) r;

  select json_agg(r order by r.views desc)
  into v_top_games
  from (
    select
      metadata->>'app_id' as app_id,
      metadata->>'title'  as title,
      count(*)            as views
    from _ev
    where event_type = 'game_view'
      and metadata->>'app_id' is not null
    group by metadata->>'app_id', metadata->>'title'
    order by views desc
    limit 10
  ) r;

  select json_agg(r order by r.total desc)
  into v_event_types
  from (
    select event_type, count(*) as total
    from _ev
    group by event_type
  ) r;

  -- #436: external referring hosts on page_views (google.com, protondb.com...).
  select json_agg(r order by r.visits desc)
  into v_top_referrers
  from (
    select ref as referrer, count(*) as visits
    from _ev
    where event_type = 'page_view' and ref is not null
    group by ref
    order by visits desc
    limit 10
  ) r;

  -- #436: utm_source campaign tags.
  select json_agg(r order by r.visits desc)
  into v_top_sources
  from (
    select utm_source as source, count(*) as visits
    from _ev
    where event_type = 'page_view' and utm_source is not null
    group by utm_source
    order by visits desc
    limit 10
  ) r;

  select json_build_object(
    'total_events',      count(*),
    'total_sessions',    count(distinct session_id),
    'unique_visitors',   count(distinct coalesce(proton_pulse_user_id::text, client_id))
                           filter (where proton_pulse_user_id is not null or client_id is not null),
    'human_visitors',    count(distinct coalesce(proton_pulse_user_id::text, client_id))
                           filter (where (proton_pulse_user_id is not null or client_id is not null) and not is_bot),
    'bot_visitors',      count(distinct coalesce(proton_pulse_user_id::text, client_id))
                           filter (where (proton_pulse_user_id is not null or client_id is not null) and is_bot),
    'bot_events',        count(*) filter (where is_bot),
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
  from _ev;

  return json_build_object(
    'daily',         coalesce(v_daily, '[]'::json),
    'top_pages',     coalesce(v_top_pages, '[]'::json),
    'top_games',     coalesce(v_top_games, '[]'::json),
    'event_types',   coalesce(v_event_types, '[]'::json),
    'top_referrers', coalesce(v_top_referrers, '[]'::json),
    'top_sources',   coalesce(v_top_sources, '[]'::json),
    'totals',        v_totals
  );
end;
$$;

-- Preserve the security posture from #292 era: admins call this through the
-- authenticated role only, never anon.
revoke all on function public.admin_analytics(int) from anon;
grant execute on function public.admin_analytics(int) to authenticated;
