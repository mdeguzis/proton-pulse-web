-- Per-author aggregate stats: report count + total hours across all games.
-- Called from the webui author block to show "N reports, X hours" under the
-- avatar. Works for both client_id (anonymous) and proton_pulse_user_id
-- (linked account). Anonymous ProtonDB reports can't be aggregated since
-- they don't carry a stable author identifier.

-- look up by client_id (anonymous plugin/web users)
create or replace function public.author_stats_by_client(p_client_id text)
returns json
language sql
stable
security definer
as $$
  select coalesce(
    (select json_build_object(
      'report_count', count(*)::int,
      'total_hours', coalesce(sum(
        case duration
          when 'underOneHour' then 0.5
          when 'oneToFourHours' then 2.5
          when 'fourToTenHours' then 7
          when 'overTenHours' then 15
          when 'unreported' then 0
          else coalesce(duration_minutes::numeric / 60, 0)
        end
      ), 0)::numeric(10,1),
      'games', count(distinct app_id)::int
    )
    from public.user_configs
    where client_id = p_client_id),
    '{"report_count":0,"total_hours":0,"games":0}'::json
  );
$$;

-- look up by proton_pulse_user_id (linked accounts)
create or replace function public.author_stats_by_user(p_user_id uuid)
returns json
language sql
stable
security definer
as $$
  select coalesce(
    (select json_build_object(
      'report_count', count(*)::int,
      'total_hours', coalesce(sum(
        case duration
          when 'underOneHour' then 0.5
          when 'oneToFourHours' then 2.5
          when 'fourToTenHours' then 7
          when 'overTenHours' then 15
          when 'unreported' then 0
          else coalesce(duration_minutes::numeric / 60, 0)
        end
      ), 0)::numeric(10,1),
      'games', count(distinct app_id)::int
    )
    from public.user_configs
    where proton_pulse_user_id = p_user_id),
    '{"report_count":0,"total_hours":0,"games":0}'::json
  );
$$;

-- grant execute to anon + authenticated so the webui can call these
grant execute on function public.author_stats_by_client(text) to anon, authenticated;
grant execute on function public.author_stats_by_user(uuid) to anon, authenticated;
