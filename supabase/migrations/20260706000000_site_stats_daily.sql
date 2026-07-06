-- site_stats_daily: pre-aggregated daily snapshots so stats pages render
-- time-series without re-scanning user_configs on every page load. Phase D
-- of the analytics overhaul (issue #208, umbrella #204).
--
-- One row per (snapshot_date, store, tier, hardware_bucket). Callers sum
-- across whichever dimension they want; the composite PK keeps upserts cheap.
-- Rows are additive and never mutated after write, so a simple UNION over a
-- date range yields the full time series.

create table if not exists public.site_stats_daily (
  snapshot_date          date not null,
  store                  text not null,
  tier                   text not null,
  hardware_bucket        text not null,
  report_count           integer not null default 0,
  verified_owner_count   integer not null default 0,
  avg_playtime_minutes   numeric(10,2),
  created_at             timestamptz not null default now(),
  primary key (snapshot_date, store, tier, hardware_bucket)
);

create index if not exists idx_site_stats_daily_date
  on public.site_stats_daily (snapshot_date desc);
create index if not exists idx_site_stats_daily_store_date
  on public.site_stats_daily (store, snapshot_date desc);

alter table public.site_stats_daily enable row level security;

-- Public data. Anyone can read the aggregates; writes are service-role only.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'site_stats_daily' and policyname = 'anyone can read site_stats_daily'
  ) then
    create policy "anyone can read site_stats_daily"
      on public.site_stats_daily for select
      to anon, authenticated
      using (true);
  end if;
end $$;

-- Snapshot function: buckets user_configs rows whose created_at falls on
-- target_date and upserts one row per (store, tier, hardware) combination.
-- SECURITY DEFINER so pg_cron / the scheduled edge function can call it
-- without a service-role key round trip.
create or replace function public.run_site_stats_daily_snapshot(target_date date default (current_date - 1))
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  row_count integer;
begin
  insert into public.site_stats_daily
    (snapshot_date, store, tier, hardware_bucket,
     report_count, verified_owner_count, avg_playtime_minutes)
  select
    target_date,
    coalesce(app_type, 'nonsteam'),
    coalesce(nullif(rating, ''), 'pending'),
    coalesce(nullif(gpu_architecture, ''), 'unknown'),
    count(*),
    sum(case when owner_verified then 1 else 0 end),
    avg(duration_minutes) filter (where duration_minutes is not null)
  from public.user_configs
  where created_at::date = target_date
    and is_hidden = false
  group by 1, 2, 3, 4
  on conflict (snapshot_date, store, tier, hardware_bucket) do update set
    report_count         = excluded.report_count,
    verified_owner_count = excluded.verified_owner_count,
    avg_playtime_minutes = excluded.avg_playtime_minutes;

  get diagnostics row_count = row_count;
  return row_count;
end;
$$;

comment on function public.run_site_stats_daily_snapshot(date) is
  'Aggregates user_configs into site_stats_daily for the given date (defaults to yesterday). Re-runnable: uses ON CONFLICT so late-arriving reports refresh the row.';

revoke all on function public.run_site_stats_daily_snapshot(date) from public;
grant execute on function public.run_site_stats_daily_snapshot(date) to service_role;

-- pg_cron schedule (best-effort: enable extension if permitted, register a
-- daily job at 07:00 UTC covering yesterday's rows). If pg_cron is unavailable
-- on this project the schedule silently no-ops; ops can run
-- run_site_stats_daily_snapshot() manually from a service-role client.
do $$ begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then null;
  end;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('site_stats_daily_snapshot')
    where exists (select 1 from cron.job where jobname = 'site_stats_daily_snapshot');

    perform cron.schedule(
      'site_stats_daily_snapshot',
      '0 7 * * *',
      $cron$ select public.run_site_stats_daily_snapshot(); $cron$
    );
  end if;
end $$;
