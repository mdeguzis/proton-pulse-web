-- Cache Steam avatar URLs for authenticated Pulse authors.
-- Populated lazily by the webui when it encounters a proton_pulse_user_id
-- whose avatar isn't cached yet. The Steam Web API GetPlayerSummaries
-- endpoint is public (no key needed for basic profile info), so the
-- client can fetch it directly and cache the result here.
--
-- TTL: rows older than 7 days get refreshed on next access. The webui
-- checks cached_at and re-fetches if stale.

create table if not exists public.author_avatars (
  proton_pulse_user_id uuid primary key references auth.users(id) on delete cascade,
  steam_id text not null,
  avatar_url text not null default '',
  display_name text not null default '',
  cached_at timestamptz not null default now()
);

-- anyone can read avatars (they're public Steam profile info)
alter table public.author_avatars enable row level security;

create policy "public read avatars"
  on public.author_avatars for select
  to anon, authenticated
  using (true);

-- only the owning user can upsert their own avatar row
create policy "users update own avatar"
  on public.author_avatars for insert
  to authenticated
  with check (proton_pulse_user_id = auth.uid());

create policy "users refresh own avatar"
  on public.author_avatars for update
  to authenticated
  using (proton_pulse_user_id = auth.uid())
  with check (proton_pulse_user_id = auth.uid());

-- RPC to bulk-fetch avatars for a list of user IDs (used by the game page
-- to resolve all report authors in one call instead of N+1 queries)
create or replace function public.get_author_avatars(p_user_ids uuid[])
returns json
language sql
stable
security definer
as $$
  select coalesce(
    json_agg(json_build_object(
      'proton_pulse_user_id', proton_pulse_user_id,
      'steam_id', steam_id,
      'avatar_url', avatar_url,
      'display_name', display_name,
      'cached_at', cached_at
    )),
    '[]'::json
  )
  from public.author_avatars
  where proton_pulse_user_id = any(p_user_ids);
$$;

grant execute on function public.get_author_avatars(uuid[]) to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select, insert, update on table public.author_avatars to authenticated;
grant select on table public.author_avatars to anon;
