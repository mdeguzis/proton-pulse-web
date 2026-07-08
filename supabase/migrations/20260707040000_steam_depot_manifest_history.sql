-- Observation history for Steam depot manifests. Phase 2 of the plan
-- documented in proton-pulse-web-wiki/Steam-Depot-Data.md (issue #226).
--
-- Motivation: PICS gives us ONE branch-level `timeupdated` shared by every
-- OS depot on the branch, so per-OS 'First seen' and 'Last update' cannot
-- come from a single-value schema. Real per-OS answers require observing
-- how manifest_id changes over time and taking min / max of the
-- first_observed_at column.
--
-- Model:
--   - Row per unique (app_id, depot_id, os, manifest_id).
--   - When the pipeline sees a manifest_id we've never recorded for that
--     (app, depot, os) combo, INSERT (first_observed_at = now()).
--   - When we see the same manifest_id again, UPDATE latest_observed_at.
--   - When a game ships a new build the manifest_id changes for the
--     affected depots -> a fresh row is inserted; the previous row stays
--     forever (its latest_observed_at just stops advancing).
--
-- Aggregates the read-side edge function computes:
--   - per-OS First seen  = MIN(first_observed_at) over all rows for
--     (app_id, os). This is our observation floor -- for games whose
--     depots existed before we started tracking, this reads as
--     "tracked since <date>" rather than the true creation date.
--   - per-OS Last update = MAX(first_observed_at). A new max means a
--     new manifest_id was observed, i.e. a build for that OS shipped.
--
-- GDPR note: table holds only public Steam depot metadata (app id,
-- depot id, OS name string, manifest gid, observation timestamps). No
-- user identifier of any kind. admin_erase_user coverage is NOT required.

create table if not exists public.steam_depot_manifest_history (
  app_id              bigint      not null,
  depot_id            bigint      not null,
  os                  text        not null,
  manifest_id         text        not null,
  first_observed_at   timestamptz not null default now(),
  latest_observed_at  timestamptz not null default now(),
  primary key (app_id, depot_id, os, manifest_id)
);

comment on table  public.steam_depot_manifest_history is
  'Observational history of Steam depot manifests per (app, depot, os). Populated by scripts/pipeline/steam_metadata.py; read by supabase/functions/steam-depot-info. #226.';
comment on column public.steam_depot_manifest_history.first_observed_at is
  'When the pipeline first saw this manifest_id for the (app, depot, os) tuple. Our observation floor -- not a true creation date.';
comment on column public.steam_depot_manifest_history.latest_observed_at is
  'When the pipeline last saw this manifest_id still active for the (app, depot, os). Advances on every re-observation of the same gid; a new gid means a new row.';

-- Read hot paths: per-app aggregation and per-(app, os) filters.
create index if not exists idx_steam_depot_manifest_history_app_os
  on public.steam_depot_manifest_history (app_id, os);
create index if not exists idx_steam_depot_manifest_history_first_observed
  on public.steam_depot_manifest_history (first_observed_at desc);

alter table public.steam_depot_manifest_history enable row level security;

-- Public read (same as steam_depot_updates -- this is objective Steam data).
-- Writes flow through the pipeline runner using the service role.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename  = 'steam_depot_manifest_history'
      and policyname = 'anyone can read steam_depot_manifest_history'
  ) then
    create policy "anyone can read steam_depot_manifest_history"
      on public.steam_depot_manifest_history for select
      to anon, authenticated
      using (true);
  end if;
end $$;
