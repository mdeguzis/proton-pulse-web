-- Per-user preferences, synced across devices for signed-in users (#170).
--
-- A single jsonb bag keyed by the auth user id, so future prefs (theme, sort
-- defaults, card layout, ...) reuse the same table without a schema change.
-- Signed-out users keep using localStorage; this only covers signed-in sync.
-- RLS: a user can read and write only their own row.

create table if not exists public.user_preferences (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

drop policy if exists "user_preferences_select_own" on public.user_preferences;
create policy "user_preferences_select_own"
  on public.user_preferences for select
  using (auth.uid() = user_id);

drop policy if exists "user_preferences_insert_own" on public.user_preferences;
create policy "user_preferences_insert_own"
  on public.user_preferences for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_preferences_update_own" on public.user_preferences;
create policy "user_preferences_update_own"
  on public.user_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update on public.user_preferences to authenticated;
