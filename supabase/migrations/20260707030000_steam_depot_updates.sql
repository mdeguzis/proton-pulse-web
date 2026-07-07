-- steam_depot_updates: cache of per-depot "last updated" timestamps parsed
-- from `steamcmd +app_info_print` output (issue #215). Steam does not
-- publish this via the public store API; the pipeline reaches PICS via
-- steamcmd anonymous, parses the KeyValues dump, and upserts here.
-- Readers (Metadata modal via edge function) aggregate rows to a per-OS
-- { first_seen, last_updated } pair.

create table if not exists public.steam_depot_updates (
  app_id         bigint  not null,
  depot_id       bigint  not null,
  os             text    not null,  -- 'windows' | 'mac' | 'linux' | 'other'
  name           text,               -- optional depot name from PICS
  manifest_id    text,               -- newest public manifest id when observed
  last_updated_at timestamptz not null,
  fetched_at     timestamptz not null default now(),
  primary key (app_id, depot_id, os)
);

-- Per-app fetch tracker so the runner can skip apps that were checked
-- recently and pace itself against Steam's client rate limits. One row
-- per app_id; app_status carries 'ok' / 'no_public_manifest' / 'error'
-- so we do not re-hammer apps steamcmd could not resolve.
create table if not exists public.steam_depot_fetch_status (
  app_id      bigint primary key,
  fetched_at  timestamptz not null default now(),
  app_status  text        not null,
  depot_count integer     not null default 0,
  error       text
);

create index if not exists idx_steam_depot_updates_app_os
  on public.steam_depot_updates (app_id, os);
create index if not exists idx_steam_depot_updates_last_updated
  on public.steam_depot_updates (last_updated_at desc);

alter table public.steam_depot_updates       enable row level security;
alter table public.steam_depot_fetch_status  enable row level security;

-- Public read: anyone can see depot dates. Writes go through the service
-- role from the pipeline runner + the read-side edge function.
do $$ begin
  if not exists (select 1 from pg_policies
    where tablename = 'steam_depot_updates' and policyname = 'anyone can read steam_depot_updates') then
    create policy "anyone can read steam_depot_updates"
      on public.steam_depot_updates for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies
    where tablename = 'steam_depot_fetch_status' and policyname = 'anyone can read steam_depot_fetch_status') then
    create policy "anyone can read steam_depot_fetch_status"
      on public.steam_depot_fetch_status for select to anon, authenticated using (true);
  end if;
end $$;
