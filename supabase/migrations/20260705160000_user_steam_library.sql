-- Cache of a signed-in user's Steam library, refreshed on demand (#199).
--
-- Powers the profile Library section (count + refresh), the "In your library"
-- pill on game pages, and the home-page library-rating bar chart. Refreshed
-- via the sync-steam-library edge function which calls Steam's
-- IPlayerService/GetOwnedGames. RLS: user reads/writes only their own row.

create table if not exists public.user_steam_library (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  steam_id   text not null,
  game_count integer not null default 0,
  appids     jsonb not null default '[]'::jsonb,
  synced_at  timestamptz not null default now()
);

create index if not exists user_steam_library_steam_id_idx
  on public.user_steam_library (steam_id);

alter table public.user_steam_library enable row level security;

drop policy if exists "user_steam_library_select_own" on public.user_steam_library;
create policy "user_steam_library_select_own"
  on public.user_steam_library for select
  using (auth.uid() = user_id);

drop policy if exists "user_steam_library_insert_own" on public.user_steam_library;
create policy "user_steam_library_insert_own"
  on public.user_steam_library for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_steam_library_update_own" on public.user_steam_library;
create policy "user_steam_library_update_own"
  on public.user_steam_library for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update on public.user_steam_library to authenticated;
